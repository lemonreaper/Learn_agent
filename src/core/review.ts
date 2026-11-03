/**
 * SPACED REPETITION (FSRS fork, 2026-11-03): the review ledger's pure core.
 *
 * Design rulings (owner, 2026-11-03):
 *  - A card is a graph PROPOSITION, born at its first rated practice
 *    problem (never at extraction — no card flood after a lesson).
 *  - The practice AGENT chooses the FSRS rating per proposition at
 *    conclude time (again | hard | good | easy, plus a reason), reading
 *    the outcome, hint rung, miss class and the learner's stated
 *    confidence. There are NO server-side constraints on that choice:
 *    the guard is measurement — every event stores FSRS's predicted
 *    retrievability BEFORE the review, and calibrationOf() compares it
 *    with the observed recall rate. Constraints get added only if the
 *    two diverge.
 *  - The FSRS algorithm itself is untouched (ts-fsrs, default weights,
 *    day-granular: no short-term learning steps, no fuzz).
 *  - The agent decides HOW to study (order, grouping, early reviews);
 *    this module only reports the schedule.
 *
 * SYNC-READY LEDGER: events are append-only with deterministic ids
 * (chat:conclude-call:proposition) — merging two copies of the ledger is
 * a union by id, and folding is order-independent of file position
 * (events replay sorted by time, then id).
 *
 * Source of truth: the chat record. Events are DERIVED from clean
 * conclude calls at turn settlement (reviewEventsFromRecord) — a turn
 * that never persisted its conclude never produces an event, and
 * re-deriving is idempotent.
 */

import {
	createEmptyCard,
	fsrs,
	generatorParameters,
	Rating,
	State,
	type Card,
	type FSRS,
	type Grade,
} from "ts-fsrs";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const REVIEW_RATINGS = ["again", "hard", "good", "easy"] as const;
export type ReviewRating = (typeof REVIEW_RATINGS)[number];

const GRADE: Record<ReviewRating, Grade> = {
	again: Rating.Again,
	hard: Rating.Hard,
	good: Rating.Good,
	easy: Rating.Easy,
};

export function isReviewRating(v: unknown): v is ReviewRating {
	return typeof v === "string" && (REVIEW_RATINGS as readonly string[]).includes(v);
}

/** FSRS's default target: 90% probability of recall at the due date. */
export const DEFAULT_DESIRED_RETENTION = 0.9;
export const DEFAULT_MAXIMUM_INTERVAL_DAYS = 365;

/** One agent rating, as it rides the conclude call's arguments. */
export interface ConcludeRating {
	target: string;
	rating: ReviewRating;
	reason: string;
}

/** One ledger line: a rated review of one proposition. */
export interface ReviewEvent {
	/** `${chatId}:${concludeCallId}:${propositionId}` — the union key. */
	id: string;
	v: 1;
	/** ISO time of the conclude (the review moment). */
	at: string;
	propositionId: string;
	rating: ReviewRating;
	/** The agent's one-line justification for the rating. */
	reason: string;
	chatId: string;
	problemCallId: string | null;
	concludeCallId: string;
	/** Problem-level context, copied for later analysis. */
	outcome: string | null;
	rung: string | null;
	missClass: string | null;
	mode: string | null;
	/** The learner's last stated confidence (0–100) on this problem, if any. */
	confidence: number | null;
	/** FSRS's predicted recall probability just BEFORE this review —
	 *  null for a card's first review (no prediction exists yet). */
	predictedR: number | null;
	/** Days since the previous review of this card (null on the first). */
	elapsedDays: number | null;
}

/** An event before the ledger annotates its prediction. */
export type ReviewEventDraft = Omit<ReviewEvent, "predictedR" | "elapsedDays">;

export interface SchedulerOptions {
	desiredRetention?: number;
	maximumIntervalDays?: number;
}

