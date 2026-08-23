import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-hyper-provider-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_OFFLINE;
delete process.env.HYPER_API_KEY;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("Unexpected network request in provider tests");
};

after(() => {
	globalThis.fetch = originalFetch;
	rmSync(agentDir, { recursive: true, force: true });
});

test("Pi loads Hyper, persists refreshed models, restores offline, and retains them on failure", {
	timeout: 60_000,
}, async () => {
	const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("hyper", async () => ({ type: "api_key", key: "fixture-api-key" }));
	const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

	async function load() {
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: path.join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		const loader = new DefaultResourceLoader({
			agentDir,
			cwd: agentDir,
			additionalExtensionPaths: [extensionPath],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			agentDir,
			cwd: agentDir,
			modelRuntime: runtime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(agentDir),
			noTools: "all",
		});
		assert.ok(runtime.getRegisteredNativeProvider("hyper"));
		return { runtime, session };
	}

	let requests = 0;
	let fail = false;
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), "https://hyper.charm.land/v1/provider");
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-api-key");
		requests += 1;
		if (fail) return new Response("Unavailable", { status: 503 });
		return Response.json({
			models: [
				{
					id: "fixture-model",
					name: "Fixture model",
					cost_per_1m_in: 2,
					cost_per_1m_out: 7,
					cost_per_1m_in_cached: 1,
					context_window: 8192,
					default_max_tokens: 1024,
					can_reason: false,
					supports_attachments: true,
				},
			],
		});
	};
	const first = await load();
	try {
		assert.equal(requests, 0, "loading must not refresh over the network");
		const result = await first.runtime.refresh({ providers: ["hyper"], allowNetwork: true, force: true });
		assert.equal(result.errors.size, 0);
		assert.equal(requests, 1);
		const model = first.runtime.getModel("hyper", "fixture-model");
		assert.ok(model);
		assert.equal(model.contextWindow, 8192);
		assert.equal(model.maxTokens, 1024);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal((await first.runtime.getAuth(model))?.auth.apiKey, "fixture-api-key");
	} finally {
		first.session.dispose();
	}

	const restored = await load();
	try {
		await restored.runtime.refresh({ providers: ["hyper"], allowNetwork: false });
		assert.equal(requests, 1, "offline restoration must not fetch");
		assert.equal(restored.runtime.getModel("hyper", "fixture-model")?.name, "Fixture model");
		fail = true;
		const failed = await restored.runtime.refresh({ providers: ["hyper"], allowNetwork: true, force: true });
		assert.ok(failed.errors.has("hyper"));
		assert.ok(requests > 1);
		assert.equal(restored.runtime.getModel("hyper", "fixture-model")?.contextWindow, 8192);

		await credentials.modify("hyper", async () => ({
			type: "oauth",
			access: "fixture-oauth-access",
			refresh: "fixture-oauth-refresh",
			expires: Date.now() + 3_600_000,
		}));
		assert.equal((await restored.runtime.getAuth("hyper"))?.auth.apiKey, "fixture-oauth-access");
		await credentials.delete("hyper");
		process.env.HYPER_API_KEY = "fixture-environment-key";
		assert.equal((await restored.runtime.getAuth("hyper"))?.auth.apiKey, "fixture-environment-key");

		const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
		const mockHttp = fileURLToPath(new URL("./mock-http.ts", import.meta.url));
		const requestLog = path.join(agentDir, "requests.log");
		// TUI refresh needs an interactive check: Pi's startup benchmark only
		// calls init(), while catalog refresh starts in run().
		for (const mode of ["print", "json", "rpc"]) {
			writeFileSync(requestLog, "");
			const args = [
				"--import",
				mockHttp,
				cli,
				"--no-session",
				"--no-tools",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--model",
				"hyper/fixture-model",
				"-e",
				extensionPath,
			];
			if (mode === "print") args.push("--print", "fixture prompt");
			if (mode === "json") args.push("--mode", "json", "fixture prompt");
			if (mode === "rpc") args.push("--mode", "rpc");
			const child = spawnSync(process.execPath, args, {
				cwd: agentDir,
				env: {
					PATH: process.env.PATH,
					HOME: agentDir,
					PI_CODING_AGENT_DIR: agentDir,
					HYPER_API_KEY: "fixture-api-key",
					HYPER_TEST_REQUEST_LOG: requestLog,
				},
				input: mode === "rpc" ? '{"type":"get_state"}\n' : "",
				encoding: "utf8",
				timeout: 10_000,
			});
			assert.equal(child.error, undefined, `${mode}: ${child.error}\n${child.stdout}\n${child.stderr}`);
			assert.equal(child.status, 0, `${mode}: ${child.stderr}`);
			const requests = readFileSync(requestLog, "utf8");
			assert.equal(requests.includes("/v1/provider"), mode === "rpc", `${mode} catalog policy`);
			if (mode === "print" || mode === "json") assert.ok(child.stdout.includes("fixture response"), child.stdout);
			if (mode === "rpc") assert.ok(child.stdout.includes('"command":"get_state"'), child.stdout);
		}
	} finally {
		delete process.env.HYPER_API_KEY;
		restored.session.dispose();
	}
});
