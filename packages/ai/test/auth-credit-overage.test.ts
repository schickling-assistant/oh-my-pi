import { expect, test } from "bun:test";
import { hasAvailablePlanUsage } from "../src/auth/usage-report";
import type { UsageLimit, UsageReport } from "../src/usage";

const now = 1_000;
const plan: UsageLimit = {
	id: "plan", label: "Plan", scope: { provider: "openai-codex" },
	window: { id: "5h", label: "5 Hour", resetsAt: now + 1_000 },
	amount: { unit: "percent", used: 20, usedFraction: 0.2 },
};
const available = (limits: UsageLimit[]): boolean => {
	const report: UsageReport = { provider: "openai-codex", fetchedAt: now, limits };
	return hasAvailablePlanUsage(undefined, report, {}, now);
};

test("no-credit eligibility requires known, current raw plan headroom", () => {
	expect(available([plan])).toBe(true);
	expect(hasAvailablePlanUsage(undefined, null, {}, now)).toBe(false);
	expect(available([])).toBe(false);
	expect(available([{ ...plan, amount: { unit: "percent" } }])).toBe(false);
	expect(available([{ ...plan, window: undefined }])).toBe(false);
	expect(available([{ ...plan, window: { ...plan.window!, resetsAt: now } }])).toBe(false);
});

test("credit-adjusted allowed status cannot override exhausted raw plan counters", () => {
	const exhausted: UsageLimit = { ...plan, status: "allowed", amount: { unit: "percent", used: 100, usedFraction: 1 } };
	const credits: UsageLimit = { ...plan, id: "credits", amount: { unit: "credits", remaining: 1_000 } };
	expect(available([exhausted, credits])).toBe(false);
	expect(available([credits])).toBe(false);
	expect(available([plan, credits])).toBe(true);
});
