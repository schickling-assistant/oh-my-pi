import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthAccountPolicies, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { OAuthRefresher } from "../src/auth/refresh";
import { parseCodexRateLimitHeaders } from "../src/usage/openai-codex";

// Running sessions with a warm automatic pin and `reclaimAbovePct` on the
// preferred account. The clock advances in short steps so Anthropic pins stay
// warm (idle < 1 h); without reclaim they would stay on the backup.

const MIN = 60_000;
const HOUR = 60 * MIN;
const WEEK = 7 * 24 * HOUR;

type Provider = "anthropic" | "openai-codex";

function limit(provider: Provider, windowId: "5h" | "7d", used: number, resetsAt: number): UsageLimit {
	return {
		// Codex's strategy finds its windows by the `primary`/`secondary` id suffix.
		id: `${provider}:${provider === "openai-codex" ? (windowId === "5h" ? "primary" : "secondary") : windowId}`,
		label: windowId,
		scope: { provider, windowId, shared: true },
		window: { id: windowId, label: windowId, durationMs: windowId === "5h" ? 5 * HOUR : WEEK, resetsAt },
		amount: {
			unit: "percent",
			used: used * 100,
			limit: 100,
			remaining: 100 - used * 100,
			usedFraction: used,
			remainingFraction: 1 - used,
		},
		status: used >= 1 ? "exhausted" : used >= 0.9 ? "warning" : "ok",
	};
}

let tempDir = "";
let store: SqliteAuthCredentialStore | null = null;
const usage = new Map<string, UsageReport>();
const base = Date.now();
let clock = 0;

/** Report for `accountId` with its 5h window at `fiveUsed` and weekly window at `weekUsed`. */
function setUsage(provider: Provider, accountId: string, fiveUsed: number, weekUsed: number): void {
	const exhausted = fiveUsed >= 1 || weekUsed >= 1;
	usage.set(accountId, {
		provider,
		fetchedAt: Date.now(),
		limits: [
			limit(provider, "5h", fiveUsed, Date.now() + 3 * HOUR),
			limit(provider, "7d", weekUsed, Date.now() + 5 * 24 * HOUR),
		],
		metadata: {
			accountId,
			...(provider === "openai-codex" ? { allowed: !exhausted, limitReached: exhausted } : {}),
		},
	});
}

async function setup(provider: Provider, policies: AuthAccountPolicies, accounts: string[]): Promise<AuthStorage> {
	if (!store) throw new Error("test setup failed");
	const usageProvider: UsageProvider = {
		id: provider,
		parseRateLimitHeaders: provider === "openai-codex" ? parseCodexRateLimitHeaders : undefined,
		async fetchUsage(params) {
			const id = params.credential.accountId;
			return id ? (usage.get(id) ?? null) : null;
		},
	};
	const auth = new AuthStorage(store, {
		usageProviderResolver: p => (p === provider ? usageProvider : undefined),
		accountPolicies: policies,
	});
	await auth.credentials.set(
		provider,
		accounts.map(accountId => {
			const credential: OAuthCredentials = {
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + WEEK,
				accountId,
				email: `${accountId}@example.com`,
			};
			return { type: "oauth" as const, ...credential };
		}),
	);
	return auth;
}

async function next(auth: AuthStorage, provider: Provider, session: string): Promise<string | undefined> {
	return (await auth.keys.get(provider, session))?.replace(/^api-/, "");
}

