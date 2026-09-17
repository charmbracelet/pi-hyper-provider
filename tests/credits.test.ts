import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-hyper-credits-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const authPath = path.join(agentDir, "auth.json");

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
let commandContext: ExtensionCommandContext;
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
	commandContext = session.extensionRunner.createCommandContext();
});

beforeEach(() => {
	writeFileSync(authPath, "{}\n");
	context.modelRegistry.getProviderAuth = async (provider) => {
		assert.equal(provider, "hyper");
		return { auth: { apiKey: "fixture-key" }, source: "credit test" };
	};
	context.modelRegistry.getApiKeyAndHeaders = async () => {
		assert.fail("credit refresh must resolve provider-scoped auth without a model");
	};
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
	const fetchFixture: typeof fetch = (input, init) => {
		assert.equal(String(input), "https://hyper.charm.land/v1/credits");
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-key");
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

function writeOAuthCredential(apiKey: string, teamName: string): void {
	writeFileSync(
		authPath,
		JSON.stringify({
			hyper: { type: "oauth", access: apiKey, refresh: `${apiKey}-refresh`, expires: 1, teamName },
		}),
	);
}

function assertUnlabeledBalance(status: string | undefined, balance: number): void {
	assert.ok(status);
	assert.equal(status.includes(": "), false);
	assert.equal(status.endsWith(` ${balance} HC`), true);
}

function assertNeverAttributed(statuses: Array<string | undefined>, teamName: string, balance: number): void {
	assert.equal(
		statuses.some((status) => status?.startsWith(`${teamName}:`) === true && status.endsWith(` ${balance} HC`)),
		false,
	);
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

test("missing provider auth makes no request when no balance is cached", async () => {
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return Response.json({ balance: 42 });
	};
	context.modelRegistry.getProviderAuth = async (provider) => {
		assert.equal(provider, "hyper");
		return undefined;
	};
	const { runtime, statuses } = await runtimeAndStatuses();

	await bounded(runtime.refresh(context, hyperModel));

	assert.equal(requests, 0);
	assert.equal(statuses.at(-1), undefined);
});

test("missing provider auth retains a previously cached balance", async () => {
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return Response.json({ balance: 42 });
	};
	const { runtime, statuses } = await runtimeAndStatuses();
	await bounded(runtime.refresh(context, hyperModel));
	assert.match(statuses.at(-1) ?? "", /42 HC/);

	context.modelRegistry.getProviderAuth = async (provider) => {
		assert.equal(provider, "hyper");
		return undefined;
	};
	await bounded(runtime.refresh(context, hyperModel));

	assert.equal(requests, 1);
	assert.match(statuses.at(-1) ?? "", /42 HC/);
});

test("provider auth failures retain a previously cached balance", async () => {
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return Response.json({ balance: 42 });
	};
	const { runtime, statuses } = await runtimeAndStatuses();
	await bounded(runtime.refresh(context, hyperModel));
	assert.match(statuses.at(-1) ?? "", /42 HC/);

	context.modelRegistry.getProviderAuth = async () => {
		throw new Error("fixture auth failure");
	};
	await bounded(runtime.refresh(context, hyperModel));

	assert.equal(requests, 1);
	assert.match(statuses.at(-1) ?? "", /42 HC/);
});

test("HTTP errors retain a previously cached balance", async () => {
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return requests === 1 ? Response.json({ balance: 42 }) : new Response("Unauthorized", { status: 401 });
	};
	const { runtime, statuses } = await runtimeAndStatuses();
	await bounded(runtime.refresh(context, hyperModel));
	assert.match(statuses.at(-1) ?? "", /42 HC/);

	await bounded(runtime.refresh(context, hyperModel));

	assert.equal(requests, 2);
	assert.match(statuses.at(-1) ?? "", /42 HC/);
});

