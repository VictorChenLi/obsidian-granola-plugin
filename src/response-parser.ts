export interface ParsedParticipant {
	name: string;
	email: string;
	organization: string;
	isCreator: boolean;
}

export interface ParsedMeeting {
	id: string;
	title: string;
	date: string; // raw from API, e.g. "Mar 3, 2026 3:00 PM"
	participants: ParsedParticipant[];
}

export interface ParsedMeetingDetails extends ParsedMeeting {
	privateNotes: string;
	summary: string; // already markdown
}

export interface MeetingData {
	id: string;
	title: string;
	date: string; // ISO date "2026-03-03"
	startTime: string; // e.g. "3:00 PM"
	created: string; // ISO datetime
	url: string;
	privateNotes: string;
	enhancedNotes: string;
	transcript: string;
	participants: ParsedParticipant[];
	folder: string; // Granola folder title (empty string if unknown)
}

export interface ParsedFolder {
	id: string;
	title: string;
	description: string;
	noteCount: number;
}

/**
 * Parse the XML-ish list_meetings / get_meetings response into meeting objects.
 * When called on get_meetings response, also extracts private_notes and summary.
 */
export function parseMeetingsResponse(xml: string): ParsedMeetingDetails[] {
	const meetings: ParsedMeetingDetails[] = [];
	const meetingRegex = /<meeting\s+id="([^"]+)"\s+title="([^"]*?)"\s+date="([^"]*?)">([\s\S]*?)<\/meeting>/g;

	let match;
	while ((match = meetingRegex.exec(xml)) !== null) {
		const [, id, title, date, body] = match;

		const participantsMatch = body.match(/<known_participants>\s*([\s\S]*?)\s*<\/known_participants>/);
		const participants = participantsMatch ? parseParticipants(participantsMatch[1].trim()) : [];

		const notesMatch = body.match(/<private_notes>\s*([\s\S]*?)\s*<\/private_notes>/);
		const privateNotes = notesMatch ? notesMatch[1].trim() : "";

		const summaryMatch = body.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/);
		const summary = summaryMatch ? summaryMatch[1].trim() : "";

		meetings.push({ id, title, date, participants, privateNotes, summary });
	}

	return meetings;
}

/**
 * Parse participant string like:
 * "Phil Freo (note creator) from Close <phil@close.com>, Barrett King from Close <barrett.king@close.com>"
 */
export function parseParticipants(text: string): ParsedParticipant[] {
	if (!text.trim()) return [];

	// Split by comma followed by a space and uppercase letter (start of next name)
	const parts = text.split(/,\s*(?=[A-Z])/);

	return parts.map((part) => {
		part = part.trim();

		const emailMatch = part.match(/<([^>]+)>/);
		const email = emailMatch ? emailMatch[1] : "";

		const isCreator = part.includes("(note creator)");

		// Remove email and (note creator) marker
		let nameStr = part
			.replace(/<[^>]+>/, "")
			.replace(/\(note creator\)/g, "")
			.trim();

		let organization = "";
		const fromMatch = nameStr.match(/^(.+?)\s+from\s+(.+)$/);
		if (fromMatch) {
			nameStr = fromMatch[1].trim();
			organization = fromMatch[2].trim();
		}

		return { name: nameStr, email, organization, isCreator };
	}).filter((p) => p.name || p.email);
}

/**
 * Parse transcript response (JSON with id, title, transcript fields).
 *
 * The `transcript` field may come back as:
 *   - a single string (often with speaker labels separated by double spaces)
 *   - an array of segments like `{ speaker, text, start_ms, end_ms }`
 *
 * Returns empty string if the payload is actually a rate-limit / error message
 * so we don't persist "Rate limit exceeded..." into meeting notes.
 */
