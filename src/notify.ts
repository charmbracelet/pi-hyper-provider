import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type NotificationType = "info" | "warning" | "error";
export type NotificationSink = (message: string, type: NotificationType) => void;
export type WarningSink = (message: string) => void;

export interface Notifier {
	/** Emit a notification through the currently available output. */
	notify: NotificationSink;
	/** Emit a deduplicated warning through the currently available output. */
	warn: WarningSink;
	/** Emit future notifications through the session's output mode. */
	activate(ctx: ExtensionContext): void;
}

export function createNotifier(): Notifier {
	const seenWarnings = new Set<string>();
	const emitToStderr: NotificationSink = (message, type) => process.stderr.write(`Hyper ${type}: ${message}\n`);
	let emit: NotificationSink = emitToStderr;
	let activated = false;

	return {
		notify(message, type) {
			emit(message, type);
		},

		warn(message) {
			if (seenWarnings.has(message)) return;
			seenWarnings.add(message);
			emit(message, "warning");
		},

		activate(ctx) {
			if (activated) return;
			activated = true;
			if (ctx.hasUI) emit = (message, type) => ctx.ui.notify(message, type);
		},
	};
}
