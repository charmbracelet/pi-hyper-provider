import { createProvider, envApiKeyAuth, lazyOAuth, type OAuthAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CreditStatusRuntime } from "./credits.js";
import { HYPER_API_BASE_URL, PROVIDER_DISPLAY_NAME, PROVIDER_NAME } from "./hyper.js";
import { createNotifier } from "./notify.js";

type CreditStatusState =
	| { kind: "idle" }
	| { kind: "loading"; operation: Promise<CreditStatusRuntime> }
	| { kind: "ready"; runtime: CreditStatusRuntime }
	| { kind: "disposed" };

type PendingCreditStatusRefresh = {
	ctx: ExtensionContext;
	model: ExtensionContext["model"];
};

export default function (pi: ExtensionAPI) {
	const notifier = createNotifier();
	let creditStatusState: CreditStatusState = { kind: "idle" };
	let pendingCreditStatusRefresh: PendingCreditStatusRefresh | undefined;
	let creditStatusRefreshWork: ReturnType<typeof setImmediate> | undefined;

	function loadCreditStatus(): Promise<CreditStatusRuntime> {
		if (creditStatusState.kind === "ready") return Promise.resolve(creditStatusState.runtime);
		if (creditStatusState.kind === "loading") return creditStatusState.operation;
		if (creditStatusState.kind === "disposed") {
			return Promise.reject(new Error("Hyper status support was disposed"));
		}

		const operation = import("./credits.js").then(({ createCreditStatusRuntime }) => {
			const runtime = createCreditStatusRuntime(notifier.warn);
			if (creditStatusState.kind === "disposed") {
				runtime.dispose();
				return runtime;
			}
			creditStatusState = { kind: "ready", runtime };
			return runtime;
		});
		creditStatusState = { kind: "loading", operation };
		void operation.catch(() => {
			if (creditStatusState.kind === "loading" && creditStatusState.operation === operation) {
				creditStatusState = { kind: "idle" };
			}
		});
		return operation;
	}

	function schedulePendingCreditStatusRefresh(): void {
		if (!pendingCreditStatusRefresh || creditStatusRefreshWork !== undefined) return;

		// Jiti evaluates transformed modules synchronously once import starts. A
		// macrotask lets Pi finish its awaited lifecycle dispatch before that work.
		const scheduled = setImmediate(() => {
			void loadCreditStatus()
				.then((runtime) => {
					if (creditStatusRefreshWork !== scheduled) return;
					const refresh = pendingCreditStatusRefresh;
					pendingCreditStatusRefresh = undefined;
					creditStatusRefreshWork = undefined;
					if (refresh) {
						void runtime.refresh(refresh.ctx, refresh.model).catch((error: unknown) => {
							if (creditStatusState.kind !== "disposed") {
								notifier.warn(`Unable to refresh Hyper status: ${String(error)}`);
							}
						});
					}
				})
				.catch((error: unknown) => {
					if (creditStatusRefreshWork === scheduled && creditStatusState.kind !== "disposed") {
						pendingCreditStatusRefresh = undefined;
						notifier.warn(`Unable to load Hyper status support: ${String(error)}`);
					}
				})
				.finally(() => {
					if (creditStatusRefreshWork !== scheduled) return;
					creditStatusRefreshWork = undefined;
					schedulePendingCreditStatusRefresh();
				});
		});
		creditStatusRefreshWork = scheduled;
	}

	function scheduleCreditStatusRefresh(ctx: ExtensionContext, model: ExtensionContext["model"]): void {
		pendingCreditStatusRefresh = { ctx, model };
		schedulePendingCreditStatusRefresh();
	}

	function deactivateCreditStatus(ctx: ExtensionContext, model: ExtensionContext["model"]): void {
		pendingCreditStatusRefresh = undefined;
		if (creditStatusRefreshWork !== undefined) {
			clearImmediate(creditStatusRefreshWork);
			creditStatusRefreshWork = undefined;
		}
		if (creditStatusState.kind === "ready") {
			void creditStatusState.runtime.refresh(ctx, model);
		}
		ctx.ui.setStatus(PROVIDER_NAME, undefined);
	}

	pi.on("session_start", (_event, ctx) => {
		notifier.activate(ctx);
		if (!ctx.hasUI) return;
		if (ctx.model?.provider !== PROVIDER_NAME) {
			deactivateCreditStatus(ctx, ctx.model);
			return;
		}
		scheduleCreditStatusRefresh(ctx, ctx.model);
	});

	pi.registerProvider(
		createProvider({
			id: PROVIDER_NAME,
			name: PROVIDER_DISPLAY_NAME,
			baseUrl: HYPER_API_BASE_URL,
			auth: {
				apiKey: envApiKeyAuth("Hyper API key", ["HYPER_API_KEY"]),
				oauth: lazyOAuth({
					name: PROVIDER_DISPLAY_NAME,
					load: async () => {
						const { loginHyper, refreshHyperToken } = await import("./oauth.js");
						return {
							name: PROVIDER_DISPLAY_NAME,
							login: loginHyper,
							refresh: refreshHyperToken,
							toAuth: async (credential) => ({ apiKey: credential.access }),
						} satisfies OAuthAuth;
					},
				}),
			},
			models: [],
			fetchModels: async ({ signal }) => {
				const { fetchHyperModels } = await import("./models.js");
				return fetchHyperModels(signal);
			},
			api: openAICompletionsApi(),
		}),
	);

	pi.registerCommand("hyper-status", {
		description: "Configure the Charm Hyper footer status",
		handler: async (args, ctx) => {
			try {
				const runtime = await loadCreditStatus();
				if (creditStatusState.kind === "disposed") return;
				await runtime.handleCommand(args, ctx);
			} catch (error) {
				if (creditStatusState.kind === "disposed") return;
				ctx.ui.notify(`Unable to load Hyper status support: ${String(error)}`, "warning");
			}
		},
	});

	pi.on("model_select", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.model.provider !== PROVIDER_NAME) {
			deactivateCreditStatus(ctx, event.model);
			return;
		}
		scheduleCreditStatusRefresh(ctx, event.model);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (creditStatusState.kind === "disposed" || !ctx.hasUI || ctx.model?.provider !== PROVIDER_NAME) return;
		scheduleCreditStatusRefresh(ctx, ctx.model);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		pendingCreditStatusRefresh = undefined;
		if (creditStatusRefreshWork !== undefined) clearImmediate(creditStatusRefreshWork);
		creditStatusRefreshWork = undefined;
		if (creditStatusState.kind === "ready") creditStatusState.runtime.dispose();
		creditStatusState = { kind: "disposed" };
		if (ctx.hasUI) ctx.ui.setStatus(PROVIDER_NAME, undefined);
	});
}