export function parseTranscriptResponse(text: string): string {
	try {
		const data = JSON.parse(text) as { transcript?: unknown; segments?: unknown };
		const value = data.transcript ?? data.segments;
		if (typeof value === "string") {
			return value.trim();
		}
		if (Array.isArray(value)) {
			return segmentsToString(value);
		}
		return "";
	} catch {
		// Not JSON. Be defensive: the MCP server sometimes returns a plain-text
		// error (e.g. "Rate limit exceeded. Please slow down requests.") which
		// should not be saved as if it were a transcript.
		const trimmed = text.trim();
		if (/^(rate[\s-]?limit|too many requests|please slow down|error:|unauthorized)/i.test(trimmed)) {
			return "";
		}
		return trimmed;
	}
}

/**
 * Join transcript segment objects into a delimited string that
 * `formatTranscriptText` can normalize into paragraphs.
 */
function segmentsToString(segments: unknown[]): string {
	const parts: string[] = [];
	for (const seg of segments) {
		if (!seg || typeof seg !== "object") continue;
		const s = seg as Record<string, unknown>;
		const speaker = typeof s.speaker === "string" && s.speaker.trim()
			? s.speaker.trim()
			: typeof s.source === "string" && s.source.trim()
			? s.source.trim()
			: "";
		const text = typeof s.text === "string"
			? s.text.trim()
			: typeof s.content === "string"
			? s.content.trim()
			: "";
		if (!text) continue;
		parts.push(speaker ? `${speaker}: ${text}` : text);
	}
	return parts.join("\n\n");
}

