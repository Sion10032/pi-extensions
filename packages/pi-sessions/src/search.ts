/**
 * Query parsing and relevance ranking for the session picker.
 *
 * A query is either a list of tokens (plain words and quoted phrases) or a
 * single `re:<pattern>` regular expression. Matching is case-insensitive
 * throughout.
 *
 * Ranking is layered so what the user typed in the name always beats a hit
 * buried in message text, which in turn beats a scattered fuzzy match:
 *
 *   score = tier * 1_000_000 + fuzzy score (lower is better)
 *
 * With several tokens the worst (highest) token score wins, so a token that
 * only fuzzy-matches drags the whole session down.
 */
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { fuzzyMatch } from "@earendil-works/pi-tui";

import { cleanName } from "./paths.ts";
import type { SessionRecord, SortMode } from "./types.ts";

/** A plain whitespace-delimited word, or a quoted phrase taken literally. */
export interface QueryToken {
	kind: "word" | "phrase";
	value: string;
}

export interface ParsedQuery {
	mode: "tokens" | "regex";
	tokens: QueryToken[];
	regex?: RegExp;
	/** Set when `re:` carried an empty or invalid pattern; such a query matches nothing. */
	error?: string;
	/** True when the raw input was blank, so nothing should be filtered. */
	empty: boolean;
}

const TIER_NAME = 0;
const TIER_TEXT = 1;
const TIER_FUZZY = 2;

/** A better tier always wins over any fuzzy tie-break score. */
const TIER_STRIDE = 1_000_000;

/** The sentinel `cleanName` returns for a missing or empty name. */
const UNNAMED = "(unnamed)";

interface ScoredTier {
	tier: number;
	/** Fuzzy quality inside the tier; lower is better. */
	score: number;
}

const NAME: ScoredTier = { tier: TIER_NAME, score: 0 };
const TEXT: ScoredTier = { tier: TIER_TEXT, score: 0 };

function tierScore(match: ScoredTier): number {
	return match.tier * TIER_STRIDE + match.score;
}

function combine(match: ScoredTier | undefined): number | undefined {
	return match === undefined ? undefined : tierScore(match);
}

/** Lowercase and collapse whitespace, so phrases survive line breaks. */
function normalizeText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

interface CachedText {
	/** The `allMessagesText` the derived views below were built from. */
	source: string;
	/** The source, lowercased, for substring matching. */
	lower: string;
	/** The source, lowercased with whitespace collapsed, for phrases. */
	normalized: string;
}

/**
 * `allMessagesText` can reach megabytes, while the picker re-filters and
 * re-sorts on every keystroke. Derive the searchable views once per
 * `SessionInfo` and reuse them; comparing `source` as well keeps an in-place
 * text update from matching stale text. Entries die with their session.
 */
const textCache = new WeakMap<SessionInfo, CachedText>();

function messageText(info: SessionInfo): CachedText {
	const source = info.allMessagesText ?? "";
	const cached = textCache.get(info);
	if (cached && cached.source === source) return cached;
	const fresh: CachedText = {
		source,
		lower: source.toLowerCase(),
		normalized: normalizeText(source),
	};
	textCache.set(info, fresh);
	return fresh;
}

/** Split on whitespace, keeping `"quoted phrases"` together. */
function tokenize(trimmed: string): QueryToken[] {
	const tokens: QueryToken[] = [];
	let buffer = "";
	let inQuote = false;
	const flush = (kind: QueryToken["kind"]): void => {
		const value = buffer.trim();
		buffer = "";
		if (value) tokens.push({ kind, value });
	};
	for (const ch of trimmed) {
		if (ch === '"') {
			flush(inQuote ? "phrase" : "word");
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			flush("word");
			continue;
		}
		buffer += ch;
	}
	if (inQuote) {
		// Unbalanced quotes are more likely a typo than an unfinished phrase:
		// fall back to plain whitespace tokenization.
		return trimmed.split(/\s+/).map((value) => ({ kind: "word" as const, value }));
	}
	flush("word");
	return tokens;
}

/**
 * Parse user input into tokens or a regular expression. A `re:` prefix wins
 * over quoting. `empty` marks blank input; an unusable `re:` pattern instead
 * sets `error`, and `matchScore` then matches nothing.
 */
