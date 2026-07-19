import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchJson } from "./http.js";
import { hyperApiBaseUrl, hyperJsonHeaders, PROVIDER_NAME } from "./hyper.js";
import { parseSchema } from "./schema.js";
import {
	defaultHyperStatusItems,
	type HyperStatusItems,
	readHyperStatusItems,
	writeHyperStatusItems,
} from "./settings.js";

const HYPER_GEM = "\x1b[38;2;255;96;255m◆\x1b[39m";
const CREDITS_FETCH_TIMEOUT_MS = 10_000;

const CreditsPayloadSchema = Type.Object(
	{
		balance: Type.Number(),
	},
	{ additionalProperties: false },
);

async function fetchCredits(apiKey: string): Promise<number> {
	const payload = await fetchJson(`${hyperApiBaseUrl()}/credits`, {
		headers: hyperJsonHeaders({ Authorization: `Bearer ${apiKey}` }),
		timeoutMs: CREDITS_FETCH_TIMEOUT_MS,
	});
	return parseSchema(CreditsPayloadSchema, payload, "Hyper /credits response").balance;
}

function formatCredits(balance: number): string {
	if (Number.isInteger(balance)) return balance.toLocaleString("en-US");
	return balance.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function isHyperModel(model: ExtensionContext["model"]): model is NonNullable<ExtensionContext["model"]> {
	return model?.provider === PROVIDER_NAME;
}

function statusText(balance: number, statusItems: HyperStatusItems, teamName: string | undefined): string {
	const credits = `${HYPER_GEM} ${formatCredits(balance)} hc`;
	if (statusItems.teamName && teamName) return `${teamName}: ${credits}`;
	return credits;
}

function teamNameStatusText(statusItems: HyperStatusItems, teamName: string | undefined): string | undefined {
	if (!statusItems.teamName || !teamName) return undefined;
	return `${HYPER_GEM} ${teamName}`;
}

function storedTeamName(_ctx: ExtensionContext): string | undefined {
	const credential = readStoredCredential(PROVIDER_NAME);
	if (credential?.type !== "oauth") return undefined;
	const teamName = credential.teamName;
	return typeof teamName === "string" && teamName.trim() ? teamName : undefined;
}

export function registerCreditStatus(pi: ExtensionAPI): void {
	let refreshGeneration = 0;

	async function refresh(ctx: ExtensionContext, selectedModel: ExtensionContext["model"] = ctx.model): Promise<void> {
		const generation = refreshGeneration + 1;
		refreshGeneration = generation;

		if (!isHyperModel(selectedModel)) {
			ctx.ui.setStatus(PROVIDER_NAME, undefined);
			return;
		}

		const statusItems = readHyperStatusItems();
		const teamName = storedTeamName(ctx);
		if (!statusItems.hypercredits) {
			ctx.ui.setStatus(PROVIDER_NAME, teamNameStatusText(statusItems, teamName));
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selectedModel);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.setStatus(PROVIDER_NAME, undefined);
			return;
		}

		try {
			const balance = await fetchCredits(auth.apiKey);
			if (generation === refreshGeneration) {
				ctx.ui.setStatus(PROVIDER_NAME, statusText(balance, statusItems, teamName));
			}
		} catch (err) {
			console.error(`Failed to fetch Hyper /credits: ${String(err)}`);
			if (generation === refreshGeneration) {
				ctx.ui.setStatus(PROVIDER_NAME, undefined);
			}
		}
	}

	function refreshInBackground(ctx: ExtensionContext, selectedModel: ExtensionContext["model"] = ctx.model): void {
		void refresh(ctx, selectedModel).catch((err) => {
			console.error(`Failed to update Hyper status: ${String(err)}`);
		});
	}

	pi.registerCommand("hyper-status", {
		description: "Configure the Charm Hyper footer status",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				if (!ctx.hasUI) {
					ctx.ui.notify(statusItemsSummary(readHyperStatusItems()), "info");
					return;
				}

				const changed = await configureStatusItems(ctx);
				if (changed) await refresh(ctx);
				return;
			}

			const message = updateStatusItems(args);
			ctx.ui.notify(message, "info");
			await refresh(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		refreshInBackground(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		refreshInBackground(ctx, event.model);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant" && isHyperModel(ctx.model)) {
			refreshInBackground(ctx);
		}
	});
}

async function configureStatusItems(ctx: ExtensionContext): Promise<boolean> {
	const initial = readHyperStatusItems();
	let draft: HyperStatusItems = { ...initial };

	for (;;) {
		const teamOption = `Team name: ${onOff(draft.teamName)}`;
		const creditsOption = `Hypercredit balance: ${onOff(draft.hypercredits)}`;
		const resetOption = "Reset to defaults";
		const saveOption = "Save changes";
		const cancelOption = "Cancel";

		const choice = await ctx.ui.select("Hyper status settings", [
			teamOption,
			creditsOption,
			resetOption,
			saveOption,
			cancelOption,
		]);

		if (choice === undefined || choice === cancelOption) {
			ctx.ui.notify("Hyper status settings unchanged", "info");
			return false;
		}
		if (choice === teamOption) {
			draft = { ...draft, teamName: !draft.teamName };
			continue;
		}
		if (choice === creditsOption) {
			draft = { ...draft, hypercredits: !draft.hypercredits };
			continue;
		}
		if (choice === resetOption) {
			draft = defaultHyperStatusItems();
			continue;
		}
		if (choice === saveOption) {
			if (sameStatusItems(initial, draft)) {
				ctx.ui.notify(`Hyper status unchanged. ${statusItemsSummary(draft)}`, "info");
				return false;
			}

			const ok = await ctx.ui.confirm("Save Hyper status settings?", statusItemsSummary(draft));
			if (!ok) {
				ctx.ui.notify("Hyper status settings unchanged", "info");
				return false;
			}

			writeHyperStatusItems(draft);
			ctx.ui.notify(`Hyper status updated. ${statusItemsSummary(draft)}`, "info");
			return true;
		}
	}
}

function updateStatusItems(args: string): string {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return statusItemsSummary(readHyperStatusItems());
	}
	if (tokens.length === 1 && tokens[0] === "reset") {
		const statusItems = defaultHyperStatusItems();
		writeHyperStatusItems(statusItems);
		return `Hyper status reset. ${statusItemsSummary(statusItems)}`;
	}
	if (tokens.length !== 2) {
		return "Usage: /hyper-status [teamName true|false | hypercredits true|false | reset]";
	}

	const [key, rawValue] = tokens;
	if ((key !== "teamName" && key !== "hypercredits") || (rawValue !== "true" && rawValue !== "false")) {
		return "Usage: /hyper-status [teamName true|false | hypercredits true|false | reset]";
	}

	const statusItems = {
		...readHyperStatusItems(),
		[key]: rawValue === "true",
	};
	writeHyperStatusItems(statusItems);
	return `Hyper status updated. ${statusItemsSummary(statusItems)}`;
}

function onOff(value: boolean): "on" | "off" {
	return value ? "on" : "off";
}

function sameStatusItems(a: HyperStatusItems, b: HyperStatusItems): boolean {
	return a.teamName === b.teamName && a.hypercredits === b.hypercredits;
}

function statusItemsSummary(statusItems: HyperStatusItems): string {
	return `teamName=${statusItems.teamName}, hypercredits=${statusItems.hypercredits}`;
}
