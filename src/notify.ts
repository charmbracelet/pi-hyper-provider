import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type WarningSink = (message: string) => void;

export interface Notifier {
	/** Emit a deduplicated warning through the currently available output. */
	warn: WarningSink;
	/** Emit future warnings through the session's output mode. */
	activate(ctx: ExtensionContext): void;
}

export function createNotifier(): Notifier {
	const seenWarnings = new Set<string>();
	const emitToStderr: WarningSink = (message) => process.stderr.write(`Hyper warning: ${message}\n`);
	let emit: WarningSink = emitToStderr;
	let activated = false;

	return {
		warn(message) {
			if (seenWarnings.has(message)) return;
			seenWarnings.add(message);
			emit(message);
		},

		activate(ctx) {
			if (activated) return;
			activated = true;
			if (ctx.hasUI) emit = (message) => ctx.ui.notify(message, "warning");
		},
	};
}