// Matches a speaker label at the start of a chunk: "Me:", "Them:", "Phil Freo:",
// "Speaker 1:". Kept intentionally narrow (<=40 chars, letters/digits/space/.'-)
// so we don't mistake arbitrary prose ending in a colon for a speaker turn.
const SPEAKER_LABEL_RE = /([A-Z][A-Za-z0-9.'\- ]{0,40}):/;

/**
 * Format raw transcript text for readable Markdown output.
 *
 * Granola's MCP transcript often arrives as one long string with speaker
 * turns separated by two or more spaces (e.g. "  Me: hi  Them: hello"). We
 * also try to handle:
 *   - already-newline-delimited transcripts (preserve their breaks),
 *   - generic speaker names, not just "Me:"/"Them:",
 *   - timestamp markers like "[00:12:34]" or "(0:12)",
 *   - plain prose with no structure (fall back to paragraphing by sentences).
 */
export function formatTranscriptText(raw: string): string {
	if (!raw) return "";
	let text = raw.replace(/\r\n/g, "\n").trim();
	if (!text) return "";

	// If it already has newlines, trust the existing structure. Just bold any
	// leading speaker labels on each non-empty line for readability.
	if (/\n/.test(text)) {
		return text
			.split(/\n+/)
			.map((line) => boldSpeakerLabel(line.trim()))
			.filter((line) => line.length > 0)
			.join("\n\n");
	}

	// Break before a bracketed/parenthesized timestamp like [00:01:02] or (0:12).
	text = text.replace(/\s*([[(]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[\])])/g, "\n\n$1");

	// Break before every generic speaker label that follows 2+ spaces.
	text = text.replace(
		/\s{2,}([A-Z][A-Za-z0-9.'\- ]{0,40}:)(?=\s)/g,
		"\n\n**$1**",
	);

	// Bold a leading speaker label at the start of the transcript.
	text = text.replace(/^([A-Z][A-Za-z0-9.'\- ]{0,40}:)(?=\s)/, "**$1**");

	text = text.trim();

	// If we still have a single huge blob without breaks, fall back to
	// paragraphing by sentence runs (~3 sentences per paragraph).
	if (!/\n/.test(text) && text.length > 400) {
		text = paragraphBySentences(text);
	}

	return text;
}

function boldSpeakerLabel(line: string): string {
	if (!line) return line;
	const m = SPEAKER_LABEL_RE.exec(line);
	if (m && m.index === 0) {
		return `**${m[1]}:**${line.slice(m[0].length)}`;
	}
	return line;
}

function paragraphBySentences(text: string): string {
	const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
	if (!sentences || sentences.length <= 3) return text;
	const paragraphs: string[] = [];
	const chunkSize = 3;
	for (let i = 0; i < sentences.length; i += chunkSize) {
		paragraphs.push(sentences.slice(i, i + chunkSize).join(" ").trim());
	}
	return paragraphs.filter(Boolean).join("\n\n");
}

/**
 * Parse a Granola date string like "Mar 3, 2026 3:00 PM" into components.
 */
export function parseGranolaDate(dateStr: string): { isoDate: string; time: string; isoDateTime: string } {
	const d = new Date(dateStr);
	if (isNaN(d.getTime())) {
		return { isoDate: "", time: "", isoDateTime: "" };
	}

	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const isoDate = `${year}-${month}-${day}`;

	// Extract time from original string
	const timeMatch = dateStr.match(/\d{1,2}:\d{2}\s*[AP]M/i);
	const time = timeMatch ? timeMatch[0] : "";

	return { isoDate, time, isoDateTime: d.toISOString() };
}

/**
 * Build a MeetingData object from parsed API responses.
 */
export function buildMeetingData(
	details: ParsedMeetingDetails,
	transcript: string,
	folder = "",
): MeetingData {
	const { isoDate, time, isoDateTime } = parseGranolaDate(details.date);

	return {
		id: details.id,
		title: details.title || "Untitled Meeting",
		date: isoDate,
		startTime: time,
		created: isoDateTime,
		url: `https://notes.granola.ai/d/${details.id}`,
		privateNotes: details.privateNotes,
		enhancedNotes: details.summary,
		transcript: formatTranscriptText(transcript),
		participants: details.participants,
		folder,
	};
}

/**
 * Parse the list_meeting_folders response. The MCP server returns an
 * XML-ish document with <folder id="..." title="..." note_count="..."> entries
 * containing a <description> child.
 *
 * We also accept a JSON response as a fallback in case the format differs.
 */
export function parseFoldersResponse(text: string): ParsedFolder[] {
	const folders: ParsedFolder[] = [];
	if (!text.trim()) return folders;

	// Try JSON first.
	try {
		const parsed: unknown = JSON.parse(text);
		const candidates: unknown[] | null = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === "object" && Array.isArray((parsed as { folders?: unknown }).folders)
			? (parsed as { folders: unknown[] }).folders
			: null;
		if (candidates) {
			for (const raw of candidates) {
				if (!raw || typeof raw !== "object") continue;
				const r = raw as Record<string, unknown>;
				const id = typeof r.id === "string" ? r.id : "";
				const title = typeof r.title === "string"
					? r.title
					: typeof r.name === "string" ? r.name : "";
				if (!id || !title) continue;
				folders.push({
					id,
					title,
					description: typeof r.description === "string" ? r.description : "",
					noteCount:
						typeof r.note_count === "number"
							? r.note_count
							: typeof r.noteCount === "number"
							? r.noteCount
							: 0,
				});
			}
			return folders;
		}
	} catch {
		// Not JSON — fall through to XML-ish parsing.
	}

	const folderRegex = /<folder\s+([^>]*?)>([\s\S]*?)<\/folder>/g;
	let match;
	while ((match = folderRegex.exec(text)) !== null) {
		const [, attrs, body] = match;
		const id = /\bid="([^"]+)"/.exec(attrs)?.[1] ?? "";
		const title = /\btitle="([^"]*?)"/.exec(attrs)?.[1] ?? "";
		const noteCountStr = /\bnote_count="([^"]*?)"/.exec(attrs)?.[1];
		const descMatch = body.match(/<description>\s*([\s\S]*?)\s*<\/description>/);
		if (!id || !title) continue;
		folders.push({
			id,
			title,
			description: descMatch ? descMatch[1].trim() : "",
			noteCount: noteCountStr ? parseInt(noteCountStr, 10) || 0 : 0,
		});
	}
	return folders;
}
