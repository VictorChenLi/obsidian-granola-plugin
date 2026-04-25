import { App, PluginSettingTab, Setting } from "obsidian";
import type GranolaSyncPlugin from "./main";
import { UNLIMITED_TIME_RANGE, type SyncTimeRange } from "./mcp-client";

export type SyncFrequency = "manual" | "startup" | "1m" | "15m" | "30m" | "60m" | "12h";

export const SYNC_FREQUENCY_OPTIONS: Record<SyncFrequency, string> = {
	manual: "Manual only (command palette)",
	startup: "Sync on startup only",
	"1m": "Every 1 minute",
	"15m": "Every 15 minutes",
	"30m": "Every 30 minutes",
	"60m": "Every 60 minutes",
	"12h": "Every 12 hours",
};

export const SYNC_FREQUENCY_MS: Record<SyncFrequency, number | null> = {
	manual: null,
	startup: null,
	"1m": 60 * 1000,
	"15m": 15 * 60 * 1000,
	"30m": 30 * 60 * 1000,
	"60m": 60 * 60 * 1000,
	"12h": 12 * 60 * 60 * 1000,
};

// Friendly labels for known time_range enum values. Any values the MCP server
// advertises that aren't in this map fall back to an auto-generated label.
const SYNC_TIME_RANGE_LABELS: Record<string, string> = {
	today: "Today",
	yesterday: "Yesterday",
	this_week: "This week",
	last_week: "Last week",
	this_month: "This month",
	last_month: "Last month",
	last_7_days: "Last 7 days",
	last_14_days: "Last 14 days",
	last_30_days: "Last 30 days",
	last_60_days: "Last 60 days",
	last_90_days: "Last 90 days",
	last_180_days: "Last 180 days",
	last_6_months: "Last 6 months",
	last_year: "Last year",
	last_12_months: "Last 12 months",
	[UNLIMITED_TIME_RANGE]: "All time",
	custom: "Custom range",
};

const DEFAULT_TIME_RANGE_OPTIONS = [
	"this_week",
	"last_week",
	"last_30_days",
];

