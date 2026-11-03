/**
 * GET /api/review — the spaced-repetition summary (FSRS fork, 2026-11-03):
 * due cards (weakest forecast recall first, ready to ride a practice
 * session's creation as picks), the next due date, and the calibration of
 * FSRS's recall forecasts against what actually happened — the guard on
 * the agent's unconstrained grades. Thin transport over server/review.ts.
 */
import { reviewSummary } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(reviewSummary());
}
