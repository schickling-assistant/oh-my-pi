import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { scheduler } from "node:timers/promises";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { complete, completeSimple, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ProviderAttemptBudget, ProviderAttemptLimitError } from "@oh-my-pi/pi-utils/provider-attempt-budget";

const SOURCE_ID = "completion-provider-attempt-budget-test";
const API = "completion-provider-attempt-budget-test" as Api;
const model = {
	api: API,
	provider: "test-provider",
	id: "test-model",
	name: "Test model",
	contextWindow: 1_000,
	maxTokens: 100,
} as Model<Api>;
const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: API,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	};
}

function terminal(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
	else stream.push({ type: "done", reason: "stop", message });
	return stream;
}

function thinkingLoop(content: AssistantMessage["content"] = []): AssistantMessage {
	return assistant({
		content,
		stopReason: "error",
		errorMessage: "Thinking loop detected",
		errorId: AIError.create(AIError.Flag.ThinkingLoop),
	});
}

afterEach(() => {
	unregisterCustomApis(SOURCE_ID);
});

describe("completion provider attempt budget", () => {
	for (const entrypoint of ["completeSimple", "complete"] as const) {
		test(`${entrypoint} refuses thinking-loop recovery before scheduling or dispatching`, async () => {
			const budget = new ProviderAttemptBudget();
			const attempts: AssistantMessage[] = [];
			let calls = 0;
			registerCustomApi(
				API,
				(_model, _context, options) => {
					calls += 1;
					expect(options?.providerAttemptBudget).toBe(budget);
					budget.consume();
					return terminal(thinkingLoop());
				},
				SOURCE_ID,
			);
			const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
			try {
				const result =
					entrypoint === "completeSimple"
						? completeSimple(model, context, {
								providerAttemptBudget: budget,
								onAttempt: message => attempts.push(message),
							})
						: complete(model, context, { providerAttemptBudget: budget });
				await expect(result).rejects.toBeInstanceOf(ProviderAttemptLimitError);
				expect(budget.error).toMatchObject({
					status: 409,
					code: "provider_attempt_limit_exceeded",
					message: "Gateway refused a second provider attempt",
				});
				expect(budget.attempts).toBe(1);
				expect(calls).toBe(1);
				expect(waitSpy).not.toHaveBeenCalled();
				if (entrypoint === "completeSimple") {
					expect(attempts).toHaveLength(1);
					expect(AIError.is(attempts[0]?.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
				}
			} finally {
				waitSpy.mockRestore();
			}
		});
	}

	test("unbudgeted completion retains thinking-loop recovery", async () => {
		let calls = 0;
		const success = assistant({ content: [{ type: "text", text: "ok" }] });
		registerCustomApi(API, () => terminal(++calls === 1 ? thinkingLoop() : success), SOURCE_ID);
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			expect(await completeSimple(model, context)).toEqual(success);
			expect(calls).toBe(2);
			expect(waitSpy).toHaveBeenCalledTimes(1);
		} finally {
			waitSpy.mockRestore();
		}
	});

	for (const message of [
		assistant({ content: [{ type: "text", text: "ok" }] }),
		thinkingLoop([{ type: "text", text: "already visible" }]),
		assistant({ stopReason: "error", errorMessage: "not a thinking-loop error" }),
	]) {
		test(`does not refuse a non-retryable ${message.stopReason} result with ${message.content.length} blocks`, async () => {
			const budget = new ProviderAttemptBudget();
			let calls = 0;
			registerCustomApi(
				API,
				() => {
					calls += 1;
					budget.consume();
					return terminal(message);
				},
				SOURCE_ID,
			);
			expect(await completeSimple(model, context, { providerAttemptBudget: budget })).toEqual(message);
			expect(calls).toBe(1);
			expect(budget.error).toBeUndefined();
		});
	}
});

describe("stream auth recovery with a provider attempt budget", () => {
	for (const status of [401, 403, 429]) {
		for (const failureMode of ["thrown", "terminal"] as const) {
			test(`refuses ${failureMode} ${status} without refreshing or rotating credentials`, async () => {
				const budget = new ProviderAttemptBudget();
				const resolutions: ApiKeyResolveContext[] = [];
				const keys: SimpleStreamOptions["apiKey"][] = [];
				registerCustomApi(
					API,
					(_model, _context, options) => {
						keys.push(options?.apiKey);
						expect(options?.providerAttemptBudget).toBe(budget);
						budget.consume();
						if (failureMode === "terminal") {
							return terminal(
								assistant({
									stopReason: "error",
									errorStatus: status,
									errorMessage: `${status} usage limit reached`,
								}),
							);
						}
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() =>
							stream.fail(Object.assign(new Error(`${status} usage limit reached`), { status })),
						);
						return stream;
					},
					SOURCE_ID,
				);
				const stream = streamSimple(model, context, {
					providerAttemptBudget: budget,
					apiKey: async resolution => {
						resolutions.push(resolution);
						if (resolution.error === undefined) return "initial-key";
						return resolution.lastChance ? "rotated-key" : "refreshed-key";
					},
				});
				await expect(stream.result()).rejects.toBeInstanceOf(ProviderAttemptLimitError);
				expect(keys).toEqual(["initial-key"]);
				expect(resolutions).toHaveLength(1);
				expect(resolutions[0]).toMatchObject({ lastChance: false, error: undefined });
				expect(budget.attempts).toBe(1);
				expect(budget.error).toBeInstanceOf(ProviderAttemptLimitError);
			});
		}
	}

	test("initial credential resolution and successful dispatch remain allowed", async () => {
		const budget = new ProviderAttemptBudget();
		const resolutions: ApiKeyResolveContext[] = [];
		const success = assistant({ content: [{ type: "text", text: "ok" }] });
		registerCustomApi(
			API,
			(_model, _context, options) => {
				expect(options?.apiKey).toBe("initial-key");
				budget.consume();
				return terminal(success);
			},
			SOURCE_ID,
		);
		const result = await completeSimple(model, context, {
			providerAttemptBudget: budget,
			apiKey: async resolution => {
				resolutions.push(resolution);
				return "initial-key";
			},
		});
		expect(result).toEqual(success);
		expect(resolutions).toHaveLength(1);
		expect(budget.attempts).toBe(1);
		expect(budget.error).toBeUndefined();
	});
});
