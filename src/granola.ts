import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import StarterKit from "@tiptap/starter-kit";
import {
	renderToMarkdown,
	serializeChildrenToHTMLString,
} from "@tiptap/static-renderer";
import type { Node } from "@tiptap/pm/model";

export interface GranolaDocument {
	id: string;
	user_id: string;
	title: string | null;
	created_at: string;
	updated_at: string;
	deleted_at?: string | null;
	notes_markdown?: string;
	notes?: ProseMirrorDoc;
	people?: {
		attendees?: Array<{
			name?: string;
			email?: string;
			details?: {
				person?: {
					name?: {
						fullName?: string;
					};
				};
			};
		}>;
	};
}

export interface GranolaPanel {
	title: string;
	content: ProseMirrorDoc;
}

export interface TranscriptEntry {
	start_timestamp: string;
	end_timestamp: string;
	text: string;
	source: string;
}

interface ProseMirrorDoc {
	type: string;
	content?: unknown[];
}

export interface GranolaCache {
	documents: Record<string, GranolaDocument>;
	documentPanels: Record<string, Record<string, GranolaPanel>>;
	transcripts: Record<string, TranscriptEntry[]>;
}

function parseJson<T>(json: string): T {
	return JSON.parse(json) as T;
}

function getGranolaDir(): string {
	if (process.platform === "win32") {
		return join(homedir(), "AppData/Roaming/Granola");
	} else if (process.platform === "linux") {
		return join(homedir(), ".config/Granola");
	} else {
		return join(homedir(), "Library/Application Support/Granola");
	}
}

export function getCurrentUserId(): string | null {
	try {
		const authFile = join(getGranolaDir(), "supabase.json");
		const auth = parseJson<{ user_info?: string }>(
			readFileSync(authFile, "utf-8"),
		);
		const userInfo = parseJson<{ id?: string }>(auth.user_info || "{}");
		return userInfo.id || null;
	} catch (e) {
		console.debug("Granola: could not read user auth", e);
		return null;
	}
}

export function readGranolaCache(): GranolaCache | null {
	try {
		const cacheFile = join(getGranolaDir(), "cache-v3.json");
		const raw = readFileSync(cacheFile, "utf-8");
		const data = parseJson<{ cache?: string }>(raw);
		const cache = parseJson<{
			state?: {
				documents?: Record<string, GranolaDocument>;
				documentPanels?: Record<string, Record<string, GranolaPanel>>;
				transcripts?: Record<string, TranscriptEntry[]>;
			};
		}>(data.cache || "{}");
		return {
			documents: cache.state?.documents || {},
			documentPanels: cache.state?.documentPanels || {},
			transcripts: cache.state?.transcripts || {},
		};
	} catch (e) {
		console.debug("Granola: could not read cache", e);
		return null;
	}
}

const extensions = [StarterKit];

// Helper to recursively render list content with proper indentation
function renderListContent(node: Node, depth: number): string {
	const result: string[] = [];

	// This assumes 4-space indent, not sure of a way to detect user's preferred
	// indentation style in Obsidian.
	const indent = "    ".repeat(depth);

	node.forEach((child) => {
		if (child.type.name === "listItem") {
			const itemContent: string[] = [];
			child.forEach((itemChild) => {
				if (
					itemChild.type.name === "bulletList" ||
					itemChild.type.name === "orderedList"
				) {
					// Nested list - render with increased depth
					itemContent.push(renderListContent(itemChild, depth + 1));
				} else if (itemChild.type.name === "paragraph") {
					// Text content
					itemContent.push(itemChild.textContent);
				} else {
					itemContent.push(itemChild.textContent);
				}
			});
			// First item gets the bullet, rest are nested lists
			const [firstContent, ...nestedLists] = itemContent;
			result.push(`${indent}- ${firstContent || ""}`);
			nestedLists.forEach((nested) => {
				if (nested) result.push(nested);
			});
		}
	});

	return result.join("\n");
}

export function prosemirrorToMarkdown(
	doc: ProseMirrorDoc | null | undefined,
): string {
	if (!doc?.content?.length) return "";
	try {
		return renderToMarkdown({
			content: doc as unknown as Parameters<
				typeof renderToMarkdown
			>[0]["content"],
			extensions,
			options: {
				nodeMapping: {
					bulletList({ node }) {
						return "\n" + renderListContent(node, 0) + "\n";
					},
					orderedList({ children }) {
						// Fall back to default for ordered lists
						return "\n" + serializeChildrenToHTMLString(children);
					},
					listItem({ children }) {
						// This won't be called for bullet lists since we handle them in bulletList
						return serializeChildrenToHTMLString(children);
					},
				},
			},
		});
	} catch (e) {
		console.debug("Granola: could not convert ProseMirror to markdown", e);
		return "";
	}
}

export function formatPanels(
	panels: Record<string, GranolaPanel> | undefined,
): string {
	if (!panels) return "";
	return Object.values(panels)
		.map((panel) => {
			const content = prosemirrorToMarkdown(panel.content).trim();
			if (!content) return "";
			return `## ${panel.title}\n\n${content}`;
		})
		.filter((s) => s)
		.join("\n\n");
}

export function formatTranscript(
	entries: TranscriptEntry[] | undefined,
): string {
	if (!entries?.length) return "";

	const groups: { speaker: string; timestamp: Date; texts: string[] }[] = [];
	let currentGroup: {
		speaker: string;
		timestamp: Date;
		texts: string[];
	} | null = null;

	for (const entry of entries) {
		const speaker = entry.source === "microphone" ? "You" : "Them";
		const timestamp = new Date(entry.start_timestamp);

		if (!currentGroup || currentGroup.speaker !== speaker) {
			currentGroup = { speaker, timestamp, texts: [] };
			groups.push(currentGroup);
		}
		currentGroup.texts.push(entry.text);
	}

	return groups
		.map((group) => {
			const timeStr = group.timestamp.toLocaleTimeString([], {
				hour: "numeric",
				minute: "2-digit",
				second: "2-digit",
			});
			return `**${group.speaker}** (${timeStr})\n${group.texts.join(" ")}`;
		})
		.join("\n\n");
}

export function getAttendeeNames(doc: GranolaDocument): string[] {
	return (
		doc.people?.attendees
			?.map(
				(a) =>
					a.name ||
					a.details?.person?.name?.fullName ||
					a.email ||
					"Unknown",
			)
			.filter((name) => name !== "Unknown") || []
	);
}

export function getMeetingTimes(
	transcript: TranscriptEntry[] | undefined,
): { startTime: string; endTime: string; duration: string } | null {
	if (!transcript?.length) return null;

	const firstEntry = transcript[0];
	const lastEntry = transcript[transcript.length - 1];

	const startTime = new Date(firstEntry.start_timestamp);
	const endTime = new Date(lastEntry.end_timestamp);

	const startTimeStr = startTime.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
	const endTimeStr = endTime.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});

	const durationMs = endTime.getTime() - startTime.getTime();
	const durationMins = Math.round(durationMs / 60000);
	const durationStr =
		durationMins < 60
			? `${durationMins} min`
			: `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`;

	return {
		startTime: startTimeStr,
		endTime: endTimeStr,
		duration: durationStr,
	};
}
