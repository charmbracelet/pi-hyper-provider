import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { fetchJson } from "./http.js";
import {
	HYPER_USER_AGENT,
	hyperApiBaseUrl,
	hyperProviderDir,
	legacyHyperExtensionDir,
	PROVIDER_NAME,
} from "./hyper.js";
import { parseSchema } from "./schema.js";

const MODEL_FETCH_TIMEOUT_MS = 3_000;
const MODEL_CACHE_VERSION = 1;

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

const HyperModelBaseFields = {
	id: Type.String({ minLength: 1 }),
	object: Type.Literal("model"),
	created: Type.Integer({ minimum: 0 }),
	owned_by: Type.String({ minLength: 1 }),
	display_name: Type.String({ minLength: 1 }),
	supports_reasoning: Type.Boolean(),
	supports_attachments: Type.Boolean(),
	context_window: Type.Integer({ minimum: 1 }),
	max_output_tokens: Type.Integer({ minimum: 1 }),
};

const HyperModelSchema = Type.Union([
	Type.Object(
		{
			...HyperModelBaseFields,
			supports_reasoning_effort: Type.Literal(true),
			reasoning_effort_levels: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
			}),
			default_reasoning_effort: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: true },
	),
	Type.Object(
		{
			...HyperModelBaseFields,
			supports_reasoning_effort: Type.Literal(false),
		},
		{ additionalProperties: true },
	),
]);

const ModelPayloadSchema = Type.Object(
	{
		object: Type.Literal("list"),
		data: Type.Array(HyperModelSchema, { minItems: 1 }),
	},
	{ additionalProperties: true },
);

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

const ModelCacheEnvelopeSchema = Type.Object(
	{
		version: Type.Literal(MODEL_CACHE_VERSION),
		hyperApiBaseUrl: Type.String({ minLength: 1 }),
		fetchedAt: Type.String({ minLength: 1 }),
		payload: ProviderPayloadSchema,
	},
	{ additionalProperties: false },
);

type HyperModel = Static<typeof HyperModelSchema>;
type ProviderModel = Static<typeof ProviderModelSchema>;
type ProviderPayload = Static<typeof ProviderPayloadSchema>;
type LegacyModelPayload = Static<typeof ModelPayloadSchema>;
type ModelCacheEnvelope = Static<typeof ModelCacheEnvelopeSchema>;
type ModelCatalog = { kind: "provider"; payload: ProviderPayload } | { kind: "legacy"; payload: LegacyModelPayload };
type ModelCacheRead = { status: "hit"; catalog: ModelCatalog } | { status: "miss" } | { status: "blocked" };

function modelCachePath(): string {
	return path.join(hyperProviderDir(), "models.json");
}

function legacyModelCachePath(): string {
	return path.join(legacyHyperExtensionDir(), "models.json");
}

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
		baseUrl: hyperApiBaseUrl(),
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