function humanizeTimeRange(value: string): string {
	if (SYNC_TIME_RANGE_LABELS[value]) return SYNC_TIME_RANGE_LABELS[value];
	return value
		.split("_")
		.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

function todayIsoDate(): string {
	return toIsoDate(new Date());
}

function daysAgoIsoDate(days: number): string {
	return toIsoDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

function toIsoDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export interface GranolaSyncSettings {
	folderPath: string;
	filenamePattern: string;
	templatePath: string;
	syncFrequency: SyncFrequency;
	showRibbonIcon: boolean;
	skipExistingNotes: boolean;
	matchAttendeesByEmail: boolean;
	syncTimeRange: SyncTimeRange;
	/**
	 * ISO date (YYYY-MM-DD) for custom range start. Used only when
	 * `syncTimeRange === "custom"`. Empty string when unset.
	 */
	customStart: string;
	/**
	 * ISO date (YYYY-MM-DD) for custom range end. Used only when
	 * `syncTimeRange === "custom"`. Empty string when unset.
	 */
	customEnd: string;
	syncTranscripts: boolean;
}

export const DEFAULT_SETTINGS: GranolaSyncSettings = {
	folderPath: "Meetings",
	filenamePattern: "{date} {title}",
	templatePath: "Templates/Granola.md",
	syncFrequency: "15m",
	showRibbonIcon: true,
	skipExistingNotes: true,
	matchAttendeesByEmail: true,
	syncTimeRange: "last_30_days",
	customStart: "",
	customEnd: "",
	syncTranscripts: false,
};

export class GranolaSyncSettingTab extends PluginSettingTab {
	plugin: GranolaSyncPlugin;

	constructor(app: App, plugin: GranolaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Granola account section ---
		new Setting(containerEl).setName("Granola account").setHeading();

		if (this.plugin.isAuthenticated()) {
			new Setting(containerEl)
				.setName("Connected to Granola")
				.setDesc("Your account is connected and ready to sync.")
				.addButton((button) =>
					button
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							await this.plugin.disconnectAccount();
							this.display();
						})
				);
		} else {
			new Setting(containerEl)
				.setName("Not connected")
				.setDesc("Connect your Granola account to sync meetings via the official API.")
				.addButton((button) =>
					button
						.setButtonText("Connect to Granola")
						.setCta()
						.onClick(() => {
							void this.plugin.connectAccount();
						})
				);
		}

		// --- Sync section ---
		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Manually sync meetings from Granola")
			.addButton((button) =>
				button
					.setButtonText("Sync now")
					.setCta()
					.onClick(() => {
						void this.plugin.syncMeetings(true);
					})
			);

		new Setting(containerEl)
			.setName("Time range")
			.setDesc(
				"How far back to look for meetings when syncing. Preset ranges come from Granola's API; pick \"all time\" to fetch every meeting, or \"custom range\" to choose your own start and end dates.",
			)
			.addDropdown((dropdown) => {
				const discovered = this.plugin.getAvailableTimeRanges();
				const base = discovered && discovered.length > 0
					? [...discovered]
					: [...DEFAULT_TIME_RANGE_OPTIONS];
				// Always offer the unlimited sentinel in addition to the
				// server-advertised enum, unless we know the server requires
				// time_range.
				if (!this.plugin.isTimeRangeRequired()) {
					base.push(UNLIMITED_TIME_RANGE);
				}
				const current = this.plugin.settings.syncTimeRange;
				if (current && !base.includes(current)) {
					base.unshift(current);
				}
				for (const value of base) {
					dropdown.addOption(value, humanizeTimeRange(value));
				}
				dropdown
					.setValue(current)
					.onChange(async (value) => {
						this.plugin.settings.syncTimeRange = value;
						// Seed sensible defaults the first time the user
						// switches to "custom" so the date pickers aren't
						// blank.
						if (value === "custom") {
							if (!this.plugin.settings.customEnd) {
								this.plugin.settings.customEnd = todayIsoDate();
							}
							if (!this.plugin.settings.customStart) {
								this.plugin.settings.customStart =
									daysAgoIsoDate(30);
							}
						}
						await this.plugin.saveSettings();
						// Re-render so custom date pickers show/hide.
						this.display();
					});
			});

		// Custom range pickers — only shown when "custom" is selected.
		if (this.plugin.settings.syncTimeRange === "custom") {
			new Setting(containerEl)
				.setName("Custom start date")
				.setDesc("Earliest meeting date to include (inclusive).")
				.addText((text) => {
					text.inputEl.type = "date";
					text.setValue(this.plugin.settings.customStart)
						.onChange(async (value) => {
							this.plugin.settings.customStart = value;
							await this.plugin.saveSettings();
						});
				});
			new Setting(containerEl)
				.setName("Custom end date")
				.setDesc("Latest meeting date to include (inclusive).")
				.addText((text) => {
					text.inputEl.type = "date";
					text.setValue(this.plugin.settings.customEnd)
						.onChange(async (value) => {
							this.plugin.settings.customEnd = value;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName("Sync frequency")
			.setDesc("How often to automatically sync meetings from Granola")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(SYNC_FREQUENCY_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.syncFrequency)
					.onChange(async (value) => {
						this.plugin.settings.syncFrequency = value as SyncFrequency;
						await this.plugin.saveSettings();
						this.plugin.setupSyncInterval();
					});
			});

		new Setting(containerEl)
			.setName("Sync transcripts")
			.setDesc(
				"Include full meeting transcripts. Each meeting requires an extra API call."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncTranscripts)
					.onChange(async (value) => {
						this.plugin.settings.syncTranscripts = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Notes section ---
		new Setting(containerEl).setName("Notes").setHeading();

		new Setting(containerEl)
			.setName("Folder path")
			.setDesc("Where to save meeting notes in your vault")
			.addText((text) =>
				text
					.setPlaceholder("Meetings")
					.setValue(this.plugin.settings.folderPath)
					.onChange(async (value) => {
						this.plugin.settings.folderPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Filename pattern")
			.setDesc("Pattern for note filenames. Available: {date}, {title}, {id}")
			.addText((text) =>
				text
					.setPlaceholder("{date} {title}")
					.setValue(this.plugin.settings.filenamePattern)
					.onChange(async (value) => {
						this.plugin.settings.filenamePattern = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Template path")
			.setDesc("Path to template file in your vault")
			.addText((text) =>
				text
					.setPlaceholder("Templates/granola-meeting.md")
					.setValue(this.plugin.settings.templatePath)
					.onChange(async (value) => {
						this.plugin.settings.templatePath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show ribbon icon")
			.setDesc("Show a sync button in the left ribbon")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRibbonIcon)
					.onChange(async (value) => {
						this.plugin.settings.showRibbonIcon = value;
						await this.plugin.saveSettings();
						this.plugin.updateRibbonIcon();
					})
			);

		new Setting(containerEl)
			.setName("Skip existing notes")
			.setDesc(
				"When enabled, existing notes won't be overwritten. Disable to update notes when Granola data changes."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.skipExistingNotes)
					.onChange(async (value) => {
						this.plugin.settings.skipExistingNotes = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Match attendees by email")
			.setDesc(
				"Link attendees to existing notes that have a matching email in their 'emails' frontmatter property."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.matchAttendeesByEmail)
					.onChange(async (value) => {
						this.plugin.settings.matchAttendeesByEmail = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