async function advance(auth: AuthStorage, provider: Provider, ms: number): Promise<void> {
	clock += ms;
	await auth.usage.invalidate(provider);
}

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-account-reclaim-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	usage.clear();
	clock = 0;
	vi.spyOn(Date, "now").mockImplementation(() => base + clock);
	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, all) => {
		const credential = all[provider] as OAuthCredentials | undefined;
		return credential?.accountId ? { apiKey: `api-${credential.accountId}`, newCredentials: credential } : null;
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	store?.close();
	store = null;
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("accountPolicies reclaimAbovePct", () => {
	const A = "anthropic" as const;
	const policies = (reclaim: { reclaimAbovePct?: number } = { reclaimAbovePct: 40 }): AuthAccountPolicies => [
		{ provider: A, account: { accountId: "a" }, priority: 10, reservePct: 15, ...reclaim },
		{ provider: A, account: { accountId: "b" }, priority: 5 },
	];

	/** Session S1 starts on A, is pushed onto B by A's reserve, then A's 5h window resets to `aWeekUsed` weekly. */
	async function pushOntoBackupThenRecover(auth: AuthStorage, aWeekUsed: number): Promise<void> {
		setUsage(A, "a", 0.3, 0.5);
		setUsage(A, "b", 0.1, 0.1);
		expect(await next(auth, A, "S1")).toBe("a");
		await advance(auth, A, 10 * MIN);
		setUsage(A, "a", 0.9, 0.5);
		expect(await next(auth, A, "S1")).toBe("b");
		await advance(auth, A, 10 * MIN);
		setUsage(A, "a", 0, aWeekUsed);
		setUsage(A, "b", 0.2, 0.15);
	}

	test("returns a running session to the preferred account once it is above reclaimAbovePct", async () => {
		const auth = await setup(A, policies(), ["a", "b"]);
		await pushOntoBackupThenRecover(auth, 0.45);
		expect(await next(auth, A, "S1")).toBe("a");
	});

	test("without reclaimAbovePct the warm session stays on the backup", async () => {
		const auth = await setup(A, policies({}), ["a", "b"]);
		await pushOntoBackupThenRecover(auth, 0.45);
		expect(await next(auth, A, "S1")).toBe("b");
	});

	test("stays on the backup while the preferred account is between its reserve and reclaimAbovePct", async () => {
		const auth = await setup(A, policies(), ["a", "b"]);
		await pushOntoBackupThenRecover(auth, 0.7);
		// A: 30% left, outside its 15% reserve but below the 40% reclaim line.
		expect(await next(auth, A, "S1")).toBe("b");
		await advance(auth, A, 10 * MIN);
		setUsage(A, "a", 0.1, 0.7);
		expect(await next(auth, A, "S1")).toBe("b");
	});

	test("moves once each way per recovery: no oscillation inside the band", async () => {
		const auth = await setup(A, policies(), ["a", "b"]);
		await pushOntoBackupThenRecover(auth, 0.55);
		expect(await next(auth, A, "S1")).toBe("a");
		// A drains back into its reserve: leave once.
		await advance(auth, A, 10 * MIN);
		setUsage(A, "a", 0.9, 0.55);
		expect(await next(auth, A, "S1")).toBe("b");
		// A's 5h window resets but its weekly window leaves only 20%: above reserve, below reclaim.
		await advance(auth, A, 10 * MIN);
		setUsage(A, "a", 0, 0.8);
		for (let step = 0; step < 3; step += 1) {
			expect(await next(auth, A, "S1")).toBe("b");
			await advance(auth, A, 10 * MIN);
		}
	});

	test("never moves an explicit pin", async () => {
		const auth = await setup(A, policies(), ["a", "b"]);
		setUsage(A, "a", 0, 0.1);
		setUsage(A, "b", 0.1, 0.1);
		const backup = auth.oauth.accounts(A).find(account => account.accountId === "b");
		if (!backup) throw new Error("expected backup account");
		expect(auth.sessions.pin(A, "S1", backup.credentialId)).toBe(true);
		expect(await next(auth, A, "S1")).toBe("b");
		await advance(auth, A, 10 * MIN);
		expect(await next(auth, A, "S1")).toBe("b");
	});

	test("does not reclaim for an equal-priority account", async () => {
		const auth = await setup(
			A,
			[
				{ provider: A, account: { accountId: "a" }, priority: 10, reservePct: 15, reclaimAbovePct: 40 },
				{ provider: A, account: { accountId: "b" }, priority: 10 },
			],
			["a", "b"],
		);
		// S1 starts on B because A is inside its reserve, then A fully recovers.
		setUsage(A, "a", 0.9, 0.1);
		setUsage(A, "b", 0.1, 0.1);
		expect(await next(auth, A, "S1")).toBe("b");
		await advance(auth, A, 10 * MIN);
		setUsage(A, "a", 0, 0.1);
		expect(await next(auth, A, "S1")).toBe("b");
	});

	test("does not reclaim when the preferred account's usage is unmeasured", async () => {
		const auth = await setup(A, policies(), ["a", "b"]);
		await pushOntoBackupThenRecover(auth, 0.2);
		usage.delete("a");
		expect(await next(auth, A, "S1")).toBe("b");
	});

	test("requires a usage provider", async () => {
		if (!store) throw new Error("test setup failed");
		const auth = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			accountPolicies: [{ provider: A, account: { accountId: "a" }, reclaimAbovePct: 40 }],
		});
		await auth.credentials.set(A, [
			{ type: "oauth", access: "x", refresh: "y", expires: Date.now() + WEEK, accountId: "a" },
		]);
		await expect(auth.keys.get(A, "S1")).rejects.toThrow(
			"auth.accountPolicies[0].reclaimAbovePct requires a usage provider for anthropic",
		);
	});
	test("reclaims a Codex session whose pins never go cold", async () => {
		const C = "openai-codex" as const;
		const auth = await setup(
			C,
			[
				{ provider: C, account: { accountId: "pro" }, priority: 10, reservePct: 20, reclaimAbovePct: 50 },
				{ provider: C, account: { accountId: "team" }, priority: 5 },
			],
			["pro", "team"],
		);
		setUsage(C, "pro", 0.3, 0.5);
		setUsage(C, "team", 0.1, 0.1);
		expect(await next(auth, C, "S1")).toBe("pro");
		await advance(auth, C, 10 * MIN);
		setUsage(C, "pro", 0.3, 0.85);
		expect(await next(auth, C, "S1")).toBe("team");
		// A day later Pro's windows have reset.
		await advance(auth, C, 24 * HOUR);
		setUsage(C, "pro", 0, 0.05);
		setUsage(C, "team", 0.2, 0.3);
		expect(await next(auth, C, "S1")).toBe("pro");
	});

	test("rejects reclaimAbovePct at or below the effective reserve", async () => {
		if (!store) throw new Error("test setup failed");
		const activeStore = store;
		const build = (policy: AuthAccountPolicies[number], defaultReservePct?: number) =>
			new AuthStorage(activeStore, { accountPolicies: [policy], defaultReservePct });
		expect(() => build({ provider: A, account: { accountId: "a" }, reservePct: 30, reclaimAbovePct: 30 })).toThrow(
			"auth.accountPolicies[0].reclaimAbovePct must be a finite number above the account's reserve (30%) and at most 100",
		);
		expect(() => build({ provider: A, account: { accountId: "a" }, reclaimAbovePct: 20 }, 25)).toThrow(
			"above the account's reserve (25%)",
		);
		expect(() => build({ provider: A, account: { accountId: "a" }, reclaimAbovePct: 101 })).toThrow("at most 100");
	});

	test("reclaims at exactly reclaimAbovePct", async () => {
		const auth = await setup(A, policies(), ["a", "b"]);
		await pushOntoBackupThenRecover(auth, 0.6);
		expect(await next(auth, A, "S1")).toBe("a");
	});

	test("stays on the backup one point below reclaimAbovePct", async () => {
		const auth = await setup(A, policies(), ["a", "b"]);
		await pushOntoBackupThenRecover(auth, 0.61);
		expect(await next(auth, A, "S1")).toBe("b");
	});

	test("keeps the warm pin when ranking would hand the session to a sibling other than the reclaiming account", async () => {
		const auth = await setup(
			A,
			[
				{ provider: A, account: { accountId: "a" }, priority: 10, reservePct: 5, reclaimAbovePct: 10 },
				{ provider: A, account: { accountId: "b" }, priority: 5 },
				{ provider: A, account: { accountId: "c" }, priority: 0 },
			],
			["a", "b", "c"],
		);
		// S1 starts on B: A is inside its reserve and C's 5h window is hot.
		setUsage(A, "a", 0.97, 0.1);
		setUsage(A, "b", 0.3, 0.1);
		setUsage(A, "c", 0.95, 0.1);
		expect(await next(auth, A, "S1")).toBe("b");
		// A recovers past its reclaim line, but the hot-window guard ranks C first.
		await advance(auth, A, 10 * MIN);
		setUsage(A, "a", 0.88, 0.1);
		setUsage(A, "b", 0.86, 0.1);
		setUsage(A, "c", 0, 0.1);
		expect(await next(auth, A, "S1")).toBe("b");
	});
});