function toLegacyProviderModel(model: HyperModel): Model<"openai-completions"> {
	const input: ("text" | "image")[] = model.supports_attachments ? ["text", "image"] : ["text"];
	const thinkingLevelMap = model.supports_reasoning_effort
		? buildThinkingLevelMap(model.reasoning_effort_levels)
		: model.supports_reasoning
			? ON_OFF_THINKING_LEVEL_MAP
			: undefined;

	return {
		id: model.id,
		name: model.display_name,
		api: "openai-completions",
		provider: PROVIDER_NAME,
		baseUrl: hyperApiBaseUrl(),
		headers: { "User-Agent": HYPER_USER_AGENT },
		reasoning: model.supports_reasoning,
		thinkingLevelMap,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.context_window,
		maxTokens: model.max_output_tokens,
		compat: {
			supportsStore: false,
			supportsReasoningEffort: model.supports_reasoning_effort,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
	};
}

function modelsFromCatalog(catalog: ModelCatalog): Model<"openai-completions">[] {
	switch (catalog.kind) {
		case "provider":
			return catalog.payload.models.map(toProviderModel);
		case "legacy":
			return catalog.payload.data.map(toLegacyProviderModel);
	}
}

function providerPayload(payload: unknown, source: string): ProviderPayload {
	return parseSchema(ProviderPayloadSchema, payload, source);
}

function optionalModelCatalog(payload: unknown): ModelCatalog | undefined {
	if (Value.Check(ProviderPayloadSchema, payload)) {
		return { kind: "provider", payload: Value.Parse(ProviderPayloadSchema, payload) };
	}
	if (Value.Check(ModelPayloadSchema, payload)) {
		return { kind: "legacy", payload: Value.Parse(ModelPayloadSchema, payload) };
	}
	return undefined;
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

async function fetchModelPayload(): Promise<unknown> {
	return fetchJson(`${hyperApiBaseUrl()}/provider`, {
		timeoutMs: MODEL_FETCH_TIMEOUT_MS,
	});
}

function readCachedModelCatalog(): ModelCatalog | undefined {
	const cachePath = modelCachePath();
	const cache = readModelCache(cachePath, "Hyper model cache");
	if (cache.status === "hit") return cache.catalog;
	if (cache.status === "blocked") return undefined;

	const legacyCache = readModelCache(legacyModelCachePath(), "legacy Hyper model cache");
	return legacyCache.status === "hit" ? legacyCache.catalog : undefined;
}

function readJsonCache(cachePath: string, description: string): unknown | undefined {
	if (!existsSync(cachePath)) return undefined;
	try {
		return JSON.parse(readFileSync(cachePath, "utf-8"));
	} catch (err) {
		console.error(`Failed to read ${description} at ${cachePath}: ${String(err)}`);
		return undefined;
	}
}

function readModelCache(cachePath: string, description: string): ModelCacheRead {
	const cache = readJsonCache(cachePath, description);
	if (cache === undefined) return { status: "miss" };
	return unwrapModelCache(cache, description);
}

function unwrapModelCache(cache: unknown, description: string): ModelCacheRead {
	const envelopeBaseUrl = modelCacheEnvelopeBaseUrl(cache);
	if (envelopeBaseUrl !== undefined) {
		const expectedBaseUrl = hyperApiBaseUrl();
		if (envelopeBaseUrl !== expectedBaseUrl) {
			console.error(`Ignoring ${description} for ${envelopeBaseUrl}; current Hyper API base URL is ${expectedBaseUrl}`);
			return { status: "blocked" };
		}
	}

	if (Value.Check(ModelCacheEnvelopeSchema, cache)) {
		const envelope = Value.Parse(ModelCacheEnvelopeSchema, cache);
		return { status: "hit", catalog: { kind: "provider", payload: envelope.payload } };
	}

	if (isModelCacheEnvelopeLike(cache)) {
		console.error(`Ignoring invalid ${description} metadata`);
		return { status: "blocked" };
	}

	const catalog = optionalModelCatalog(cache);
	if (catalog === undefined) {
		console.error(`Ignoring invalid ${description}`);
		return { status: "miss" };
	}

	return { status: "hit", catalog };
}

function isModelCacheEnvelopeLike(cache: unknown): boolean {
	if (!isRecord(cache)) return false;
	if (Object.hasOwn(cache, "hyperApiBaseUrl") || Object.hasOwn(cache, "fetchedAt")) return true;
	if (Object.hasOwn(cache, "version") && Object.hasOwn(cache, "payload")) return true;
	return false;
}

function modelCacheEnvelopeBaseUrl(cache: unknown): string | undefined {
	if (!isRecord(cache)) return undefined;
	const value = Object.getOwnPropertyDescriptor(cache, "hyperApiBaseUrl")?.value;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function modelCacheEnvelope(payload: ProviderPayload): ModelCacheEnvelope {
	return {
		version: MODEL_CACHE_VERSION,
		hyperApiBaseUrl: hyperApiBaseUrl(),
		fetchedAt: new Date().toISOString(),
		payload,
	};
}

function writeCachedModelPayload(payload: ProviderPayload): void {
	try {
		mkdirSync(hyperProviderDir(), { recursive: true });
		writeFileSync(modelCachePath(), `${JSON.stringify(modelCacheEnvelope(payload), null, 2)}\n`, "utf-8");
		removeLegacyModelCache();
	} catch (err) {
		console.error(`Failed to write Hyper model cache: ${String(err)}`);
	}
}

function removeLegacyModelCache(): void {
	const cachePath = legacyModelCachePath();
	try {
		unlinkSync(cachePath);
	} catch (err) {
		if (errorCode(err) === "ENOENT") return;
		console.error(`Failed to remove legacy Hyper model cache at ${cachePath}: ${String(err)}`);
	}
}

function errorCode(err: unknown): string | undefined {
	const code = err instanceof Error ? Object.getOwnPropertyDescriptor(err, "code")?.value : undefined;
	return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadModels(): Promise<Model<"openai-completions">[]> {
	try {
		const payload = await fetchModelPayload();
		const providerCatalog = providerPayload(payload, "Hyper /provider response");
		writeCachedModelPayload(providerCatalog);
		return providerCatalog.models.map(toProviderModel);
	} catch (err) {
		const cachedCatalog = readCachedModelCatalog();
		if (cachedCatalog !== undefined) {
			console.error(`Failed to fetch Hyper /provider, using cached model list: ${String(err)}`);
			return modelsFromCatalog(cachedCatalog);
		}
		throw err;
	}
}
