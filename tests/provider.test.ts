import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";

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

		const runner = first.session.extensionRunner;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "fixture response" }],
			api: "openai-completions",
			provider: "hyper",
			model: "fixture-model",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const notices: Array<{ message: string; type: string | undefined }> = [];
		const ui = {
			...runner.createContext().ui,
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notices.push({ message, type });
			},
		};
		for (const mode of ["tui", "rpc", "print", "json"] as const) {
			runner.setUIContext(mode === "tui" || mode === "rpc" ? ui : undefined, mode);
			assert.equal(runner.createContext().hasUI, mode === "tui" || mode === "rpc");
			notices.length = 0;
			const responses: Record<string, string>[] = [
				{ "x-prism-model-name": " GLM 5.3 Flash ", "x-prism-model-id": "glm-5.3-flash" },
				{ "x-prism-model-name": "GLM 5.3 Flash" },
				{ "x-prism-model-id": "glm-5.3-flash" },
				{},
				{ "x-prism-model-name": "  " },
				{ "x-prism-model-name": "bad\u001b[31m" },
				{ "x-prism-model-name": "bad\nline" },
				{ "x-prism-model-name": "bad\u202etext" },
				{ "x-prism-model-name": "x".repeat(201) },
			];
			for (const headers of responses) {
				await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: 1 });
				const count = notices.length;
				await runner.emit({ type: "after_provider_response", status: 200, headers });
				await runner.emitMessageEnd({ type: "message_end", message });
				assert.equal(notices.length, count, "wait until the response has been rendered");
				await runner.emit({ type: "turn_end", turnIndex: 0, message, toolResults: [] });
			}
			assert.deepEqual(
				notices,
				mode === "tui" || mode === "rpc"
					? [
							{ message: "Prism → GLM 5.3 Flash", type: "info" },
							{ message: "Prism → GLM 5.3 Flash", type: "info" },
							{ message: "Prism → glm-5.3-flash", type: "info" },
						]
					: [],
				`${mode} routing notifications`,
			);
			const count = notices.length;
			const headers = { "x-prism-model-name": "Do not display" };
			// Auxiliary responses outside a turn must not leak into the next one.
			await runner.emit({ type: "after_provider_response", status: 200, headers });
			await runner.emit({ type: "turn_start", turnIndex: 1, timestamp: 2 });
			await runner.emitMessageEnd({ type: "message_end", message });
			await runner.emit({ type: "after_provider_response", status: 200, headers });
			await runner.emit({ type: "turn_end", turnIndex: 1, message, toolResults: [] });
			for (const stopReason of ["aborted", "error"] as const) {
				await runner.emit({ type: "turn_start", turnIndex: 2, timestamp: 3 });
				await runner.emit({ type: "after_provider_response", status: 200, headers });
				await runner.emitMessageEnd({ type: "message_end", message: { ...message, stopReason } });
				await runner.emit({ type: "turn_end", turnIndex: 2, message: { ...message, stopReason }, toolResults: [] });
			}
			await runner.emit({ type: "turn_start", turnIndex: 3, timestamp: 4 });
			await runner.emit({ type: "turn_end", turnIndex: 3, message, toolResults: [] });
			assert.equal(notices.length, count, "discard auxiliary, cancelled, failed, and stale routes");
		}
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
			if (mode === "print" || mode === "json") {
				assert.ok(child.stdout.includes("fixture response"), child.stdout);
				assert.equal(child.stdout.includes("Prism →"), false);
				assert.equal(child.stderr.includes("Prism →"), false);
			}
			if (mode === "rpc") assert.ok(child.stdout.includes('"command":"get_state"'), child.stdout);
		}
	} finally {
		delete process.env.HYPER_API_KEY;
		restored.session.dispose();
	}
});
