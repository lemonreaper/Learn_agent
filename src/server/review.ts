/**
 * The spaced-repetition service (FSRS fork, 2026-11-03): the server seam
 * between the review ledger (store/review.ts), the chat records and the
 * graph. Three consumers:
 *  - turn settlement (chat-handler): recordPracticeReviews derives rated
 *    reviews from a practice record's clean conclude calls and appends the
 *    new ones (idempotent — safe on every settlement, retries included);
 *  - the practice agent's review_queue tool: reviewScheduleText;
 *  - the HTTP routes / UI: reviewSummary, reviewContextLines.
 */

import {
	annotateDrafts,
	calibrationOf,
	createScheduler,
	formatScheduleLine,
	reviewEventsFromRecord,
	scheduleOf,
	type Calibration,
	type ScheduleItem,
} from "../core/review.ts";
import { reviewStore } from "../store/review.ts";
import type { ReviewStore } from "../core/ports.ts";
import { stores } from "./stores.ts";

type ReviewDeps = {
	reviewStore: ReviewStore;
	chatStore: Pick<typeof stores.chatStore, "getChat">;
	graphStore: Pick<typeof stores.graphStore, "readNodes">;
	now?: () => Date;
};

const liveDeps = (): ReviewDeps => ({ reviewStore, chatStore: stores.chatStore, graphStore: stores.graphStore });

/** Derive + append the practice record's new rated reviews. Returns how
 *  many events were written (0 for non-practice chats or nothing new). */
export function recordPracticeReviews(chatId: string, deps: ReviewDeps = liveDeps()): number {
	const record = deps.chatStore.getChat(chatId);
	if (!record || record.kind !== "practice") return 0;
	const drafts = reviewEventsFromRecord(chatId, record.messages);
	if (drafts.length === 0) return 0;
	const existing = deps.reviewStore.listEvents();
	const annotated = annotateDrafts(existing, drafts, createScheduler());
	return deps.reviewStore.appendEvents(annotated).length;
}

function nodeIndex(deps: ReviewDeps): Map<string, { name: string; statement: string }> {
	return new Map(deps.graphStore.readNodes().map((n) => [n.id, { name: n.name, statement: n.statement }]));
}

/** The review_queue tool's text. */
export function reviewScheduleText(scope: "due" | "all", limit: number, deps: ReviewDeps = liveDeps()): string {
	const now = deps.now?.() ?? new Date();
	const schedule = scheduleOf(deps.reviewStore.listEvents(), now, createScheduler());
	if (schedule.length === 0) {
		return "No spaced-repetition cards yet. A proposition becomes a card the first time a problem targeting it is concluded with a rating.";
	}
	const due = schedule.filter((s) => s.isDue);
	const shown = (scope === "due" ? due : schedule).slice(0, limit);
	const names = nodeIndex(deps);
	const header = `Spaced-repetition schedule at ${now.toISOString()} — ${schedule.length} cards, ${due.length} due. Weakest forecast recall first. R = FSRS-forecast probability of recall now.`;
	if (shown.length === 0) {
		const next = schedule.map((s) => s.due).sort()[0];
		return `${header}\nNothing is due${next ? `; the next card falls due ${next}` : ""}. Use scope "all" to see every card.`;
	}
	return [header, ...shown.map((s) => `- ${formatScheduleLine(s, names.get(s.propositionId)?.name)}`)].join("\n");
}

export interface ReviewPick {
	id: string;
	name: string;
	statement: string;
}

export interface ReviewSummary {
	total: number;
	dueCount: number;
	/** Due cards that still exist in the graph, weakest first — ready to
	 *  ride a practice session's creation as picks. */
	due: Array<ReviewPick & Pick<ScheduleItem, "retrievability" | "overdueDays" | "misconceptionFlag">>;
	/** Cards whose proposition was deleted from the graph (kept in the
	 *  ledger, unreviewable). */
	orphaned: number;
	nextDue: string | null;
	calibration: Calibration;
}

export function reviewSummary(deps: ReviewDeps = liveDeps()): ReviewSummary {
	const now = deps.now?.() ?? new Date();
	const events = deps.reviewStore.listEvents();
	const schedule = scheduleOf(events, now, createScheduler());
	const names = nodeIndex(deps);
	const live = schedule.filter((s) => names.has(s.propositionId));
	const due = live.filter((s) => s.isDue);
	const upcoming = live.filter((s) => !s.isDue).map((s) => s.due).sort();
	return {
		total: live.length,
		dueCount: due.length,
		due: due.map((s) => ({
			id: s.propositionId,
			name: names.get(s.propositionId)!.name,
			statement: names.get(s.propositionId)!.statement,
			retrievability: s.retrievability,
			overdueDays: s.overdueDays,
			misconceptionFlag: s.misconceptionFlag,
		})),
		orphaned: schedule.length - live.length,
		nextDue: upcoming[0] ?? null,
		calibration: calibrationOf(events),
	};
}

/** Extra session-context lines for picked propositions that already have
 *  review history (any practice session), plus the review-session framing
 *  when the session was started from the due queue. */
export function reviewContextLines(propositionIds: readonly string[], reviewSession: boolean, deps: ReviewDeps = liveDeps()): string[] {
	const now = deps.now?.() ?? new Date();
	const picked = new Set(propositionIds);
	const items = scheduleOf(deps.reviewStore.listEvents(), now, createScheduler()).filter((s) => picked.has(s.propositionId));
	const lines: string[] = [];
	if (reviewSession) {
		lines.push(
			"",
			"This is a SPACED-REPETITION REVIEW session: the propositions above are the cards that are due (FSRS). How to review them is your call — order, grouping, modes, and pulling in other cards (review_queue) included.",
		);
	}
	if (items.length > 0) {
		const names = nodeIndex(deps);
		lines.push("", "Review history (FSRS):", ...items.map((s) => `- ${formatScheduleLine(s, names.get(s.propositionId)?.name)}`));
	}
	return lines;
}