describe("accountPolicies allowCreditOverage hard eligibility", () => {
	const C = "openai-codex" as const;
	const strict = [{ provider: C, account: { accountId: "a" }, priority: 100, allowCreditOverage: false }];

	function creditAdjusted(accountId: string, primary: number, secondary: number): void {
		setUsage(C, accountId, primary, secondary);
		const report = usage.get(accountId)!;
		// Credits (or reset recovery) can make effective availability healthy without
		// changing the raw plan counters. They must never authorize strict routing.
		report.metadata = { ...report.metadata, allowed: true, limitReached: false, creditOverage: true };
		for (const window of report.limits) window.status = "warning";
	}

	test("default and explicit true preserve credit-funded exhausted-window routing", async () => {
		for (const allowCreditOverage of [undefined, true]) {
			const auth = await setup(C, [
				{ provider: C, account: { accountId: "a" }, allowCreditOverage },
			], ["a"]);
			creditAdjusted("a", 1, 0.2);
			expect(await next(auth, C, "default")).toBe("a");
		}
	});

	test("a sole exhausted account stays ineligible through allowBlocked fallback", async () => {
		const auth = await setup(C, strict, ["a"]);
		creditAdjusted("a", 1, 0.2);
		expect(await next(auth, C, "single")).toBeUndefined();
		// Exact-account access takes checkUsage=false/allowBlocked=true.
		const account = auth.oauth.accounts(C)[0]!;
		expect((await auth.oauth.accessById(C, account.credentialId))?.ok).toBe(false);
	});

	test("ranking cannot promote a high-priority exhausted account over an eligible sibling", async () => {
		const auth = await setup(C, strict, ["a", "b"]);
		creditAdjusted("a", 0.2, 1);
		setUsage(C, "b", 0.3, 0.4);
		expect(await next(auth, C, "ranked")).toBe("b");
	});

	for (const explicit of [false, true]) {
		test(`${explicit ? "explicit" : "automatic"} pins cannot retain an exhausted strict account`, async () => {
			const auth = await setup(C, strict, ["a", "b"]);
			setUsage(C, "a", 0.1, 0.2);
			setUsage(C, "b", 0.3, 0.4);
			expect(await next(auth, C, "pinned")).toBe("a");
			if (explicit) {
				const account = auth.oauth.accounts(C).find(account => account.accountId === "a")!;
				expect(auth.sessions.pin(C, "pinned", account.credentialId)).toBe(true);
			}
			creditAdjusted("a", 1, 0.2);
			await advance(auth, C, MIN);
			expect(await next(auth, C, "pinned")).toBe("b");
		});
	}

	for (const unknown of ["report", "windows", "missing-window", "counter", "nonfinite", "expired", "refreshed-expired"] as const) {
		test(`fails closed with unknown ${unknown}`, async () => {
			const auth = await setup(C, strict, ["a"]);
			setUsage(C, "a", 0.1, 0.2);
			const report = usage.get("a")!;
			if (unknown === "report") usage.delete("a");
			if (unknown === "windows") report.limits = [];
			if (unknown === "missing-window") report.limits[0]!.window = undefined;
			if (unknown === "counter") report.limits[0]!.amount = { unit: "percent" };
			if (unknown === "nonfinite") report.limits[0]!.amount.usedFraction = Number.NaN;
			if (unknown === "expired") {
				report.limits[0]!.window!.resetsAt = Date.now() - 1;
				report.fetchedAt = Date.now() - MIN;
			}
			if (unknown === "refreshed-expired") report.limits[0]!.window!.resetsAt = Date.now() - 1;
			expect(await next(auth, C, "unknown")).toBeUndefined();
		});
	}

	test("partial headers cannot make an unobserved expired weekly window current", async () => {
		const auth = await setup(C, strict, ["a"]);
		setUsage(C, "a", 0.1, 0.5);
		usage.get("a")!.limits[1]!.window!.resetsAt = Date.now() + MIN;
		expect(await next(auth, C, "partial-headers")).toBe("a");
		clock += 2 * MIN;
		expect(auth.usage.ingestHeaders(C, {
			"x-codex-primary-used-percent": "10",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": String(Math.floor((Date.now() + HOUR) / 1000)),
		}, { sessionId: "partial-headers", responseStatus: 200 })).toBe(true);
		expect(await next(auth, C, "partial-headers")).toBeUndefined();
	});

	test("reset recovery needs raw headroom in every remaining plan window", async () => {
		const auth = await setup(C, strict, ["a"]);
		creditAdjusted("a", 1, 1);
		expect(await next(auth, C, "reset")).toBeUndefined();
		// A partial saved reset clears the short window and effective denial,
		// but leaves the weekly window exhausted.
		creditAdjusted("a", 0, 1);
		await advance(auth, C, MIN);
		expect(await next(auth, C, "reset")).toBeUndefined();
		creditAdjusted("a", 0, 0.5);
		await advance(auth, C, MIN);
		expect(await next(auth, C, "reset")).toBe("a");
	});

	test("retry rotation cannot return an exhausted strict sibling", async () => {
		const auth = await setup(C, strict, ["a", "b"]);
		creditAdjusted("a", 1, 0.2);
		setUsage(C, "b", 0.3, 0.4);
		expect(await next(auth, C, "retry")).toBe("b");
		const failed = auth.oauth.accounts(C).find(account => account.accountId === "b")!;
		await auth.limits.rotate(C, "retry", {
			credentialId: failed.credentialId,
			error: { status: 429, message: "usage limit reached" },
			waitForSibling: false,
		});
		expect(await next(auth, C, "retry")).not.toBe("a");
	});

	test("requires raw plan usage without a ranking strategy or a usage provider", async () => {
		if (!store) throw new Error("test setup failed");
		const auth = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			accountPolicies: [{ provider: "unmetered", account: { accountId: "a" }, allowCreditOverage: false }],
		});
		await auth.credentials.set("unmetered", [{
			type: "oauth", access: "access-a", refresh: "refresh-a", expires: Date.now() + WEEK, accountId: "a",
		}]);
		expect(await auth.keys.get("unmetered", "unknown-provider")).toBeUndefined();
	});

	test("saved-reset credential recovery cannot authorize credit-funded access", async () => {
		const auth = await setup(C, strict, ["a"]);
		creditAdjusted("a", 1, 0.2);
		const account = auth.oauth.accounts(C)[0]!;
		const outcome = await auth.resets.redeem({
			target: { provider: C, credentialId: account.credentialId, creditId: "saved-reset" },
		});
		expect(outcome).toMatchObject({ ok: false, code: "account_unavailable" });
		expect(await next(auth, C, "after-reset")).toBeUndefined();
	});

	test("refresh cannot return a newly identified strict account using another account's usage", async () => {
		const auth = await setup(C, [
			{ provider: C, account: { accountId: "b" }, allowCreditOverage: false },
		], ["a"]);
		setUsage(C, "a", 0.1, 0.2);
		creditAdjusted("b", 1, 0.2);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, all) => {
			const credential = all[provider] as OAuthCredentials | undefined;
			return credential
				? { apiKey: "api-b", newCredentials: { ...credential, accountId: "b" } }
				: null;
		});
		expect(await next(auth, C, "refresh-identity")).toBeUndefined();
	});

	test("preflight identity changes cannot reuse another account's ranked usage", async () => {
		const auth = await setup(C, [
			{ provider: C, account: { accountId: "b" }, allowCreditOverage: false },
		], ["a", "c"]);
		setUsage(C, "a", 0.1, 0.2);
		setUsage(C, "c", 0.3, 0.4);
		creditAdjusted("b", 1, 0.2);
		vi.spyOn(OAuthRefresher.prototype, "refresh").mockImplementation(async (_provider, credential) =>
			credential.accountId === "a" ? { ...credential, accountId: "b" } : credential,
		);
		expect(await auth.keys.get(C, "preflight-identity", { forceRefresh: true })).toBe("api-c");
	});
});
