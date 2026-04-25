import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
	GranolaSyncSettings,
	DEFAULT_SETTINGS,
	GranolaSyncSettingTab,
	SYNC_FREQUENCY_MS,
} from "./settings";
import { GranolaAuthProvider, type AuthStorage } from "./auth";
import { GranolaMcpClient, RateLimitError } from "./mcp-client";
import {
	parseMeetingsResponse,
	parseTranscriptResponse,
	parseFoldersResponse,
	buildMeetingData,
} from "./response-parser";
import { loadTemplate, applyTemplate, generateFilename } from "./template";

interface PluginData extends GranolaSyncSettings {
	oauthTokens?: OAuthTokens;
	oauthClientInfo?: OAuthClientInformationMixed;
	autoSyncOnStartup?: boolean;
}

export default class GranolaSyncPlugin extends Plugin {
	settings: GranolaSyncSettings = DEFAULT_SETTINGS;
	private pluginData: PluginData = { ...DEFAULT_SETTINGS };
	private isSyncing = false;
	private syncIntervalId: number | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private authProvider!: GranolaAuthProvider;
	private mcpClient!: GranolaMcpClient;

	override async onload(): Promise<void> {
		await this.loadSettings();

		// Initialize auth + MCP client
		const storage: AuthStorage = {
			getTokens: () => this.pluginData.oauthTokens,
			saveTokens: async (tokens) => {
				this.pluginData.oauthTokens = tokens;
				await this.savePluginData();
			},
			clearTokens: async () => {
				delete this.pluginData.oauthTokens;
				delete this.pluginData.oauthClientInfo;
				await this.savePluginData();
			},
			getClientInfo: () => this.pluginData.oauthClientInfo,
			saveClientInfo: async (info) => {
				this.pluginData.oauthClientInfo = info;
				await this.savePluginData();
			},
		};
		this.authProvider = new GranolaAuthProvider(storage);
		this.mcpClient = new GranolaMcpClient(this.authProvider);

		// Register OAuth callback handler
		this.registerObsidianProtocolHandler("granola-auth", (params) => {
			const code = params.code;
			if (code) {
				void this.handleAuthCallback(code);
			}
		});

		// Add ribbon icon if enabled
		this.updateRibbonIcon();

		// Add commands
		this.addCommand({
			id: "sync-meetings",
			name: "Sync meetings",
			callback: () => void this.syncMeetings(true),
		});

		this.addCommand({
			id: "log-mcp-schemas",
			name: "Debug: log tool schemas to console",
			callback: () => {
				void this.logMcpSchemas();
			},
		});

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				const appWithSetting = this.app as typeof this.app & {
					setting: { open: () => void; openTabById: (id: string) => void };
				};
				appWithSetting.setting.open();
				appWithSetting.setting.openTabById(this.manifest.id);
			},
		});

		// Add settings tab
		this.addSettingTab(new GranolaSyncSettingTab(this.app, this));

		// Handle startup sync and intervals
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncFrequency !== "manual") {
				void this.syncMeetings();
			}
			this.setupSyncInterval();
		});
	}

	override onunload(): void {
		this.clearSyncInterval();
		void this.mcpClient.disconnect();
	}

	setupSyncInterval(): void {
		this.clearSyncInterval();
		const intervalMs = SYNC_FREQUENCY_MS[this.settings.syncFrequency];
		if (intervalMs) {
			this.syncIntervalId = window.setInterval(() => {
				void this.syncMeetings();
			}, intervalMs);
			this.registerInterval(this.syncIntervalId);
		}
	}

	private clearSyncInterval(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	updateRibbonIcon(): void {
		if (this.settings.showRibbonIcon && !this.ribbonIconEl) {
			this.ribbonIconEl = this.addRibbonIcon("calendar-sync", "Sync Granola meetings", () => {
				void this.syncMeetings(true);
			});
		} else if (!this.settings.showRibbonIcon && this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}
	}

	isAuthenticated(): boolean {
		return this.pluginData.oauthTokens !== undefined;
	}

	/**
	 * Return the time_range enum values advertised by the MCP server, or null
	 * if they haven't been discovered yet (e.g. not connected).
	 */
	getAvailableTimeRanges(): string[] | null {
		if (!this.mcpClient) return null;
		return this.mcpClient.getParamEnum("list_meetings", "time_range");
	}

	/**
	 * Whether the Granola MCP server considers time_range a required argument.
	 * Used by the settings UI to decide whether to offer an "unlimited" option.
	 */
	isTimeRangeRequired(): boolean {
		if (!this.mcpClient) return true;
		return this.mcpClient.isTimeRangeRequired();
	}

	async connectAccount(): Promise<void> {
		try {
			await this.mcpClient.connect();
			new Notice("Connected to Granola!");
		} catch {
			// Auth redirect likely happened — user will complete in browser
			new Notice("Opening Granola login in your browser...");
		}
	}

	async disconnectAccount(): Promise<void> {
		await this.mcpClient.disconnect();
		delete this.pluginData.oauthTokens;
		delete this.pluginData.oauthClientInfo;
		await this.savePluginData();
		new Notice("Disconnected from Granola");
	}

	private async handleAuthCallback(code: string): Promise<void> {
		try {
			await this.mcpClient.finishAuth(code);
			new Notice("Successfully connected to Granola!");

			// Refresh settings tab if open
			const appWithSetting = this.app as typeof this.app & {
				setting: { activeTab?: { display?: () => void } };
			};
			appWithSetting.setting.activeTab?.display?.();
		} catch (error) {
			console.error("Granola auth callback failed:", error);
			new Notice("Failed to connect to Granola. Please try again.");
		}
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		this.pluginData = { ...DEFAULT_SETTINGS, ...data };
		this.settings = { ...DEFAULT_SETTINGS, ...data };

		// Migrate old autoSyncOnStartup setting
		if (data?.autoSyncOnStartup !== undefined && !data.syncFrequency) {
			this.settings.syncFrequency = data.autoSyncOnStartup ? "startup" : "manual";
		}
	}

	async saveSettings(): Promise<void> {
		Object.assign(this.pluginData, this.settings);
		await this.savePluginData();
	}

	private async savePluginData(): Promise<void> {
		await this.saveData(this.pluginData);
	}

	private async logMcpSchemas(): Promise<void> {
		if (!this.isAuthenticated()) {
			new Notice("Connect to Granola first in settings.");
			return;
		}
		if (!this.mcpClient.isConnected) {
			try {
				await this.mcpClient.connect();
			} catch (error) {
				new Notice("Failed to connect to Granola.");
				console.error("Granola: debug connect failed", error);
				return;
			}
		}
		const schemas = this.mcpClient.getAllToolSchemas();

		// Log to console at info level so users don't need to enable
		// "Verbose" in devtools to see the output. Console output is
		// otherwise restricted; this command is explicitly user-triggered
		// for debugging.
		/* eslint-disable no-console */
		console.log("=== Granola MCP tool schemas ===");
		for (const [name, schema] of Object.entries(schemas)) {
			console.log(`— ${name} —`, schema);
		}
		console.log("===============================");
		/* eslint-enable no-console */

		// Also write a JSON dump to the vault so users can inspect schemas
		// without devtools. Stored next to the meetings folder.
		const folderPath = normalizePath(
			this.settings.folderPath || DEFAULT_SETTINGS.folderPath,
		);
		const dumpPath = normalizePath(`${folderPath}/.granola-debug-schemas.json`);
		const dump = {
			generatedAt: new Date().toISOString(),
			pluginVersion: this.manifest.version,
			settingsSnapshot: {
				syncTimeRange: this.settings.syncTimeRange,
				syncTranscripts: this.settings.syncTranscripts,
				syncFrequency: this.settings.syncFrequency,
			},
			schemas,
		};
		try {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder) {
				await this.app.vault.createFolder(folderPath);
			}
			const existing = this.app.vault.getAbstractFileByPath(dumpPath);
			const json = JSON.stringify(dump, null, 2);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, json);
			} else {
				await this.app.vault.create(dumpPath, json);
			}
		} catch (error) {
			console.warn("Granola: failed to write schema dump", error);
		}

		// Surface the most actionable answer (list_meetings time_range +
		// required) directly in a Notice so the user never has to leave
		// Obsidian.
		const listMeetings = schemas["list_meetings"] as
			| { properties?: Record<string, { enum?: unknown }>; required?: unknown }
			| undefined;
		const enumValues = Array.isArray(listMeetings?.properties?.time_range?.enum)
			? (listMeetings.properties.time_range.enum as unknown[])
				.filter((v): v is string => typeof v === "string")
			: [];
		const required = Array.isArray(listMeetings?.required)
			? listMeetings.required.includes("time_range")
			: false;
		const enumStr = enumValues.length > 0 ? enumValues.join(", ") : "(none)";
		new Notice(
			`Granola schema: time_range enum = [${enumStr}], required = ${required ? "yes" : "no"}. Full dump: ${dumpPath}`,
			15_000,
		);
	}

	/**
	 * Build a map of meeting_id -> folder title by iterating Granola folders
	 * and listing their meetings. Fails gracefully if the user is on a plan
	 * that doesn't support folders.
	 */
	private async buildFolderMap(): Promise<Map<string, string>> {
		const map = new Map<string, string>();
		if (!this.mcpClient.hasTool("list_meeting_folders")) {
			return map;
		}

		let folders: Array<{ id: string; title: string }>;
		try {
			const response = await this.mcpClient.listMeetingFolders();
			folders = parseFoldersResponse(response);
		} catch (error) {
			// Likely a free/basic plan or transient error — skip folder sync.
			console.warn("Granola: folder sync skipped", error);
			return map;
		}

		const supportsFolderFilter = this.mcpClient.hasToolParam("list_meetings", "folder_id");
		if (!supportsFolderFilter) {
			return map;
		}

		for (const folder of folders) {
			try {
				const response = await this.mcpClient.listMeetings(
					this.settings.syncTimeRange,
					folder.id,
				);
				const meetings = parseMeetingsResponse(response);
				for (const meeting of meetings) {
					// First folder wins if a meeting appears in multiple.
					if (!map.has(meeting.id)) {
						map.set(meeting.id, folder.title);
					}
				}
			} catch (error) {
				if (error instanceof RateLimitError) {
					console.warn(
						"Granola: folder listing rate limited; returning partial folder map",
						error,
					);
					break;
				}
				console.warn(`Granola: listMeetings for folder ${folder.title} failed`, error);
			}
		}

		return map;
	}

	async syncMeetings(manual = false): Promise<void> {
		if (this.isSyncing) return;
		this.isSyncing = true;

		// Reset the rate-limit circuit breaker so a cool-down from a previous
		// sync doesn't spuriously short-circuit this run.
		this.mcpClient.resetRateLimitCircuit();

		try {
			await this.doSync(manual);
		} finally {
			this.isSyncing = false;
		}
	}

	private async doSync(manual: boolean): Promise<void> {
		if (!this.isAuthenticated()) {
			if (manual) {
				new Notice("Please connect your Granola account first in plugin settings");
			}
			return;
		}

		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const templatePath = this.settings.templatePath || DEFAULT_SETTINGS.templatePath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;

		// Connect to MCP if needed
		if (!this.mcpClient.isConnected) {
			try {
				await this.mcpClient.connect();
			} catch (error) {
				if (manual) {
					new Notice("Failed to connect to Granola. Please re-authenticate in settings.");
				}
				console.error("Granola: connect failed", error);
				return;
			}
		}

		// List meetings
		let listResponse: string;
		try {
			listResponse = await this.mcpClient.listMeetings(this.settings.syncTimeRange);
		} catch (error) {
			if (error instanceof RateLimitError) {
				if (manual) new Notice("Granola rate limit hit — please try again in a minute.");
				console.warn("Granola: listMeetings rate limited", error);
				return;
			}
			if (manual) {
				const hint = this.settings.syncTimeRange === "__all_time__"
					? " Your plan may not support unlimited history — try \"Last 30 days\" instead."
					: "";
				new Notice(`Failed to fetch meetings from Granola.${hint}`);
			}
			console.error("Granola: listMeetings failed", error);
			// Disconnect so we retry connection next time
			await this.mcpClient.disconnect();
			return;
		}

		const listedMeetings = parseMeetingsResponse(listResponse);
		if (listedMeetings.length === 0) {
			if (manual) new Notice("No meetings found in Granola");
			return;
		}

		// Build meeting_id -> folder map by iterating folders. Paid-plan only; fails
		// silently on free plans.
		const meetingIdToFolder = await this.buildFolderMap();

		// Load template
		let template: string;
		try {
			template = await loadTemplate(this.app, templatePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error loading template: ${message}`);
			return;
		}

		// Ensure folder exists
		const folderPath = normalizePath(folderPathSetting);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			try {
				await this.app.vault.createFolder(folderPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				new Notice(`Error creating folder: ${message}`);
				return;
			}
		}

		// Build map of existing granola_id -> file
		const existingDocs = new Map<string, TFile>();
		const files = this.app.vault.getMarkdownFiles();
		const folderPrefix = folderPath + "/";
		for (const file of files) {
			if (!file.path.startsWith(folderPrefix)) continue;
			const fileCache = this.app.metadataCache.getFileCache(file);
			const granolaId = fileCache?.frontmatter?.granola_id as string | undefined;
			if (granolaId) {
				existingDocs.set(granolaId, file);
			}
		}

		// Filter to meetings that need syncing
		const meetingsToSync = listedMeetings.filter((m) => {
			if (this.settings.skipExistingNotes && existingDocs.has(m.id)) {
				return false;
			}
			return true;
		});

		if (meetingsToSync.length === 0) {
			if (manual) {
				new Notice(`All ${listedMeetings.length} meetings already synced`);
			}
			return;
		}

		// Build map of email -> note title for attendee matching
		const emailToNoteTitle = new Map<string, string>();
		if (this.settings.matchAttendeesByEmail) {
			for (const file of files) {
				const fileCache = this.app.metadataCache.getFileCache(file);
				const emails: unknown = fileCache?.frontmatter?.emails;
				if (Array.isArray(emails)) {
					for (const email of emails) {
						if (typeof email === "string") {
							emailToNoteTitle.set(email.toLowerCase(), file.basename);
						}
					}
				} else if (typeof emails === "string") {
					emailToNoteTitle.set(emails.toLowerCase(), file.basename);
				}
			}
		}

		// Batch fetch meeting details (max 10 per API call)
		const idsToFetch = meetingsToSync.map((m) => m.id);
		const allDetails = [];

		let rateLimitHit = false;
		for (let i = 0; i < idsToFetch.length; i += 10) {
			const batch = idsToFetch.slice(i, i + 10);
			try {
				const detailsResponse = await this.mcpClient.getMeetings(batch);
				allDetails.push(...parseMeetingsResponse(detailsResponse));
			} catch (error) {
				if (error instanceof RateLimitError) {
					console.warn("Granola: getMeetings rate limited, aborting remaining batches", error);
					rateLimitHit = true;
					break;
				}
				console.error("Granola: getMeetings batch failed", error);
			}
		}

		let created = 0;
		let updated = 0;
		const skipped = listedMeetings.length - meetingsToSync.length;

		for (const details of allDetails) {
			try {
				// Skip meetings still in progress (no summary generated yet)
				if (!details.summary.trim() || details.summary.trim() === "No summary") {
					continue;
				}

				// Optionally fetch transcript
				let transcript = "";
				if (this.settings.syncTranscripts && !rateLimitHit) {
					try {
						const transcriptResponse = await this.mcpClient.getTranscript(details.id);
						transcript = parseTranscriptResponse(transcriptResponse);
					} catch (error) {
						if (error instanceof RateLimitError) {
							console.warn("Granola: transcript fetch rate limited, skipping remaining transcripts");
							rateLimitHit = true;
						} else {
							console.error(`Granola: transcript fetch failed for ${details.id}`, error);
						}
					}
				}

				const folder = meetingIdToFolder.get(details.id) ?? "";
				const meetingData = buildMeetingData(details, transcript, folder);
				const content = applyTemplate(template, meetingData, emailToNoteTitle);
				const existingFile = existingDocs.get(details.id);

				if (existingFile) {
					await this.app.vault.modify(existingFile, content);
					updated++;
				} else {
					const filename = generateFilename(filenamePattern, meetingData);
					const filePath = normalizePath(`${folderPath}/${filename}.md`);
					await this.app.vault.create(filePath, content);
					created++;
				}
			} catch (error) {
				console.error(`Error syncing meeting ${details.id}:`, error);
			}
		}

		if (manual) {
			const suffix = rateLimitHit ? " — Granola rate limit hit, try again soon" : "";
			if (this.settings.skipExistingNotes) {
				new Notice(`Synced ${created} new meeting${created !== 1 ? "s" : ""} (${skipped} skipped)${suffix}`);
			} else {
				new Notice(`Synced ${created} new, ${updated} updated meeting${created + updated !== 1 ? "s" : ""}${suffix}`);
			}
		} else if (rateLimitHit) {
			new Notice("Granola rate limit hit during sync — some meetings will retry next cycle.");
		}
	}
}
