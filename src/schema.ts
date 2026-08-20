import type { Static, TProperties, TSchema } from "typebox";
import type { Validator } from "typebox/compile";
import { Errors } from "typebox/value";

export function parseSchema<Context extends TProperties, const Schema extends TSchema>(
	validator: Validator<Context, Schema>,
	payload: unknown,
	source: string,
): Static<Schema, Context> {
	if (validator.Check(payload)) return payload;

	const details = Errors(validator.Context(), validator.Type(), payload)
		.slice(0, 3)
		.map((error) => `${formatErrorPath(source, error.instancePath)} ${error.message}`)
		.join("; ");
	throw new Error(`${source} is invalid: ${details || "unknown validation error"}`);
}

function formatErrorPath(source: string, instancePath: string): string {
	if (!instancePath) return source;
	return `${source}${instancePath}`;
}