export function parseQuery(raw: string): ParsedQuery {
	const trimmed = raw.trim();
	if (!trimmed) return { mode: "tokens", tokens: [], empty: true };
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) return { mode: "regex", tokens: [], error: "Empty regex", empty: false };
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i"), empty: false };
		} catch (error) {
			return {
				mode: "regex",
				tokens: [],
				error: error instanceof Error ? error.message : String(error),
				empty: false,
			};
		}
	}
	return { mode: "tokens", tokens: tokenize(trimmed), empty: false };
}

/** True when the session carries a real name, not a blank or bare legacy tag. */
export function hasName(info: SessionInfo): boolean {
	return cleanName(info.name) !== UNNAMED;
}

/** The searchable name: the cleaned name, or empty when there is none. */
function searchableName(info: SessionInfo): string {
	return hasName(info) ? cleanName(info.name) : "";
}

/**
 * Match one plain word against a session: the name first, then the id, all
 * message text and the cwd, and finally a fuzzy match over the name and cwd.
 */
function wordTier(info: SessionInfo, word: string): ScoredTier | undefined {
	const needle = word.toLowerCase();
	const name = searchableName(info);
	if (name && name.toLowerCase().includes(needle)) return NAME;
	if (
		info.id.toLowerCase().includes(needle) ||
		messageText(info).lower.includes(needle) ||
		info.cwd.toLowerCase().includes(needle)
	) {
		return TEXT;
	}
	let best: number | undefined;
	for (const candidate of [name, info.cwd]) {
		const match = fuzzyMatch(word, candidate);
		if (match.matches && (best === undefined || match.score < best)) best = match.score;
	}
	return best === undefined ? undefined : { tier: TIER_FUZZY, score: best };
}

/**
 * Match a quoted phrase after collapsing whitespace: in the name it is a
 * name hit, anywhere in the id, message text or cwd a text hit. Anything
 * looser would not be a phrase.
 */
function phraseTier(info: SessionInfo, phrase: string): ScoredTier | undefined {
	const needle = normalizeText(phrase);
	if (!needle) return undefined;
	if (normalizeText(searchableName(info)).includes(needle)) return NAME;
	// Normalizing field by field and joining the non-empty parts gives the same
	// collapsed string as normalizing the raw join, without re-processing the
	// cached message text on every keystroke.
	const text = [normalizeText(info.id), messageText(info).normalized, normalizeText(info.cwd)]
		.filter(Boolean)
		.join(" ");
	return text.includes(needle) ? TEXT : undefined;
}

/** A regex is tested against the name first, then the id, message text and cwd. */
function regexTier(info: SessionInfo, regex: RegExp): ScoredTier | undefined {
	const name = searchableName(info);
	if (name && regex.test(name)) return NAME;
	const text = [info.id, messageText(info).source, info.cwd];
	return text.some((field) => regex.test(field)) ? TEXT : undefined;
}

/**
 * Relevance of one session for a parsed query; undefined means it does not
 * match and must be filtered out. A blank query scores everything 0.
 */
export function matchScore(info: SessionInfo, query: ParsedQuery): number | undefined {
	if (query.error) return undefined;
	if (query.mode === "regex") return query.regex ? combine(regexTier(info, query.regex)) : undefined;
	if (query.tokens.length === 0) return 0;
	let worst = 0;
	for (const token of query.tokens) {
		const match = token.kind === "phrase" ? phraseTier(info, token.value) : wordTier(info, token.value);
		if (match === undefined) return undefined;
		worst = Math.max(worst, tierScore(match));
	}
	return worst;
}

/** True when the query selects every record instead of filtering and ranking. */
function matchesEverything(query: ParsedQuery): boolean {
	return query.empty || (query.mode === "tokens" && query.tokens.length === 0);
}

function byModifiedDesc(a: SessionRecord, b: SessionRecord): number {
	return b.info.modified.getTime() - a.info.modified.getTime();
}

/**
 * Order records for display. Without an effective query every record is kept
 * and only `modified` matters. Otherwise non-matches are dropped and `recent`
 * orders by `modified`, while `threaded` and `relevance` rank by score and
 * break ties by `modified`.
 */
export function sortRecords(records: SessionRecord[], query: ParsedQuery, sort: SortMode): SessionRecord[] {
	if (matchesEverything(query)) return [...records].sort(byModifiedDesc);
	const scored: { record: SessionRecord; score: number }[] = [];
	for (const record of records) {
		const score = matchScore(record.info, query);
		if (score !== undefined) scored.push({ record, score });
	}
	if (sort === "recent") return scored.map((row) => row.record).sort(byModifiedDesc);
	return scored
		.sort((a, b) => a.score - b.score || byModifiedDesc(a.record, b.record))
		.map((row) => row.record);
}