export function createScheduler(opts: SchedulerOptions = {}): FSRS {
	return fsrs(
		generatorParameters({
			request_retention: opts.desiredRetention ?? DEFAULT_DESIRED_RETENTION,
			maximum_interval: opts.maximumIntervalDays ?? DEFAULT_MAXIMUM_INTERVAL_DAYS,
			enable_fuzz: false,
			enable_short_term: false,
		}),
	);
}

// ─── Deriving events from a practice record ─────────────────────────────────

function cleanResultIds(messages: readonly LhMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const r = m as unknown as ToolResultMessage;
		if (!r.isError) ids.add(r.toolCallId);
	}
	return ids;
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

/** The ratings array off a conclude call's arguments — malformed entries
 *  are skipped (the tool validated them at execute time; this is the
 *  read-side belt for hand-edited or legacy records). */
export function ratingsOf(args: unknown): ConcludeRating[] {
	const raw = (args as { ratings?: unknown } | null | undefined)?.ratings;
	if (!Array.isArray(raw)) return [];
	const out: ConcludeRating[] = [];
	for (const r of raw) {
		const target = str((r as { target?: unknown })?.target);
		const rating = (r as { rating?: unknown })?.rating;
		if (!target || !isReviewRating(rating)) continue;
		const reason = typeof (r as { reason?: unknown }).reason === "string" ? (r as { reason: string }).reason : "";
		out.push({ target, rating, reason });
	}
	return out;
}

/**
 * Every rated review in a practice record. Walks the record once:
 * tracks the newest CLEAN problem pose and the learner's latest stated
 * confidence on it; each CLEAN conclude call carrying ratings yields one
 * draft per rated proposition (a repeated target within one conclude
 * keeps its first rating). Pure and idempotent — ids are deterministic.
 */
export function reviewEventsFromRecord(chatId: string, messages: readonly LhMessage[]): ReviewEventDraft[] {
	const clean = cleanResultIds(messages);
	const drafts: ReviewEventDraft[] = [];
	let problemCallId: string | null = null;
	let problemMode: string | null = null;
	const confidenceByProblem = new Map<string, number>();

	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as unknown as LhMarkerMessage;
			if (marker.customType !== "practice-thinking") continue;
			const d = marker.details as { problemCallId?: unknown; confidence?: unknown } | undefined;
			if (typeof d?.problemCallId === "string" && typeof d.confidence === "number" && Number.isFinite(d.confidence)) {
				confidenceByProblem.set(d.problemCallId, Math.max(0, Math.min(100, Math.round(d.confidence))));
			}
			continue;
		}
		if (role !== "assistant") continue;
		const assistant = m as unknown as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || !clean.has(block.id)) continue;
			if (block.name === PRACTICE_PROBLEM_TOOL) {
				problemCallId = block.id;
				problemMode = str((block.arguments as { mode?: unknown } | undefined)?.mode);
				continue;
			}
			if (block.name !== PRACTICE_CONCLUDE_TOOL) continue;
			const args = block.arguments as Record<string, unknown> | undefined;
			const ratings = ratingsOf(args);
			const at = new Date(typeof m.timestamp === "number" ? m.timestamp : Date.now()).toISOString();
			const seen = new Set<string>();
			for (const r of ratings) {
				if (seen.has(r.target)) continue;
				seen.add(r.target);
				drafts.push({
					id: `${chatId}:${block.id}:${r.target}`,
					v: 1,
					at,
					propositionId: r.target,
					rating: r.rating,
					reason: r.reason,
					chatId,
					problemCallId,
					concludeCallId: block.id,
					outcome: str(args?.outcome),
					rung: str(args?.rung),
					missClass: str(args?.missClass),
					mode: problemMode,
					confidence: problemCallId ? (confidenceByProblem.get(problemCallId) ?? null) : null,
				});
			}
			problemCallId = null;
			problemMode = null;
		}
	}
	return drafts;
}

// ─── Folding the ledger ─────────────────────────────────────────────────────

/** Dedupe by id (first line wins — the union rule) and order by time, then
 *  id, so two merged ledger copies fold identically. */
