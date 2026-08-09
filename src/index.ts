import { createProvider, envApiKeyAuth, lazyOAuth, type OAuthAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCreditStatus } from "./credits.js";
import { HYPER_API_BASE_URL, PROVIDER_DISPLAY_NAME, PROVIDER_NAME } from "./hyper.js";
import { createNotifier } from "./notify.js";
import { migrateHyperSettings } from "./settings.js";

export default function (pi: ExtensionAPI) {
	const notifier = createNotifier();
	pi.on("session_start", (_event, ctx) => {
		notifier.activate(ctx);
	});

	try {
		migrateHyperSettings(notifier.warn);
	} catch (err) {
		notifier.warn(`Failed to migrate Hyper settings: ${String(err)}`);
	}

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

	registerCreditStatus(pi, notifier.warn);
}
