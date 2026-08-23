import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-hyper-credits-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const hyperModel: Model<"openai-completions"> = {
	id: "fixture",
	name: "Hyper fixture",
	api: "openai-completions",
	provider: "hyper",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

const otherModel: Model<"openai-completions"> = {
	...hyperModel,
	id: "other-fixture",
	name: "Other fixture",
	provider: "other",
};

let originalFetch: typeof fetch;
let context: ExtensionContext;
let disposeSession: (() => void) | undefined;

async function bounded<T>(operation: Promise<T>, timeoutMs = 1_000): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("credit regression test timed out")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

before(async () => {
	originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("Unexpected network request during credit test setup");
	};
	const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { session } = await bounded(
		createAgentSession({
			agentDir,
			cwd: agentDir,
			model: hyperModel,
			noTools: "all",
			sessionManager: SessionManager.inMemory(agentDir),
		}),
		10_000,
	);
	disposeSession = () => session.dispose();
	context = session.extensionRunner.createContext();
	context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "fixture-key" });
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

after(() => {
	disposeSession?.();
	globalThis.fetch = originalFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

function deferredFetch(): {
	fetch: typeof fetch;
	started: Promise<AbortSignal>;
	resolve(): void;
} {
	let start: ((signal: AbortSignal) => void) | undefined;
	let finish: ((response: Response) => void) | undefined;
	const started = new Promise<AbortSignal>((resolve) => {
		start = resolve;
	});
	const fetchFixture: typeof fetch = (_input, init) => {
		const signal = init?.signal;
		assert.ok(signal instanceof AbortSignal);
		assert.ok(start);
		start(signal);
		return new Promise<Response>((resolve) => {
			finish = resolve;
		});
	};
	return {
		fetch: fetchFixture,
		started,
		resolve() {
			assert.ok(finish);
			finish(Response.json({ balance: 42 }));
		},
	};
}

async function runtimeAndStatuses(): Promise<{
	runtime: Awaited<ReturnType<typeof importRuntime>>;
	statuses: Array<string | undefined>;
}> {
	const statuses: Array<string | undefined> = [];
	context.ui.setStatus = (key, text) => {
		assert.equal(key, "hyper");
		statuses.push(text);
	};
	return { runtime: await importRuntime(), statuses };
}

async function importRuntime() {
	const { createCreditStatusRuntime } = await import("../src/credits.ts");
	return createCreditStatusRuntime(() => undefined);
}

test("switching away aborts an in-flight credit fetch without rendering its stale status", async () => {
	const fixture = deferredFetch();
	globalThis.fetch = fixture.fetch;
	const { runtime, statuses } = await runtimeAndStatuses();

	const refresh = runtime.refresh(context, hyperModel);
	const signal = await bounded(fixture.started);
	await bounded(runtime.refresh(context, otherModel));
	fixture.resolve();
	await bounded(refresh);

	assert.equal(signal.aborted, true);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(
		statuses.some((status) => status?.includes("HC") === true),
		false,
	);
});

test("shutdown aborts an in-flight credit fetch without rendering its stale status", async () => {
	const fixture = deferredFetch();
	globalThis.fetch = fixture.fetch;
	const { runtime, statuses } = await runtimeAndStatuses();

	const refresh = runtime.refresh(context, hyperModel);
	const signal = await bounded(fixture.started);
	runtime.dispose();
	fixture.resolve();
	await bounded(refresh);

	assert.equal(signal.aborted, true);
	assert.equal(
		statuses.some((status) => status?.includes("HC") === true),
		false,
	);
});
