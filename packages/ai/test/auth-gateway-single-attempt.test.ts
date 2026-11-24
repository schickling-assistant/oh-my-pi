import { describe, expect, it, spyOn } from "bun:test";
import { scheduler } from "node:timers/promises";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { withEnv } from "./helpers";

function model(api: Api = "openai-codex-responses"): Model {
	return buildModel({
		id: "alias",
		name: "Alias",
		api,
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1000,
	});
}

function completed(usage = true): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "hello" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "hello" }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				...(usage ? { usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } : {}),
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function request(path = "/v1/chat/completions", stream = false, limit: string | undefined = "1"): Request {
	return new Request(`http://offline.invalid${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(limit === undefined ? {} : { "x-omp-provider-attempt-limit": limit }),
		},
		body: JSON.stringify({ model: "alias", messages: [{ role: "user", content: "hello" }], stream }),
	});
}

async function fixture(fetch: FetchImpl, api: Api = "openai-codex-responses") {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.bbb`;
	storage.keys.setRuntime("openai-codex", token);
	const keySpy = spyOn(storage.keys, "getWithCredential");
	const router = createAuthGatewayRouter({ storage, resolveModel: () => model(api), fetch });
	return {
		router,
		keySpy,
		close() {
			router.close();
			keySpy.mockRestore();
			storage.close();
		},
	};
}

describe("gateway single provider attempt profile", () => {
	for (const [path, api] of [
		["/v1/embeddings", "openai-codex-responses"],
		["/v1/chat/completions", "openai-completions"],
	] as const) {
		it(`rejects unsupported ${path}/${api} before credential resolution`, async () => {
			let sends = 0;
			const f = await fixture(async () => {
				sends++;
				return completed();
			}, api);
			try {
				const response = await f.router.route(request(path), "offline-test");
				expect(response.status).toBe(400);
				expect(await response.text()).toContain("provider_attempt_limit_unsupported_route");
				expect(response.headers.get("x-omp-provider-attempt-limit-applied")).toBe("1");
				expect(response.headers.get("x-omp-provider-attempts")).toBe("0");
				expect(sends).toBe(0);
				expect(f.keySpy).not.toHaveBeenCalled();
			} finally {
				f.close();
			}
		});
	}

	for (const stream of [false, true]) {
		it(`returns applied header on success (stream=${stream})`, async () => {
			let sends = 0;
			const f = await fixture(async (_input, init) => {
				sends++;
				expect(init?.redirect).toBe("manual");
				return completed();
			});
			try {
				const response = await f.router.route(request(undefined, stream), "offline-test");
				expect(response.status).toBe(200);
				expect(response.headers.get("x-omp-provider-attempt-limit-applied")).toBe("1");
				if (!stream) expect(response.headers.get("x-omp-provider-attempts")).toBe("1");
				expect(await response.text()).toContain("hello");
				expect(sends).toBe(1);
				expect(f.keySpy).toHaveBeenCalledTimes(1);
			} finally {
				f.close();
			}
		});
	}

	for (const status of [408, 429, 500, 503]) {
		it(`refuses retry of HTTP ${status} with distinct error and one send`, async () => {
			let sends = 0;
			const f = await fixture(async () => {
				sends++;
				return new Response("try again", { status });
			});
			try {
				const response = await f.router.route(request(), "offline-test");
				expect(response.status).toBe(409);
				expect(await response.text()).toContain("provider_attempt_limit_exceeded");
				expect(response.headers.get("x-omp-provider-attempt-limit-applied")).toBe("1");
				expect(response.headers.get("x-omp-provider-attempts")).toBe("1");
				expect(sends).toBe(1);
			} finally {
				f.close();
			}
		});
	}

	it("keeps HTTP retry behavior when the header is absent", async () => {
		await withEnv({ PI_CODEX_WEBSOCKET: "0" }, async () => {
			let sends = 0;
			const wait = spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const f = await fixture(async () => (++sends === 1 ? new Response("retry", { status: 503 }) : completed()));
			try {
				const req = request();
				req.headers.delete("x-omp-provider-attempt-limit");
				const response = await f.router.route(req, "offline-test");
				expect(response.status).toBe(200);
				expect(response.headers.has("x-omp-provider-attempt-limit-applied")).toBe(false);
				expect(sends).toBe(2);
			} finally {
				f.close();
				wait.mockRestore();
			}
		});
	});

	it("preserves the refusal code in a terminal SSE error", async () => {
		let sends = 0;
		const f = await fixture(async () => {
			sends++;
			return new Response("retry", { status: 503 });
		});
		try {
			const response = await f.router.route(request(undefined, true), "offline-test");
			expect(response.headers.get("x-omp-provider-attempt-limit-applied")).toBe("1");
			const body = await response.text();
			expect(body).toContain("provider_attempt_limit_exceeded");
			expect(body).toContain("Gateway refused a second provider attempt");
			expect(sends).toBe(1);
		} finally {
			f.close();
		}
	});

	it("uses only the first resolved credential on authentication rejection", async () => {
		let sends = 0;
		const f = await fixture(async () => {
			sends++;
			return new Response("Unauthorized", { status: 401 });
		});
		try {
			const response = await f.router.route(request(), "offline-test");
			expect(response.status).not.toBe(200);
			expect(response.headers.get("x-omp-provider-attempt-limit-applied")).toBe("1");
			expect(response.headers.get("x-omp-provider-attempts")).toBe("1");
			expect(sends).toBe(1);
			expect(f.keySpy).toHaveBeenCalledTimes(1);
		} finally {
			f.close();
		}
	});

	for (const limit of ["2", "invalid"]) {
		it(`handles limit ${limit} without raising the send ceiling`, async () => {
			let sends = 0;
			const f = await fixture(async () => {
				sends++;
				return completed();
			});
			try {
				const response = await f.router.route(request(undefined, false, limit), "offline-test");
				expect(response.status).toBe(limit === "2" ? 200 : 400);
				expect(sends).toBe(limit === "2" ? 1 : 0);
				expect(response.headers.get("x-omp-provider-attempt-limit-applied")).toBe("1");
			} finally {
				f.close();
			}
		});
	}

	it("fails on missing provider usage rather than returning authoritative zero", async () => {
		const f = await fixture(async () => completed(false));
		try {
			const response = await f.router.route(request(), "offline-test");
			expect(response.status).toBe(502);
			expect(await response.text()).toContain("provider_usage_unknown");
			expect(response.headers.get("x-omp-provider-attempts")).toBe("1");
			expect(response.headers.get("x-omp-provider-attempt-limit-applied")).toBe("1");
		} finally {
			f.close();
		}
	});

	it("does not follow a provider redirect", async () => {
		let sends = 0;
		const f = await fixture(async (_input, init) => {
			sends++;
			expect(init?.redirect).toBe("manual");
			return new Response(null, { status: 307, headers: { location: "https://never.invalid/generation" } });
		});
		try {
			const response = await f.router.route(request(), "offline-test");
			expect(response.status).not.toBe(200);
			expect(sends).toBe(1);
			expect(response.headers.get("x-omp-provider-attempts")).toBe("1");
		} finally {
			f.close();
		}
	});
});
