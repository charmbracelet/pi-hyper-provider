import type { Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { fetchJson } from "./http.js";
import { HYPER_API_BASE_URL, HYPER_USER_AGENT, PROVIDER_NAME } from "./hyper.js";
import { parseSchema } from "./schema.js";

const MODEL_FETCH_TIMEOUT_MS = 3_000;

const PI_THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];
// Hyper models without reasoning levels are on/off-only. Use Pi's medium level
// as the single representative "on" state; it is not sent as reasoning_effort.
const ON_OFF_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	off: "off",
	minimal: null,
	low: null,
	medium: "medium",
	high: null,
	xhigh: null,
};

const ProviderModelSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		cost_per_1m_in: Type.Number({ minimum: 0 }),
		cost_per_1m_out: Type.Number({ minimum: 0 }),
		cost_per_1m_in_cached: Type.Number({ minimum: 0 }),
		cost_per_1m_out_cached: Type.Optional(Type.Number({ minimum: 0 })),
		context_window: Type.Integer({ minimum: 1 }),
		default_max_tokens: Type.Integer({ minimum: 1 }),
		can_reason: Type.Boolean(),
		reasoning_levels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		default_reasoning_effort: Type.Optional(Type.String({ minLength: 1 })),
		supports_attachments: Type.Boolean(),
	},
	{ additionalProperties: true },
);

const ProviderPayloadSchema = Type.Object(
	{
		models: Type.Array(ProviderModelSchema, { minItems: 1 }),
	},
	{ additionalProperties: true },
);

type ProviderModel = Static<typeof ProviderModelSchema>;

function toProviderModel(model: ProviderModel): Model<"openai-completions"> {
	const input: ("text" | "image")[] = model.supports_attachments ? ["text", "image"] : ["text"];
	const reasoningLevels = model.reasoning_levels ?? [];
	const supportsReasoningEffort = reasoningLevels.length > 0;
	const thinkingLevelMap = supportsReasoningEffort
		? buildThinkingLevelMap(reasoningLevels)
		: model.can_reason
			? ON_OFF_THINKING_LEVEL_MAP
			: undefined;

	return {
		id: model.id,
		name: model.name,
		api: "openai-completions",
		provider: PROVIDER_NAME,
		baseUrl: HYPER_API_BASE_URL,
		headers: { "User-Agent": HYPER_USER_AGENT },
		reasoning: model.can_reason,
		thinkingLevelMap,
		input,
		cost: {
			input: model.cost_per_1m_in,
			output: model.cost_per_1m_out,
			cacheRead: model.cost_per_1m_in_cached,
			// Hyper exposes cached input/output prices, but Pi only models cached
			// input reads and cache writes. Hyper does not expose a cache-write price.
			cacheWrite: 0,
		},
		contextWindow: model.context_window,
		maxTokens: model.default_max_tokens,
		compat: {
			supportsStore: false,
			supportsReasoningEffort,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
	};
}

function buildThinkingLevelMap(levels: string[]): ThinkingLevelMap | undefined {
	if (levels.length === 0) return undefined;
	const availableLevels = new Set<string>(levels);
	const result: ThinkingLevelMap = {
		off: availableLevels.has("off") ? "off" : null,
	};
	for (const level of PI_THINKING_LEVELS) {
		result[level] = availableLevels.has(level) ? level : null;
	}
	return result;
}

export async function fetchHyperModels(signal?: AbortSignal): Promise<Model<"openai-completions">[]> {
	const payload = await fetchJson(`${HYPER_API_BASE_URL}/provider`, {
		signal,
		timeoutMs: MODEL_FETCH_TIMEOUT_MS,
	});
	const provider = parseSchema(ProviderPayloadSchema, payload, "Hyper /provider response");
	return provider.models.map(toProviderModel);
}
