import { type } from "@oh-my-pi/omptype";
import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { ResponseFormat } from "../types";

const schemaObject = type({ "[string]": "unknown" });
const textFormat = type({ type: "'text'" });
const objectFormat = type({ type: "'json_object'" });
const schemaFormat = type({
	type: "'json_schema'",
	name: "string >= 1",
	schema: schemaObject,
	"strict?": "boolean",
	"description?": "string",
});
const chatSchemaFormat = type({
	type: "'json_schema'",
	json_schema: {
		name: "string >= 1",
		schema: schemaObject,
		"strict?": "boolean",
		"description?": "string",
	},
});
const anthropicSchemaFormat = type({ type: "'json_schema'", schema: schemaObject });

/** Decode only wire formats we can carry end-to-end; ignore unknown future formats. */
export function parseResponseFormat(
	value: unknown,
	wire: "chat" | "responses" | "anthropic",
): ResponseFormat | undefined {
	if (value === undefined || value === null) return undefined;
	if (!(value instanceof Object) || Array.isArray(value)) return undefined;
	if (wire === "anthropic") {
		const parsed = anthropicSchemaFormat(value);
		if (!(parsed instanceof type.errors)) return { type: "json_schema", name: "response", schema: parsed.schema };
		const object = objectFormat(value);
		if (!(object instanceof type.errors)) return { type: "json_object" };
	} else {
		const text = textFormat(value);
		if (!(text instanceof type.errors)) return { type: "text" };
		const object = objectFormat(value);
		if (!(object instanceof type.errors)) return { type: "json_object" };
		if (wire === "chat") {
			const parsed = chatSchemaFormat(value);
			if (!(parsed instanceof type.errors)) return { type: "json_schema", ...parsed.json_schema };
		} else {
			const parsed = schemaFormat(value);
			if (!(parsed instanceof type.errors)) return parsed;
		}
	}
	if ("type" in value && (value.type === "json_schema" || value.type === "json_object")) {
		throw new AIError.ValidationError(`Invalid ${wire} ${value.type} response format`);
	}
	logger.debug("response format not supported by gateway", { wire });
	return undefined;
}

export function toChatResponseFormat(format: ResponseFormat) {
	switch (format.type) {
		case "text":
			return { type: "text" as const };
		case "json_object":
			return { type: "json_object" as const };
		case "json_schema":
			return {
				type: "json_schema" as const,
				json_schema: {
					name: format.name,
					schema: format.schema,
					...(format.strict !== undefined ? { strict: format.strict } : {}),
					...(format.description !== undefined ? { description: format.description } : {}),
				},
			};
	}
}