export function canonicalEvents<T extends { id: string; at: string }>(events: readonly T[]): T[] {
	const byId = new Map<string, T>();
	for (const e of events) if (!byId.has(e.id)) byId.set(e.id, e);
	return [...byId.values()].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
}

export interface CardState {
	propositionId: string;
	card: Card;
	/** Canonical-order history of this card's reviews. */
	history: ReviewEvent[];
}

/** Replay the ledger through FSRS: one card per rated proposition. */
export function foldCards(events: readonly ReviewEvent[], scheduler: FSRS = createScheduler()): Map<string, CardState> {
	const cards = new Map<string, CardState>();
	for (const e of canonicalEvents(events)) {
		const now = new Date(e.at);
		const state = cards.get(e.propositionId) ?? {
			propositionId: e.propositionId,
			card: createEmptyCard(now),
			history: [],
		};
		state.card = scheduler.next(state.card, now, GRADE[e.rating]).card;
		state.history.push(e);
		cards.set(e.propositionId, state);
	}
	return cards;
}

const DAY_MS = 86_400_000;

/** Annotate fresh drafts with FSRS's pre-review prediction, replaying the
 *  existing ledger plus earlier drafts. Drafts already in the ledger (same
 *  id) are dropped — the append is idempotent. */
export function annotateDrafts(
	existing: readonly ReviewEvent[],
	drafts: readonly ReviewEventDraft[],
	scheduler: FSRS = createScheduler(),
): ReviewEvent[] {
	const known = new Set(existing.map((e) => e.id));
	const fresh = canonicalEvents(drafts.filter((d) => !known.has(d.id)));
	if (fresh.length === 0) return [];
	const out: ReviewEvent[] = [];
	for (const d of fresh) {
		const prior = canonicalEvents([...existing, ...out]).filter(
			(e) => e.propositionId === d.propositionId && e.at <= d.at,
		);
		let predictedR: number | null = null;
		let elapsedDays: number | null = null;
		if (prior.length > 0) {
			const card = foldCards(prior, scheduler).get(d.propositionId)!.card;
			const now = new Date(d.at);
			predictedR = Number(scheduler.get_retrievability(card, now, false));
			const last = card.last_review ? new Date(card.last_review).getTime() : now.getTime();
			elapsedDays = Math.max(0, (now.getTime() - last) / DAY_MS);
		}
		out.push({ ...d, predictedR, elapsedDays });
	}
	return out;
}

// ─── The schedule (what the agent and the UI read) ──────────────────────────

export interface ScheduleItem {
	propositionId: string;
	due: string;
	isDue: boolean;
	/** Positive = days past due; negative = days until due. */
	overdueDays: number;
	retrievability: number;
	stability: number;
	difficulty: number;
	reps: number;
	lapses: number;
	lastReviewed: string | null;
	recent: Array<Pick<ReviewEvent, "at" | "rating" | "reason" | "outcome" | "missClass" | "confidence">>;
	/** Any structural miss (a misconception) in the recent history. */
	misconceptionFlag: boolean;
}

export function scheduleOf(
	events: readonly ReviewEvent[],
	now: Date = new Date(),
	scheduler: FSRS = createScheduler(),
	recentCount = 3,
): ScheduleItem[] {
	const items: ScheduleItem[] = [];
	for (const s of foldCards(events, scheduler).values()) {
		const due = new Date(s.card.due);
		const recent = s.history.slice(-recentCount).map((e) => ({
			at: e.at,
			rating: e.rating,
			reason: e.reason,
			outcome: e.outcome,
			missClass: e.missClass,
			confidence: e.confidence,
		}));
		items.push({
			propositionId: s.propositionId,
			due: due.toISOString(),
			isDue: due.getTime() <= now.getTime(),
			overdueDays: (now.getTime() - due.getTime()) / DAY_MS,
			retrievability: s.card.state === State.New ? 0 : Number(scheduler.get_retrievability(s.card, now, false)),
			stability: s.card.stability,
			difficulty: s.card.difficulty,
			reps: s.card.reps,
			lapses: s.card.lapses,
			lastReviewed: s.card.last_review ? new Date(s.card.last_review).toISOString() : null,
			recent,
			misconceptionFlag: recent.some((r) => r.missClass === "structural"),
		});
	}
	// Weakest first: lowest predicted recall leads.
	return items.sort((a, b) => a.retrievability - b.retrievability || (a.propositionId < b.propositionId ? -1 : 1));
}

