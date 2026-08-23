import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

// Pi captures the original fetch here and preserves overrides installed afterward.
await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js");

// Preloaded only in isolated CLI smoke-test subprocesses. Never call real fetch.
globalThis.fetch = async (input) => {
	const url = input instanceof Request ? input.url : String(input);
	const logPath = process.env.HYPER_TEST_REQUEST_LOG;
	assert.ok(logPath);
	appendFileSync(logPath, `${url}\n`);
	if (url === "https://hyper.charm.land/v1/credits") return Response.json({ balance: 42 });
	if (url === "https://hyper.charm.land/v1/provider") {
		return Response.json({
			models: [
				{
					id: "fixture-model",
					name: "Refreshed fixture",
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
	}
	if (url === "https://hyper.charm.land/v1/chat/completions") {
		const chunk = {
			id: "fixture",
			object: "chat.completion.chunk",
			created: 1,
			model: "fixture-model",
			choices: [{ index: 0, delta: { role: "assistant", content: "fixture response" }, finish_reason: "stop" }],
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	}
	// Built-in catalogs are irrelevant; reject them without contacting a server.
	return new Response("No fixture for this URL", { status: 404 });
};
