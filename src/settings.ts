import { App, PluginSettingTab, Setting } from "obsidian";
import type GranolaSyncPlugin from "./main";

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

export interface GranolaSyncSettings {
	folderPath: string;
	filenamePattern: string;
	templatePath: string;
	syncFrequency: SyncFrequency;
	showRibbonIcon: boolean;
	skipExistingNotes: boolean;
	matchAttendeesByEmail: boolean;
}

export const DEFAULT_SETTINGS: GranolaSyncSettings = {
	folderPath: "Meetings",
	filenamePattern: "{date} {title}",
	templatePath: "Templates/Granola.md",
	syncFrequency: "15m",
	showRibbonIcon: true,
	skipExistingNotes: true,
	matchAttendeesByEmail: true,
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
				"When enabled, existing notes won't be overwritten. This allows you to make local edits without them being replaced on sync. Disable to update notes when Granola data changes."
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
