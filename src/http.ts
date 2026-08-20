import { STATUS_CODES } from "node:http";
import { type TProperties, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";

const OpenAIErrorPayloadSchema = Type.Object(
	{
		error: Type.Object(
			{
				message: Type.String({ minLength: 1 }),
				type: Type.String({ minLength: 1 }),
				code: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
const OpenAIErrorPayloadValidator = Compile(OpenAIErrorPayloadSchema);

const MAX_ERROR_MESSAGE_CHARACTERS = 200;
const SAFE_ERROR_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const UNSAFE_ERROR_MESSAGE = /[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface FetchJsonOptions {
	method?: RequestInit["method"];
	headers?: RequestInit["headers"];
	body?: RequestInit["body"];
	signal?: AbortSignal;
	timeoutMs: number;
	allowHttpErrorPayload?: boolean;
}

export interface FetchJsonResponse {
	status: number;
	ok: boolean;
	payload: unknown;
}

type HttpResponseJson = { kind: "parsed"; value: unknown } | { kind: "unavailable" };

export class HttpResponseError extends Error {
	readonly kind = "http";
	readonly #responseJson: HttpResponseJson;

	constructor(
		readonly status: number,
		message: string,
		responseJson: HttpResponseJson,
	) {
		super(message);
		this.name = "HttpResponseError";
		this.#responseJson = responseJson;
	}

	matchesResponseJson<Context extends TProperties, const Schema extends TSchema>(
		validator: Validator<Context, Schema>,
	): boolean {
		return this.#responseJson.kind === "parsed" && validator.Check(this.#responseJson.value);
	}
}

export class HttpTimeoutError extends Error {
	readonly kind = "timeout";

	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "HttpTimeoutError";
	}
}

export class HttpResponseTimeoutError extends HttpTimeoutError {
	constructor(
		readonly status: number,
		message: string,
		cause: unknown,
	) {
		super(message, cause);
		this.name = "HttpResponseTimeoutError";
	}
}

export class HttpNetworkError extends Error {
	readonly kind = "network";

	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "HttpNetworkError";
	}
}

export class HttpResponsePayloadError extends Error {
	readonly kind = "response";

	constructor(
		readonly status: number,
		message: string,
		cause?: unknown,
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "HttpResponsePayloadError";
	}
}

export async function fetchJson(url: string, options: FetchJsonOptions): Promise<unknown> {
	return (await fetchJsonResponse(url, options)).payload;
}

export async function fetchJsonResponse(url: string, options: FetchJsonOptions): Promise<FetchJsonResponse> {
	const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	try {
		const response = await fetch(url, {
			method: options.method,
			headers: options.headers,
			body: options.body,
			signal,
		});
		let body: string;
		try {
			body = await response.text();
		} catch (error) {
			if (abortedBy(signal, timeoutSignal)) {
				throw new HttpResponseTimeoutError(
					response.status,
					`${url} timed out after ${options.timeoutMs}ms while reading HTTP ${response.status} response body`,
					error,
				);
			}
			if (options.signal && abortedBy(signal, options.signal)) throw error;
			if (!response.ok && !options.allowHttpErrorPayload) {
				throw new HttpResponseError(
					response.status,
					`${url} returned ${formatHttpStatus(response.status)}; response body could not be read`,
					{ kind: "unavailable" },
				);
			}
			throw new HttpNetworkError(
				`${url} returned ${formatHttpStatus(response.status)}; response body could not be read`,
				error,
			);
		}
		if (!response.ok && !options.allowHttpErrorPayload) {
			const responseJson = parseHttpResponseJson(body);
			throw new HttpResponseError(
				response.status,
				formatHttpResponseError(url, response.status, responseJson),
				responseJson,
			);
		}
		return {
			status: response.status,
			ok: response.ok,
			payload: parseJsonBody(url, response.status, body),
		};
	} catch (err) {
		if (options.signal && abortedBy(signal, options.signal) && err === options.signal.reason) {
			throw new Error(`${url} request was aborted`, { cause: err });
		}
		if (
			err instanceof HttpResponseError ||
			err instanceof HttpResponsePayloadError ||
			err instanceof HttpNetworkError ||
			err instanceof HttpTimeoutError
		) {
			throw err;
		}
		if (abortedBy(signal, timeoutSignal)) {
			throw new HttpTimeoutError(`${url} timed out after ${options.timeoutMs}ms`, err);
		}
		if (options.signal && abortedBy(signal, options.signal)) {
			throw new Error(`${url} request was aborted`, { cause: err });
		}
		throw new HttpNetworkError(`${url} request failed`, err);
	}
}

function abortedBy(signal: AbortSignal, source: AbortSignal): boolean {
	return signal.aborted && source.aborted && signal.reason === source.reason;
}

function parseJsonBody(url: string, status: number, body: string): unknown {
	if (!body.trim()) {
		throw new HttpResponsePayloadError(status, `${url} returned ${formatHttpStatus(status)} with an empty JSON body`);
	}
	try {
		return JSON.parse(body);
	} catch {
		throw new HttpResponsePayloadError(status, `${url} returned invalid JSON (${formatHttpStatus(status)})`);
	}
}

function parseHttpResponseJson(body: string): HttpResponseJson {
	try {
		return { kind: "parsed", value: JSON.parse(body) };
	} catch {
		return { kind: "unavailable" };
	}
}

function formatHttpResponseError(url: string, status: number, responseJson: HttpResponseJson): string {
	const prefix = `${url} returned ${formatHttpStatus(status)}`;
	const detail = responseJson.kind === "parsed" ? parseSafeOpenAIError(responseJson.value) : undefined;
	return detail === undefined ? prefix : `${prefix}: ${detail}`;
}

function formatHttpStatus(status: number): string {
	const reason = STATUS_CODES[status];
	return reason === undefined ? `HTTP ${status}` : `HTTP ${status} ${reason}`;
}

function parseSafeOpenAIError(payload: unknown): string | undefined {
	if (!OpenAIErrorPayloadValidator.Check(payload)) return undefined;

	const parsed = payload.error;
	if (!SAFE_ERROR_TOKEN.test(parsed.type)) return undefined;
	if (parsed.code !== null && !SAFE_ERROR_TOKEN.test(parsed.code)) return undefined;
	if (!isSafeErrorMessage(parsed.message)) return undefined;

	const identity = parsed.code === null ? parsed.type : `${parsed.type}/${parsed.code}`;
	return `${identity}: ${parsed.message}`;
}

function isSafeErrorMessage(message: string): boolean {
	return (
		message === message.trim() &&
		Array.from(message).length <= MAX_ERROR_MESSAGE_CHARACTERS &&
		!UNSAFE_ERROR_MESSAGE.test(message)
	);
}