// ─── Calibration (the guard on agent ratings) ───────────────────────────────

export interface CalibrationBin {
	lo: number;
	hi: number;
	n: number;
	meanPredicted: number | null;
	observedRecall: number | null;
}

export interface Calibration {
	/** Reviews with a prediction (every review but a card's first). */
	n: number;
	/** Mean squared error of predicted R vs recalled (0/1). */
	brier: number | null;
	/** Mean predicted R minus observed recall rate: > 0 = FSRS (fed by the
	 *  agent's ratings) is over-optimistic. */
	bias: number | null;
	bins: CalibrationBin[];
}

export const CALIBRATION_EDGES = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1] as const;

/** Recall = any rating but "again" (FSRS's own pass/fail convention). */
export function recalled(e: Pick<ReviewEvent, "rating">): boolean {
	return e.rating !== "again";
}

export function calibrationOf(events: readonly ReviewEvent[]): Calibration {
	const scored = canonicalEvents(events).filter((e) => typeof e.predictedR === "number");
	const bins: CalibrationBin[] = [];
	for (let i = 0; i < CALIBRATION_EDGES.length - 1; i++) {
		const lo = CALIBRATION_EDGES[i]!;
		const hi = CALIBRATION_EDGES[i + 1]!;
		const last = i === CALIBRATION_EDGES.length - 2;
		const inBin = scored.filter((e) => e.predictedR! >= lo && (last ? e.predictedR! <= hi : e.predictedR! < hi));
		const n = inBin.length;
		bins.push({
			lo,
			hi,
			n,
			meanPredicted: n ? inBin.reduce((s, e) => s + e.predictedR!, 0) / n : null,
			observedRecall: n ? inBin.filter(recalled).length / n : null,
		});
	}
	const n = scored.length;
	if (n === 0) return { n, brier: null, bias: null, bins };
	let sq = 0;
	let predSum = 0;
	let obsSum = 0;
	for (const e of scored) {
		const y = recalled(e) ? 1 : 0;
		sq += (e.predictedR! - y) ** 2;
		predSum += e.predictedR!;
		obsSum += y;
	}
	return { n, brier: sq / n, bias: predSum / n - obsSum / n, bins };
}

// ─── Context lines for the practice agent ───────────────────────────────────

function pct(x: number): string {
	return `${Math.round(x * 100)}%`;
}

function days(x: number): string {
	const a = Math.abs(x);
	const v = a < 1 ? `${Math.round(a * 24)}h` : `${Math.round(a * 10) / 10}d`;
	return x >= 0 ? `overdue ${v}` : `due in ${v}`;
}

/** One proposition's schedule as a compact model-facing line. */
export function formatScheduleLine(item: ScheduleItem, name?: string): string {
	const head = `[${item.propositionId}]${name ? ` ${name}` : ""} — R ${pct(item.retrievability)}, ${days(item.overdueDays)}, reps ${item.reps}, lapses ${item.lapses}${item.misconceptionFlag ? ", MISCONCEPTION seen" : ""}`;
	const hist = item.recent
		.map(
			(r) =>
				`${r.at.slice(0, 10)} ${r.rating}${r.confidence !== null ? ` @${r.confidence}%` : ""}${r.missClass ? ` (${r.missClass})` : ""}${r.reason ? `: ${r.reason}` : ""}`,
		)
		.join(" | ");
	return hist ? `${head}\n    history: ${hist}` : head;
}
