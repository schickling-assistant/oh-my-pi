import { describe, expect, it } from "bun:test";
import { buildStreamOptions, responseFormatRejection } from "@oh-my-pi/pi-ai/auth-gateway/server";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import {
	formatError as anthropicError,
	parseRequest as parseAnthropic,
} from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { formatError as chatError, parseRequest as parseChat } from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { parseRequest as parseResponses } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import type { Context, Model, ResponseFormat } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const schema = {
	type: "object",
	properties: { answer: { type: "string" } },
	required: ["answer"],
	additionalProperties: false,
};
const format: ResponseFormat = {
	type: "json_schema",
	name: "answer",
	schema,
	strict: true,
	description: "Single answer",
};
const context: Context = { messages: [{ role: "user", content: "Give an answer", timestamp: 0 }] };
const model = <
	TApi extends
		| "anthropic-messages"
		| "openai-completions"
		| "openai-responses"
		| "openai-codex-responses"
		| "google-generative-ai",
>(
	api: TApi,
	provider: "anthropic" | "openai" | "openai-codex" | "google",
): Model<TApi> =>
	buildModel({
		id:
			api === "anthropic-messages"
				? "claude-sonnet-4-6"
				: api === "google-generative-ai"
					? "gemini-test"
					: "gpt-5-mini",
		name: "Response format test",
		api,
		provider,
		baseUrl: api === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || !(key in value)) return undefined;
	const property: unknown = Reflect.get(value, key);
	return property;
}

withOfficialAnthropicEndpoint();

describe("response format at the gateway boundary", () => {
	it("decodes Chat Completions JSON Schema and forwards it into stream options", () => {
		const parsed = parseChat({
			model: "openai-codex/gpt-5-mini",
			messages: [{ role: "user", content: "Hi" }],
			response_format: {
				type: "json_schema",
				json_schema: { name: format.name, schema, strict: true, description: format.description },
			},
		});
		expect(parsed.options.responseFormat).toEqual(format);
		expect(buildStreamOptions(parsed, "openai-codex-responses", abortedSignal()).responseFormat).toEqual(format);
	});

	it("decodes Responses text.format and Anthropic output_config.format", () => {
		const responses = parseResponses({ model: "openai/gpt-5-mini", input: "Hi", text: { format } });
		expect(buildStreamOptions(responses, "openai-responses", abortedSignal()).responseFormat).toEqual(format);
		const anthropic = parseAnthropic({
			model: "anthropic/claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			max_tokens: 64,
			output_config: { format: { type: "json_schema", schema } },
		});
		expect(buildStreamOptions(anthropic, "anthropic-messages", abortedSignal()).responseFormat).toEqual({
			type: "json_schema",
			name: "response",
			schema,
		});
	});

	it("preserves explicit text and legacy JSON object modes", () => {
		expect(
			parseChat({
				model: "gpt-test",
				messages: [{ role: "user", content: "Hi" }],
				response_format: { type: "json_object" },
			}).options.responseFormat,
		).toEqual({ type: "json_object" });
		expect(
			parseResponses({ model: "gpt-test", input: "Hi", text: { format: { type: "text" } } }).options.responseFormat,
		).toEqual({ type: "text" });
	});

	it("rejects JSON Schema requests to providers without native enforcement before inference", async () => {
		const parsed = parseChat({
			model: "google/gemini-test",
			messages: [{ role: "user", content: "Hi" }],
			response_format: { type: "json_schema", json_schema: { name: "answer", schema } },
		});
		const reason = responseFormatRejection(parsed, model("google-generative-ai", "google"));
		expect(reason).toContain("google/gemini-test cannot enforce json_schema");
		if (!reason) throw new Error("Expected unsupported provider rejection");
		const error = chatError(400, "invalid_request_error", reason);
		expect(error.status).toBe(400);
		expect(await error.json()).toEqual({ error: { type: "invalid_request_error", message: reason } });
	});

	it("rejects json_object for Anthropic with an Anthropic-shaped 400", async () => {
		const parsed = parseAnthropic({
			model: "anthropic/claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hi" }],
			max_tokens: 64,
			output_config: { format: { type: "json_object" } },
		});
		const reason = responseFormatRejection(parsed, model("anthropic-messages", "anthropic"));
		expect(reason).toContain("cannot enforce json_object");
		if (!reason) throw new Error("Expected unsupported Anthropic format rejection");
		const error = anthropicError(400, "invalid_request_error", reason);
		expect(error.status).toBe(400);
		expect(await error.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: reason } });
	});

	it("rejects malformed JSON Schema instead of silently requesting unconstrained text", () => {
		expect(() =>
			parseChat({
				model: "openai/gpt-5-mini",
				messages: [{ role: "user", content: "Hi" }],
				response_format: { type: "json_schema", json_schema: { name: "answer" } },
			}),
		).toThrow(/Invalid chat json_schema response format/);
	});
});

describe("response format in provider requests", () => {
	it("sends Anthropic output_config.format only for structured outputs", async () => {
		async function capture(responseFormat?: ResponseFormat): Promise<unknown> {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			streamAnthropic(model("anthropic-messages", "anthropic"), context, {
				apiKey: "sk-ant-oat-test",
				isOAuth: true,
				signal: abortedSignal(),
				responseFormat,
				onPayload: payload => resolve(payload),
			});
			return promise;
		}
		expect(field(field(await capture(format), "output_config"), "format")).toEqual({
			type: "json_schema",
			schema,
		});
		expect(field(field(await capture(), "output_config"), "format")).toBeUndefined();
	});

	it.each([
		["API key", "test-key"],
		["OAuth", "sk-ant-oat-test"],
	])("adds the structured-outputs beta on the %s request only when used", async (_kind, apiKey) => {
		const capture = async (responseFormat?: ResponseFormat): Promise<string> => {
			let beta = "";
			const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
				beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
				return new Response(
					JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}) as typeof fetch;
			await streamAnthropic(model("anthropic-messages", "anthropic"), context, {
				apiKey,
				responseFormat,
				fetch: fetchMock,
			}).result();
			return beta;
		};
		expect((await capture(format)).split(",")).toContain("structured-outputs-2025-12-15");
		if (apiKey === "test-key") {
			expect((await capture()).split(",")).not.toContain("structured-outputs-2025-12-15");
		}
	});

	it("sends Codex Responses text.format without losing other text settings", async () => {
		const body = await buildTransformedCodexRequestBody(model("openai-codex-responses", "openai-codex"), context, {
			responseFormat: format,
			textVerbosity: "low",
		});
		expect(body.text).toEqual({ format, verbosity: "low" });
	});

	it("sends OpenAI Responses text.format", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAIResponses(model("openai-responses", "openai"), context, {
			apiKey: "test",
			signal: abortedSignal(),
			responseFormat: format,
			onPayload: payload => resolve(payload),
		});
		expect(field(field(await promise, "text"), "format")).toEqual(format);
	});

	it("sends Chat Completions response_format using the nested json_schema shape", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model("openai-completions", "openai"), context, {
			apiKey: "test",
			signal: abortedSignal(),
			responseFormat: format,
			onPayload: payload => resolve(payload),
		});
		expect(field(await promise, "response_format")).toEqual({
			type: "json_schema",
			json_schema: { name: "answer", schema, strict: true, description: "Single answer" },
		});
	});
});
