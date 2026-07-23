import { hostname } from "node:os";
import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { fetchJson, fetchJsonResponse } from "./http.js";
import { hyperBaseUrl, hyperJsonHeaders } from "./hyper.js";
import { parseSchema } from "./schema.js";

// Inlined from pi-ai (no longer publicly exported)
const CANCEL_MESSAGE = "Login cancelled";
const TIMEOUT_MESSAGE = "Device flow timed out";
const SLOW_DOWN_TIMEOUT_MESSAGE =
	"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
const MINIMUM_INTERVAL_MS = 1000;
const POLL_DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

type OAuthDeviceCodeIncompletePollResult =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "failed"; message: string };

type OAuthDeviceCodePollResult<T> = OAuthDeviceCodeIncompletePollResult | { status: "complete"; value: T };

function abortableSleep(ms: number, signal: AbortSignal | undefined, cancelMessage: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(cancelMessage));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(cancelMessage));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function pollOAuthDeviceCodeFlow<T>(options: {
	intervalSeconds?: number;
	expiresInSeconds?: number;
	poll: () => Promise<OAuthDeviceCodePollResult<T>>;
	signal?: AbortSignal;
}): Promise<T> {
	const deadline =
		typeof options.expiresInSeconds === "number"
			? Date.now() + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(
		MINIMUM_INTERVAL_MS,
		Math.floor((options.intervalSeconds ?? POLL_DEFAULT_INTERVAL_SECONDS) * 1000),
	);

	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (options.signal?.aborted) {
			throw new Error(CANCEL_MESSAGE);
		}

		const result = await options.poll();
		if (result.status === "complete") {
			return result.value;
		}
		if (result.status === "failed") {
			throw new Error(result.message);
		}
		if (result.status === "slow_down") {
			slowDownResponses += 1;
			intervalMs =
				typeof result.intervalSeconds === "number" &&
				Number.isFinite(result.intervalSeconds) &&
				result.intervalSeconds > 0
					? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
					: Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}

		await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
	}

	throw new Error(slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}

const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const OAUTH_FETCH_TIMEOUT_MS = 30_000;

