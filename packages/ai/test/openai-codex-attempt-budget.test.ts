import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { isOpenAICodexWebSocketPreferred } from "@oh-my-pi/pi-ai/providers/openai-codex-transport";
import type { Context, FetchImpl, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { ProviderAttemptBudget } from "@oh-my-pi/pi-utils/provider-attempt-budget";
import { createCodexModel, withEnv } from "./helpers";

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
const model = createCodexModel("gpt-6-sol", {
	baseUrl: "https://chatgpt.com/backend-api",
	preferWebsockets: true,
	accountAccess: { "budget-test": { cyberPrograms: ["standard", "daybreak_blue"] } },
});
const apiKey = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "budget-test" } })).toBase64()}.bbb`;
const nativeUsage = { input_tokens: 5, output_tokens: 3, total_tokens: 8 };

function sse(events: Record<string, unknown>[]): Response {
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function completed(usage: unknown = nativeUsage): Response {
	return sse([{ type: "response.completed", response: { status: "completed", usage } }]);
}

/** Mirrors the gateway boundary: only an actual fetch consumes an HTTP attempt. */
function countedFetch(budget: ProviderAttemptBudget, respond: () => Response | Promise<Response>) {
	return vi.fn(async () => {
		budget.consume();
		return respond();
	});
}

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});
afterEach(() => vi.restoreAllMocks());

describe("Codex request-local provider attempt policy", () => {
	it("forces SSE over environment, caller and model WebSocket preferences, including prewarm", async () => {
		await withEnv({ PI_CODEX_WEBSOCKET: "1" }, async () => {
			const providerAttemptBudget = new ProviderAttemptBudget();
			const providerSessionState = new Map<string, ProviderSessionState>();
			const options = {
				apiKey,
				sessionId: "budget-transport",
				providerSessionState,
				preferWebsockets: true,
				providerAttemptBudget,
			};
			expect(isOpenAICodexWebSocketPreferred(model, options)).toBe(false);
			expect(getOpenAICodexTransportDetails(model, options).websocketPreferred).toBe(false);
			const originalWebSocket = globalThis.WebSocket;
			const websocket = vi.fn((): never => {
				throw new Error("WebSocket must not be constructed under the policy");
			});
			globalThis.WebSocket = class extends originalWebSocket {
				constructor() {
					super(websocket());
				}
			};
			try {
				await prewarmOpenAICodexResponses(model, options);
				const fetch = countedFetch(providerAttemptBudget, () => completed());
				const result = await streamOpenAICodexResponses(model, context, {
					...options,
					fetch: fetch as FetchImpl,
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(result.usage.totalTokens).toBe(8);
				expect(fetch).toHaveBeenCalledTimes(1);
				expect(websocket).not.toHaveBeenCalled();
				expect(providerAttemptBudget.attempts).toBe(1);
			} finally {
				globalThis.WebSocket = originalWebSocket;
				for (const state of providerSessionState.values()) state.close();
			}
		});
	});

	for (const status of [408, 429, 500, 503]) {
		it(`refuses HTTP ${status} recovery without waiting or sending again`, async () => {
			const budget = new ProviderAttemptBudget();
			const wait = vi.spyOn(scheduler, "wait");
			const fetch = countedFetch(
				budget,
				() => new Response("retry later", { status, headers: { "retry-after": "60" } }),
			);
			const result = await streamOpenAICodexResponses(model, context, {
				apiKey,
				fetch: fetch as FetchImpl,
				providerAttemptBudget: budget,
			}).result();
			expect(result.errorCode).toBe("provider_attempt_limit_exceeded");
			expect(result.errorStatus).toBe(409);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(wait).not.toHaveBeenCalled();
		});
	}

	it("refuses network recovery before a retry timer is scheduled", async () => {
		const budget = new ProviderAttemptBudget();
		const wait = vi.spyOn(scheduler, "wait");
		const fetch = countedFetch(budget, () => {
			throw new TypeError("fetch failed");
		});
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey,
			fetch: fetch as FetchImpl,
			providerAttemptBudget: budget,
		}).result();
		expect(result.errorCode).toBe("provider_attempt_limit_exceeded");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(wait).not.toHaveBeenCalled();
	});

	for (const events of [
		[],
		[{ type: "error", code: "server_error", message: "Please retry your request" }],
		[{ type: "response.failed", response: { error: { code: "server_error", message: "Internal server error" } } }],
	]) {
		it(`refuses stream replay for ${events[0]?.type ?? "premature EOF"}`, async () => {
			const budget = new ProviderAttemptBudget();
			const wait = vi.spyOn(scheduler, "wait");
			const fetch = countedFetch(budget, () => sse(events));
			const result = await streamOpenAICodexResponses(model, context, {
				apiKey,
				fetch: fetch as FetchImpl,
				providerAttemptBudget: budget,
			}).result();
			expect(result.errorCode).toBe("provider_attempt_limit_exceeded");
			expect(result.errorStatus).toBe(409);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(wait).not.toHaveBeenCalled();
		});
	}

	for (const status of [400, 415]) {
		it(`refuses zstd rejection replay (${status})`, async () => {
			await withEnv({ PI_CODEX_ZSTD: "1" }, async () => {
				const budget = new ProviderAttemptBudget();
				const fetch = countedFetch(budget, () => new Response("unsupported encoding", { status }));
				const result = await streamOpenAICodexResponses(model, context, {
					apiKey,
					fetch: fetch as FetchImpl,
					providerAttemptBudget: budget,
				}).result();
				expect(result.errorCode).toBe("provider_attempt_limit_exceeded");
				expect(fetch).toHaveBeenCalledTimes(1);
			});
		});
	}

	it("refuses replay after removing rejected access programs", async () => {
		await withEnv({ PI_CODEX_ZSTD: "0" }, async () => {
			const budget = new ProviderAttemptBudget();
			const fetch = countedFetch(
				budget,
				() =>
					new Response(
						JSON.stringify({
							error: {
								code: "access_program_not_enabled",
								param: "access_programs.cyber",
								message: "The requested Cyber access program is not authorized for this workspace.",
							},
						}),
						{ status: 403, headers: { "content-type": "application/json" } },
					),
			);
			const result = await streamOpenAICodexResponses(model, context, {
				apiKey,
				fetch: fetch as FetchImpl,
				providerAttemptBudget: budget,
			}).result();
			expect(result.errorCode).toBe("provider_attempt_limit_exceeded");
			expect(fetch).toHaveBeenCalledTimes(1);
		});
	});

	for (const type of ["response.function_call_arguments.delta", "response.custom_tool_call_input.delta"]) {
		it(`refuses whitespace tool-loop replay (${type}) without backoff`, async () => {
			const budget = new ProviderAttemptBudget();
			const wait = vi.spyOn(scheduler, "wait");
			const fetch = countedFetch(budget, () => sse([{ type, delta: " ".repeat(16 * 1024) }]));
			const result = await streamOpenAICodexResponses(model, context, {
				apiKey,
				fetch: fetch as FetchImpl,
				providerAttemptBudget: budget,
			}).result();
			expect(result.errorCode).toBe("provider_attempt_limit_exceeded");
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(wait).not.toHaveBeenCalled();
		});
	}

	for (const usage of [
		undefined,
		null,
		{},
		{ total_tokens: 0 },
		{ input_tokens: 1 },
		{ input_tokens: -1, output_tokens: 0 },
	]) {
		it(`fails closed on absent or incomplete native usage (${JSON.stringify(usage)})`, async () => {
			const budget = new ProviderAttemptBudget();
			const wait = vi.spyOn(scheduler, "wait");
			const fetch = countedFetch(budget, () =>
				sse([{ type: "response.completed", response: { status: "completed", usage } }]),
			);
			const result = await streamOpenAICodexResponses(model, context, {
				apiKey,
				fetch: fetch as FetchImpl,
				providerAttemptBudget: budget,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorCode).toBe("provider_usage_unknown");
			expect(result.errorStatus).toBe(502);
			expect(budget.error).toBeUndefined();
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(wait).not.toHaveBeenCalled();
		});
	}

	it("accepts authoritative zero usage", async () => {
		const budget = new ProviderAttemptBudget();
		const fetch = countedFetch(budget, () => completed({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }));
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey,
			fetch: fetch as FetchImpl,
			providerAttemptBudget: budget,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.totalTokens).toBe(0);
	});

	it("leaves missing-usage compatibility unchanged without a budget", async () => {
		const fetch = vi.fn(async () => sse([{ type: "response.completed", response: { status: "completed" } }]));
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey,
			preferWebsockets: false,
			fetch: fetch as FetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
	});
});
