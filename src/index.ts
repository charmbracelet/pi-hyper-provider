import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCreditStatus } from "./credits.js";
import { hyperApiBaseUrl, PROVIDER_DISPLAY_NAME, PROVIDER_NAME } from "./hyper.js";
import { loadModels } from "./models.js";
import { createNotifier } from "./notify.js";
import { loginHyper, refreshHyperToken } from "./oauth.js";
import { migrateHyperSettings } from "./settings.js";
export default async function (pi: ExtensionAPI) {
	const notifier = createNotifier();
	pi.on("session_start", (_event, ctx) => {
		notifier.activate(ctx);
	});

	try {
		migrateHyperSettings(notifier.warn);
	} catch (err) {
		notifier.warn(`Failed to migrate Hyper settings: ${String(err)}`);
	}
	const models = await loadModels(notifier.notify);

	pi.registerProvider(
		createProvider({
			id: PROVIDER_NAME,
			name: PROVIDER_DISPLAY_NAME,
			baseUrl: hyperApiBaseUrl(),
			auth: {
				apiKey: envApiKeyAuth("Hyper API key", ["HYPER_API_KEY"]),
				oauth: {
					name: PROVIDER_DISPLAY_NAME,
					login: loginHyper,
					refresh: refreshHyperToken,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			models,
			api: openAICompletionsApi(),
		}),
	);

	registerCreditStatus(pi, notifier.warn);
}
