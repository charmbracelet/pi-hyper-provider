import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { hyperProviderDir } from "./hyper.js";
import type { WarningSink } from "./notify.js";

const HyperStatusItemsSchema = Type.Object(
	{
		teamName: Type.Optional(Type.Boolean()),
		hypercredits: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export type HyperStatusItems = Required<Static<typeof HyperStatusItemsSchema>>;

const DEFAULT_STATUS_ITEMS: HyperStatusItems = {
	teamName: false,
	hypercredits: true,
};

function settingsPath(): string {
	return path.join(hyperProviderDir(), "settings.json");
}

function legacySettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

export function readHyperStatusItems(warn?: WarningSink): HyperStatusItems {
	const settings = readSettingsObject();
	const statusItems = property(settings, "statusItems");
	if (statusItems !== undefined) {
		return (
			parseHyperStatusItems(statusItems, "statusItems in hyper-provider/settings.json", warn) ??
			readLegacyHyperStatusItems(warn) ?? { ...DEFAULT_STATUS_ITEMS }
		);
	}

	return readLegacyHyperStatusItems(warn) ?? { ...DEFAULT_STATUS_ITEMS };
}

export function writeHyperStatusItems(statusItems: HyperStatusItems): void {
	const settings = readSettingsObject();
	settings.statusItems = statusItems;

	mkdirSync(hyperProviderDir(), { recursive: true });
	writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

export function migrateHyperSettings(warn?: WarningSink): void {
	const legacySettings = readSettingsObject(legacySettingsPath());
	const legacyHyper = propertyObject(legacySettings, "hyper");
	if (!legacyHyper) return;

	const legacyStatusItems = parseHyperStatusItems(
		property(legacyHyper, "statusItems"),
		"hyper.statusItems in settings.json",
		warn,
	);
	const settings = readSettingsObject();
	const statusItems = property(settings, "statusItems");
	let hasUsableStatusItems =
		parseHyperStatusItems(statusItems, "statusItems in hyper-provider/settings.json", warn) !== undefined;

	if (statusItems === undefined && legacyStatusItems !== undefined) {
		settings.statusItems = legacyStatusItems;
		writeSettingsObject(settingsPath(), settings);
		hasUsableStatusItems = true;
	}
	if (!hasUsableStatusItems) return;

	removeLegacyHyperStatusItems();
}

export function defaultHyperStatusItems(): HyperStatusItems {
	return { ...DEFAULT_STATUS_ITEMS };
}

function readSettingsObject(filePath = settingsPath()): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
	const payload = JSON.parse(readFileSync(filePath, "utf-8"));
	if (!isRecord(payload)) throw new Error(`${filePath} must contain a JSON object`);
	return payload;
}

function writeSettingsObject(filePath: string, settings: Record<string, unknown>): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function removeLegacyHyperStatusItems(): void {
	const legacySettings = readSettingsObject(legacySettingsPath());
	const legacyHyper = propertyObject(legacySettings, "hyper");
	if (!legacyHyper || property(legacyHyper, "statusItems") === undefined) return;

	delete legacyHyper.statusItems;
	if (Object.keys(legacyHyper).length === 0) {
		delete legacySettings.hyper;
	}
	writeSettingsObject(legacySettingsPath(), legacySettings);
}

function readLegacyHyperStatusItems(warn?: WarningSink): HyperStatusItems | undefined {
	const legacySettings = readSettingsObject(legacySettingsPath());
	const legacyHyper = propertyObject(legacySettings, "hyper");
	return legacyHyper
		? parseHyperStatusItems(property(legacyHyper, "statusItems"), "hyper.statusItems in settings.json", warn)
		: undefined;
}

function parseHyperStatusItems(value: unknown, source: string, warn?: WarningSink): HyperStatusItems | undefined {
	if (value === undefined) return undefined;
	if (!Value.Check(HyperStatusItemsSchema, value)) {
		warn?.(`Ignoring invalid ${source}`);
		return undefined;
	}

	return {
		...DEFAULT_STATUS_ITEMS,
		...Value.Parse(HyperStatusItemsSchema, value),
	};
}

function property(source: Record<string, unknown>, key: string): unknown {
	return Object.getOwnPropertyDescriptor(source, key)?.value;
}

function propertyObject(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const value = property(source, key);
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
