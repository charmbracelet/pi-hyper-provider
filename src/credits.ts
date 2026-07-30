import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchJson, HttpNetworkError, HttpResponseError, HttpTimeoutError } from "./http.js";
import { HYPER_API_BASE_URL, hyperJsonHeaders, PROVIDER_NAME } from "./hyper.js";
import type { WarningSink } from "./notify.js";
import { parseSchema } from "./schema.js";
import {
	defaultHyperStatusItems,
	type HyperStatusItems,
	readHyperStatusItems,
	writeHyperStatusItems,
} from "./settings.js";

const HYPER_GEM = "\x1b[38;2;255;96;255m◆\x1b[39m";
const CREDITS_FETCH_TIMEOUT_MS = 10_000;
const CREDITS_RETRY_DELAY_MS_INITIAL = 5_000;
const CREDITS_RETRY_DELAY_MS_MAX = 5 * 60_000;
const CREDITS_RETRY_EXPONENT_MAX = 6;

const CreditsPayloadSchema = Type.Object(
	{
		balance: Type.Number(),
	},
	{ additionalProperties: false },
);

async function fetchCredits(apiKey: string): Promise<number> {
	const payload = await fetchJson(`${HYPER_API_BASE_URL}/credits`, {
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

function storedTeamName(): string | undefined {
	const credential = readStoredCredential(PROVIDER_NAME);
	if (credential?.type !== "oauth") return undefined;
	const teamName = credential.teamName;
	return typeof teamName === "string" && teamName.trim() ? teamName : undefined;
}

export function registerCreditStatus(pi: ExtensionAPI, warn: WarningSink): void {
	let invocationSequence = 0;
	let committedInvocation = 0;
	let credentialEpoch = 0;
	let consecutiveFailures = 0;
	let retryAfterMs = 0;
	let currentApiKey: string | undefined;
	let cachedBalance: number | undefined;
	let inFlight: { apiKey: string; credentialEpoch: number; operation: Promise<void> } | undefined;
	type CredentialLease = { apiKey: string; credentialEpoch: number };

	function clearCreditState(): void {
		cachedBalance = undefined;
		consecutiveFailures = 0;
		retryAfterMs = 0;
	}

	function renderStatus(ctx: ExtensionContext): void {
		const statusItems = readHyperStatusItems(warn);
		const teamName = storedTeamName();
		if (!statusItems.hypercredits || cachedBalance === undefined) {
			ctx.ui.setStatus(PROVIDER_NAME, teamNameStatusText(statusItems, teamName));
			return;
		}
		ctx.ui.setStatus(PROVIDER_NAME, statusText(cachedBalance, statusItems, teamName));
	}

	function ownsCredential(lease: CredentialLease): boolean {
		return lease.apiKey === currentApiKey && lease.credentialEpoch === credentialEpoch;
	}

	function render(ctx: ExtensionContext, lease: CredentialLease): void {
		if (!ownsCredential(lease)) return;
		renderStatus(ctx);
	}

	async function fetchAndCache(apiKey: string, expectedCredentialEpoch: number): Promise<void> {
		try {
			const balance = await fetchCredits(apiKey);
			if (credentialEpoch !== expectedCredentialEpoch || currentApiKey !== apiKey) return;
			cachedBalance = balance;
			consecutiveFailures = 0;
			retryAfterMs = 0;
		} catch (error) {
			if (credentialEpoch !== expectedCredentialEpoch || currentApiKey !== apiKey) throw error;
			const transient =
				error instanceof HttpNetworkError ||
				error instanceof HttpTimeoutError ||
				(error instanceof HttpResponseError &&
					(error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599)));
			if (!transient) {
				clearCreditState();
				throw error;
			}
			consecutiveFailures += 1;
			const retryDelayMs = Math.min(
				CREDITS_RETRY_DELAY_MS_INITIAL * 2 ** Math.min(consecutiveFailures - 1, CREDITS_RETRY_EXPONENT_MAX),
				CREDITS_RETRY_DELAY_MS_MAX,
			);
			retryAfterMs = Date.now() + retryDelayMs;
			throw error;
		}
	}

	async function shareFetch(apiKey: string, expectedCredentialEpoch: number): Promise<void> {
		const active = inFlight;
		if (active?.apiKey === apiKey && active.credentialEpoch === expectedCredentialEpoch) {
			await active.operation;
			return;
		}

		const operation = fetchAndCache(apiKey, expectedCredentialEpoch);
		const started = { apiKey, credentialEpoch: expectedCredentialEpoch, operation };
		inFlight = started;
		try {
			await operation;
		} finally {
			if (inFlight === started) {
				inFlight = undefined;
			}
		}
	}

	async function refresh(
		ctx: ExtensionContext,
		selectedModel: ExtensionContext["model"] = ctx.model,
		isUserRequested = false,
	): Promise<void> {
		const invocation = invocationSequence + 1;
		invocationSequence = invocation;
		const forcedLease: CredentialLease | undefined =
			isUserRequested && currentApiKey !== undefined ? { apiKey: currentApiKey, credentialEpoch } : undefined;
		let failureLease: CredentialLease | undefined;
		if (!isHyperModel(selectedModel)) {
			committedInvocation = invocation;
			credentialEpoch += 1;
			ctx.ui.setStatus(PROVIDER_NAME, undefined);
			return;
		}

		const statusItems = readHyperStatusItems(warn);
		if (!statusItems.hypercredits) {
			committedInvocation = invocation;
			credentialEpoch += 1;
			renderStatus(ctx);
			return;
		}

		// Settings and team metadata do not depend on auth. Re-render them now,
		// retaining a balance only while it belongs to the committed credential.
		renderStatus(ctx);
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selectedModel);
			const forcedLeaseStillValid =
				forcedLease !== undefined && auth.ok && auth.apiKey === forcedLease.apiKey && ownsCredential(forcedLease);
			if (invocation < committedInvocation && !forcedLeaseStillValid) return;
			if (!auth.ok || !auth.apiKey) {
				committedInvocation = invocation;
				credentialEpoch += 1;
				currentApiKey = undefined;
				clearCreditState();
				renderStatus(ctx);
				return;
			}
			if (invocation >= committedInvocation) committedInvocation = invocation;
			if (!isUserRequested && currentApiKey === auth.apiKey && Date.now() < retryAfterMs) {
				// This auth result supersedes older general state, but a same-credential
				// forced refresh retains its independent fetch lease.
				return;
			}
			if (currentApiKey !== auth.apiKey) {
				currentApiKey = auth.apiKey;
				credentialEpoch += 1;
				clearCreditState();
				// Never show the previous account while the replacement request runs.
				renderStatus(ctx);
			}
			const expectedCredentialEpoch = credentialEpoch;
			const lease = { apiKey: auth.apiKey, credentialEpoch: expectedCredentialEpoch };
			failureLease = lease;
			await shareFetch(auth.apiKey, expectedCredentialEpoch);
			render(ctx, lease);
		} catch {
			const failedOperationStillOwnsCredential = failureLease !== undefined && ownsCredential(failureLease);
			if (failureLease !== undefined && failedOperationStillOwnsCredential) render(ctx, failureLease);
			if (
				isUserRequested &&
				(failedOperationStillOwnsCredential || (failureLease === undefined && invocation === invocationSequence))
			) {
				ctx.ui.notify("Unable to refresh Hypercredit balance", "warning");
			}
		}
	}

	function refreshInBackground(ctx: ExtensionContext, selectedModel: ExtensionContext["model"] = ctx.model): void {
		if (!ctx.hasUI) return;
		void refresh(ctx, selectedModel).catch(() => undefined);
	}

	pi.registerCommand("hyper-status", {
		description: "Configure the Charm Hyper footer status",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				if (!ctx.hasUI) {
					ctx.ui.notify(statusItemsSummary(readHyperStatusItems(warn)), "info");
					return;
				}

				const changed = await configureStatusItems(ctx, warn);
				if (changed) await refresh(ctx, ctx.model, true);
				return;
			}

			const result = updateStatusItems(args, warn);
			ctx.ui.notify(result.message, "info");
			if (result.kind === "changed") await refresh(ctx, ctx.model, true);
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

async function configureStatusItems(ctx: ExtensionContext, warn: (message: string) => void): Promise<boolean> {
	const initial = readHyperStatusItems(warn);
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

type StatusItemsUpdate =
	| { kind: "changed"; message: string }
	| { kind: "unchanged"; message: string }
	| { kind: "invalid"; message: string };

function updateStatusItems(args: string, warn?: (message: string) => void): StatusItemsUpdate {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return { kind: "unchanged", message: statusItemsSummary(readHyperStatusItems(warn)) };
	}
	if (tokens.length === 1 && tokens[0] === "reset") {
		const statusItems = defaultHyperStatusItems();
		const previous = readHyperStatusItems(warn);
		if (sameStatusItems(previous, statusItems)) {
			return { kind: "unchanged", message: `Hyper status unchanged. ${statusItemsSummary(statusItems)}` };
		}
		writeHyperStatusItems(statusItems);
		return { kind: "changed", message: `Hyper status reset. ${statusItemsSummary(statusItems)}` };
	}
	if (tokens.length !== 2) {
		return { kind: "invalid", message: "Usage: /hyper-status [teamName true|false | hypercredits true|false | reset]" };
	}

	const [key, rawValue] = tokens;
	if ((key !== "teamName" && key !== "hypercredits") || (rawValue !== "true" && rawValue !== "false")) {
		return { kind: "invalid", message: "Usage: /hyper-status [teamName true|false | hypercredits true|false | reset]" };
	}

	const previous = readHyperStatusItems(warn);
	const statusItems = {
		...previous,
		[key]: rawValue === "true",
	};
	if (sameStatusItems(previous, statusItems)) {
		return { kind: "unchanged", message: `Hyper status unchanged. ${statusItemsSummary(statusItems)}` };
	}
	writeHyperStatusItems(statusItems);
	return { kind: "changed", message: `Hyper status updated. ${statusItemsSummary(statusItems)}` };
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