const DeviceAuthResponseSchema = Type.Object(
	{
		device_code: Type.String({ minLength: 1 }),
		expires_in: Type.Integer({ minimum: 1 }),
		user_code: Type.String({ minLength: 1 }),
		verification_url: Type.String({ minLength: 1 }),
		interval: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const DevicePollSuccessSchema = Type.Object(
	{
		refresh_token: Type.String({ minLength: 1 }),
		team_id: Type.String({ minLength: 1 }),
		team_name: Type.String({ minLength: 1 }),
		user_id: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const DevicePollErrorCodeSchema = Type.Union([
	Type.Literal("authorization_pending"),
	Type.Literal("slow_down"),
	Type.Literal("access_denied"),
	Type.Literal("expired_token"),
	Type.Literal("invalid_request"),
	Type.Literal("invalid_grant"),
]);

const DevicePollErrorSchema = Type.Object(
	{
		error: DevicePollErrorCodeSchema,
		error_description: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const DevicePollResponseSchema = Type.Union([DevicePollSuccessSchema, DevicePollErrorSchema]);

const TokenExchangeWithExpiresInSchema = Type.Object(
	{
		access_token: Type.String({ minLength: 1 }),
		token_type: Type.String({ minLength: 1 }),
		refresh_token: Type.String({ minLength: 1 }),
		expiry: Type.String({ minLength: 1 }),
		expires_in: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const TokenExchangeWithExpiresAtSchema = Type.Object(
	{
		access_token: Type.String({ minLength: 1 }),
		token_type: Type.String({ minLength: 1 }),
		refresh_token: Type.String({ minLength: 1 }),
		expiry: Type.String({ minLength: 1 }),
		expires_at: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const TokenExchangeResponseSchema = Type.Union([TokenExchangeWithExpiresInSchema, TokenExchangeWithExpiresAtSchema]);

type DeviceAuthResponse = Static<typeof DeviceAuthResponseSchema>;
type DevicePollResponse = Static<typeof DevicePollSuccessSchema> | Static<typeof DevicePollErrorSchema>;
type DevicePollSuccess = Static<typeof DevicePollSuccessSchema>;
type TokenExchangeResponse =
	| Static<typeof TokenExchangeWithExpiresInSchema>
	| Static<typeof TokenExchangeWithExpiresAtSchema>;

async function initiateDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthResponse> {
	const payload = await fetchJson(`${hyperBaseUrl()}/device/auth`, {
		method: "POST",
		headers: hyperJsonHeaders(),
		body: JSON.stringify({ device_name: deviceName() }),
		signal,
		timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
	});
	return parseSchema(DeviceAuthResponseSchema, payload, "Hyper device auth response");
}

function deviceName(): string {
	const host = hostname();
	return host ? `Pi (${host})` : "Pi";
}

async function pollDeviceAuth(deviceAuth: DeviceAuthResponse, signal?: AbortSignal): Promise<DevicePollSuccess> {
	return pollOAuthDeviceCodeFlow<DevicePollSuccess>({
		intervalSeconds: deviceAuth.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
		expiresInSeconds: deviceAuth.expires_in,
		signal,
		poll: async () => {
			const response = await fetchJsonResponse(
				`${hyperBaseUrl()}/device/auth/${encodeURIComponent(deviceAuth.device_code)}`,
				{
					headers: hyperJsonHeaders(),
					signal,
					timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
					allowHttpErrorPayload: true,
				},
			);
			const pollResponse = parseDevicePollResponse(
				response.payload,
				`Hyper device token response (HTTP ${response.status})`,
			);

			if ("refresh_token" in pollResponse) {
				return { status: "complete", value: pollResponse };
			}
			if (pollResponse.error === "authorization_pending") return { status: "pending" };
			if (pollResponse.error === "slow_down") return { status: "slow_down" };

			return {
				status: "failed",
				message: `Hyper device authorization failed: ${pollResponse.error_description ?? pollResponse.error}`,
			};
		},
	});
}

function parseDevicePollResponse(payload: unknown, source = "Hyper device token response"): DevicePollResponse {
	if (Value.Check(DevicePollSuccessSchema, payload)) {
		return Value.Parse(DevicePollSuccessSchema, payload);
	}
	if (Value.Check(DevicePollErrorSchema, payload)) {
		return Value.Parse(DevicePollErrorSchema, payload);
	}
	parseSchema(DevicePollResponseSchema, payload, source);
	throw new Error("Hyper device token response is invalid");
}

async function exchangeRefreshToken(refreshToken: string, signal?: AbortSignal): Promise<TokenExchangeResponse> {
	const payload = await fetchJson(`${hyperBaseUrl()}/token/exchange`, {
		method: "POST",
		headers: hyperJsonHeaders(),
		body: JSON.stringify({ refresh_token: refreshToken }),
		signal,
		timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
	});
	return parseTokenExchangeResponse(payload);
}

function parseTokenExchangeResponse(payload: unknown): TokenExchangeResponse {
	if (Value.Check(TokenExchangeWithExpiresInSchema, payload)) {
		return Value.Parse(TokenExchangeWithExpiresInSchema, payload);
	}
	if (Value.Check(TokenExchangeWithExpiresAtSchema, payload)) {
		return Value.Parse(TokenExchangeWithExpiresAtSchema, payload);
	}
	parseSchema(TokenExchangeResponseSchema, payload, "Hyper token exchange response");
	throw new Error("Hyper token exchange response is invalid");
}

function tokenToCredentials(
	token: TokenExchangeResponse,
	fallbackRefreshToken: string,
	metadata?: { teamName?: string },
): OAuthCredential {
	const expires = tokenExpiresAtMs(token);
	return {
		type: "oauth",
		refresh: token.refresh_token || fallbackRefreshToken,
		access: token.access_token,
		expires,
		...metadata,
	};
}

function tokenExpiresAtMs(token: TokenExchangeResponse): number {
	const now = Date.now();
	const expiresAt = "expires_in" in token ? now + token.expires_in * 1000 : token.expires_at * 1000;
	if (expiresAt <= now) {
		throw new Error("Hyper token exchange response contains an expired token expiry");
	}

	const bufferMs = Math.min(TOKEN_EXPIRY_BUFFER_MS, Math.floor((expiresAt - now) / 2));
	return expiresAt - bufferMs;
}

export async function loginHyper(interaction: AuthInteraction): Promise<OAuthCredential> {
	const deviceAuth = await initiateDeviceAuth(interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: deviceAuth.user_code,
		verificationUri: deviceAuth.verification_url,
		intervalSeconds: deviceAuth.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
		expiresInSeconds: deviceAuth.expires_in,
	});

	const deviceToken = await pollDeviceAuth(deviceAuth, interaction.signal);
	const token = await exchangeRefreshToken(deviceToken.refresh_token, interaction.signal);
	return tokenToCredentials(token, deviceToken.refresh_token, {
		teamName: deviceToken.team_name,
	});
}

export async function refreshHyperToken(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> {
	const token = await exchangeRefreshToken(credential.refresh, signal);
	return tokenToCredentials(token, credential.refresh, {
		teamName: teamNameFromCredentials(credential),
	});
}

function teamNameFromCredentials(credential: OAuthCredential): string | undefined {
	const teamName = credential.teamName;
	return typeof teamName === "string" && teamName.trim() ? teamName : undefined;
}
