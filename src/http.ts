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

export class HttpResponseError extends Error {
	readonly kind = "http";

	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "HttpResponseError";
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
	const controller = new AbortController();
	let timedOut = false;
	let callerAborted = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs);
	const abortFromCaller = () => {
		callerAborted = true;
		controller.abort();
	};
	if (options.signal?.aborted) {
		callerAborted = true;
		controller.abort();
	} else {
		options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	}

	try {
		const response = await fetch(url, {
			method: options.method,
			headers: options.headers,
			body: options.body,
			signal: controller.signal,
		});
		let body: string;
		try {
			body = await response.text();
		} catch (error) {
			if (timedOut) {
				throw new HttpResponseTimeoutError(
					response.status,
					`${url} timed out after ${options.timeoutMs}ms while reading HTTP ${response.status} response body`,
					error,
				);
			}
			if (callerAborted) throw error;
			if (!response.ok && !options.allowHttpErrorPayload) {
				throw new HttpResponseError(
					response.status,
					`${url} returned HTTP ${response.status}; response body could not be read`,
				);
			}
			throw new HttpNetworkError(
				`${url} returned HTTP ${response.status}; response body could not be read`,
				error,
			);
		}
		if (!response.ok && !options.allowHttpErrorPayload) {
			throw new HttpResponseError(response.status, `${url} returned HTTP ${response.status}: ${summarizeBody(body)}`);
		}
		return {
			status: response.status,
			ok: response.ok,
			payload: parseJsonBody(url, response.status, body),
		};
	} catch (err) {
		if (
			err instanceof HttpResponseError ||
			err instanceof HttpResponsePayloadError ||
			err instanceof HttpNetworkError ||
			err instanceof HttpTimeoutError
		) {
			throw err;
		}
		if (timedOut) {
			throw new HttpTimeoutError(`${url} timed out after ${options.timeoutMs}ms`, err);
		}
		if (callerAborted) {
			throw new Error(`${url} request was aborted`, { cause: err });
		}
		throw new HttpNetworkError(`${url} request failed`, err);
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

function parseJsonBody(url: string, status: number, body: string): unknown {
	if (!body.trim()) {
		throw new HttpResponsePayloadError(status, `${url} returned HTTP ${status} with an empty JSON body`);
	}
	try {
		return JSON.parse(body);
	} catch (err) {
		throw new HttpResponsePayloadError(
			status,
			`${url} returned invalid JSON (HTTP ${status}): ${summarizeBody(body)}`,
			err,
		);
	}
}

function summarizeBody(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return "empty response body";
	const maxBodyCharacters = 2_000;
	if (trimmed.length <= maxBodyCharacters) return trimmed;
	return `${trimmed.slice(0, maxBodyCharacters)}…`;
}
