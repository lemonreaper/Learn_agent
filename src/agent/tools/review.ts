/**
 * review_queue (FSRS fork, 2026-11-03): the practice agent's read-only
 * window onto the spaced-repetition schedule. The agent owns HOW to study
 * (owner ruling: full freedom — order, grouping, early reviews); this tool
 * only reports what FSRS knows. The data arrives through an injected
 * context (agents never import stores — the eslint boundary).
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";

export interface ReviewToolContext {
	/** Model-facing schedule text for the given scope (fresh per call). */
	scheduleText(scope: "due" | "all", limit: number): string;
}

export const reviewQueueInput = Type.Object({
	scope: Type.Optional(
		Type.Union([Type.Literal("due"), Type.Literal("all")], {
			description: "due = only cards whose review date has passed (default); all = every card, weakest recall first.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum cards to list (default 30, max 200)." })),
});

export function reviewQueueTool(ctx: ReviewToolContext): AgentTool<typeof reviewQueueInput> {
	return {
		name: "review_queue",
		label: "review_queue",
		description:
			"Read the learner's spaced-repetition schedule: per proposition its forecast recall (R), due/overdue time, " +
			"review count, lapses and the last ratings with their reasons. Read-only. Use it to choose what to review and how.",
		parameters: reviewQueueInput,
		execute: serverExecute("review_queue", reviewQueueInput, async ({ scope, limit }): Promise<string> => {
			const n = limit === undefined ? 30 : Math.floor(limit);
			const bounded = Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : 30;
			return ctx.scheduleText(scope ?? "due", bounded);
		}),
	};
}