test("a stale balance retains its original team name until the new account refreshes", async () => {
	const { writeHyperStatusItems } = await import("../src/settings.ts");
	writeHyperStatusItems({ teamName: true, hypercredits: true });
	let apiKey = "team-a-key";
	let requests = 0;
	let markTeamBRequestStarted: (() => void) | undefined;
	let finishTeamBRequest: ((response: Response) => void) | undefined;
	const teamBRequestStarted = new Promise<void>((resolve) => {
		markTeamBRequestStarted = resolve;
	});
	context.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey }, source: "credit test" });
	globalThis.fetch = async (_input, init) => {
		requests += 1;
		assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${apiKey}`);
		if (requests === 1) return Response.json({ balance: 42 });
		if (requests === 2) {
			assert.ok(markTeamBRequestStarted);
			markTeamBRequestStarted();
			return new Promise<Response>((resolve) => {
				finishTeamBRequest = resolve;
			});
		}
		return Response.json({ balance: 7 });
	};
	const { runtime, statuses } = await runtimeAndStatuses();
	try {
		writeOAuthCredential(apiKey, "Team A");
		await bounded(runtime.refresh(context, hyperModel));
		assert.match(statuses.at(-1) ?? "", /^Team A: .*42 HC$/);

		apiKey = "team-b-key";
		writeOAuthCredential(apiKey, "Team B");
		const transitionStart = statuses.length;
		const failedRefresh = runtime.refresh(context, hyperModel);
		await bounded(teamBRequestStarted);
		assert.match(statuses.at(-1) ?? "", /^Team A: .*42 HC$/);
		assertNeverAttributed(statuses.slice(transitionStart), "Team B", 42);
		assert.ok(finishTeamBRequest);
		finishTeamBRequest(new Response("Unauthorized", { status: 401 }));
		await bounded(failedRefresh);
		assert.match(statuses.at(-1) ?? "", /^Team A: .*42 HC$/);

		await bounded(runtime.refresh(context, hyperModel));
		assert.match(statuses.at(-1) ?? "", /^Team B: .*7 HC$/);
		const transitionStatuses = statuses.slice(transitionStart);
		assertNeverAttributed(transitionStatuses, "Team B", 42);
		assertNeverAttributed(transitionStatuses, "Team A", 7);
		assert.equal(requests, 3);
	} finally {
		writeHyperStatusItems({ teamName: false, hypercredits: true });
	}
});

test("a delayed auth result cannot pair one account's balance with another account's team name", async () => {
	const { writeHyperStatusItems } = await import("../src/settings.ts");
	writeHyperStatusItems({ teamName: true, hypercredits: true });
	let apiKey = "team-a-key";
	let authRequests = 0;
	let releaseAuth: (() => void) | undefined;
	let markAuthStarted: (() => void) | undefined;
	const authStarted = new Promise<void>((resolve) => {
		markAuthStarted = resolve;
	});
	const authRelease = new Promise<void>((resolve) => {
		releaseAuth = resolve;
	});
	context.modelRegistry.getProviderAuth = async () => {
		authRequests += 1;
		const resolvedApiKey = apiKey;
		if (authRequests === 2) {
			assert.ok(markAuthStarted);
			markAuthStarted();
			await authRelease;
		}
		return { auth: { apiKey: resolvedApiKey }, source: "credit test" };
	};
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		if (requests === 1) return Response.json({ balance: 42 });
		if (requests === 2) return Response.json({ balance: 43 });
		if (requests === 3) return new Response("Unauthorized", { status: 401 });
		return Response.json({ balance: 7 });
	};
	const { runtime, statuses } = await runtimeAndStatuses();
	try {
		writeOAuthCredential(apiKey, "Team A");
		await bounded(runtime.refresh(context, hyperModel));
		assert.match(statuses.at(-1) ?? "", /^Team A: .*42 HC$/);

		const transitionStart = statuses.length;
		const delayedRefresh = runtime.refresh(context, hyperModel);
		await bounded(authStarted);
		assert.match(statuses.at(-1) ?? "", /^Team A: .*42 HC$/);
		apiKey = "team-b-key";
		writeOAuthCredential(apiKey, "Team B");
		assert.ok(releaseAuth);
		releaseAuth();
		await bounded(delayedRefresh);
		assertUnlabeledBalance(statuses.at(-1), 43);

		await bounded(runtime.refresh(context, hyperModel));
		assertUnlabeledBalance(statuses.at(-1), 43);

		await bounded(runtime.refresh(context, hyperModel));
		assert.match(statuses.at(-1) ?? "", /^Team B: .*7 HC$/);
		const transitionStatuses = statuses.slice(transitionStart);
		assertNeverAttributed(transitionStatuses, "Team B", 42);
		assertNeverAttributed(transitionStatuses, "Team B", 43);
		assertNeverAttributed(transitionStatuses, "Team A", 7);
		assert.equal(requests, 4);
	} finally {
		writeHyperStatusItems({ teamName: false, hypercredits: true });
	}
});

test("a failed manual refresh retains the cached balance without warning", async () => {
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return requests === 1 ? Response.json({ balance: 42 }) : new Response("Unavailable", { status: 503 });
	};
	const notifications: string[] = [];
	context.ui.notify = (message) => notifications.push(message);
	const { runtime, statuses } = await runtimeAndStatuses();
	await bounded(runtime.refresh(context, hyperModel));
	assert.match(statuses.at(-1) ?? "", /42 HC/);

	await bounded(runtime.handleCommand("hypercredits false", commandContext));
	await bounded(runtime.handleCommand("hypercredits true", commandContext));

	assert.equal(requests, 2);
	assert.match(statuses.at(-1) ?? "", /42 HC/);
	assert.equal(
		notifications.some((message) => message === "Unable to refresh Hypercredit balance"),
		false,
	);
});
