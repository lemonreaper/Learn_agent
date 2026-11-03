"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3Icon, RepeatIcon } from "lucide-react";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { cn } from "@/lib/utils";

/**
 * THE REVIEW CONTROL (FSRS fork, 2026-11-03): the home composer's due
 * queue — "Review N due" seeds a practice session with the due cards
 * (weakest forecast recall first) and marks it a review session; the
 * stats button opens the calibration of FSRS's recall forecasts against
 * observed recall, the guard on the agent's unconstrained grades.
 * Renders nothing until the ledger has cards.
 */

export interface ReviewPick {
	id: string;
	name: string;
	statement: string;
}

interface CalibrationBin {
	lo: number;
	hi: number;
	n: number;
	meanPredicted: number | null;
	observedRecall: number | null;
}

interface ReviewSummaryResponse {
	total: number;
	dueCount: number;
	due: Array<ReviewPick & { retrievability: number; overdueDays: number; misconceptionFlag: boolean }>;
	nextDue: string | null;
	calibration: { n: number; brier: number | null; bias: number | null; bins: CalibrationBin[] };
}

/** Max cards one review session is seeded with — the agent can pull more
 *  through review_queue; a huge pick list would only crowd the context. */
export const REVIEW_SESSION_PICKS = 20;

function pct(x: number | null): string {
	return x === null ? "—" : `${Math.round(x * 100)}%`;
}

export function useReviewSummary(): ReviewSummaryResponse | null {
	const [summary, setSummary] = useState<ReviewSummaryResponse | null>(null);
	const load = useCallback(() => {
		fetch("/api/review")
			.then((r) => (r.ok ? (r.json() as Promise<ReviewSummaryResponse>) : null))
			.then((s) => {
				if (s && typeof s.total === "number") setSummary(s);
			})
			.catch(() => {
				/* the control simply stays hidden */
			});
	}, []);
	useEffect(() => {
		load();
		window.addEventListener("focus", load);
		return () => window.removeEventListener("focus", load);
	}, [load]);
	return summary;
}

export function ReviewControl({
	summary,
	onStartReview,
}: {
	summary: ReviewSummaryResponse | null;
	onStartReview: (picks: ReviewPick[]) => void;
}) {
	const [statsOpen, setStatsOpen] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(panelRef, statsOpen, () => setStatsOpen(false));
	if (!summary || summary.total === 0) return null;
	const { dueCount, due, nextDue, calibration } = summary;
	return (
		<div className="relative flex items-center gap-1.5" ref={panelRef}>
			{dueCount > 0 ? (
				<button
					type="button"
					data-testid="review-due-chip"
					onClick={() => onStartReview(due.slice(0, REVIEW_SESSION_PICKS).map(({ id, name, statement }) => ({ id, name, statement })))}
					className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:bg-accent"
				>
					<RepeatIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
					Review {dueCount} due
				</button>
			) : (
				<span data-testid="review-none-due" className="px-1 font-ui text-xs text-muted-foreground">
					Nothing due{nextDue ? ` · next ${new Date(nextDue).toLocaleDateString()}` : ""}
				</span>
			)}
			<button
				type="button"
				aria-label="Review calibration"
				data-testid="review-stats-button"
				onClick={() => setStatsOpen((o) => !o)}
				className={cn(
					"flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
					statsOpen && "bg-accent text-foreground",
				)}
			>
				<BarChart3Icon className="size-3.5" />
			</button>
			{statsOpen && (
				<div
					data-testid="review-stats-panel"
					className="absolute bottom-full left-0 z-30 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-card p-4 text-sm shadow-lg"
				>
					<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Forecast calibration</div>
					<p className="mb-3 text-xs text-foreground/60">
						Before each review FSRS forecasts the chance you recall the card; this compares the forecasts with what happened.
						Bias above zero means the forecasts — fed by the agent&apos;s grades — run optimistic.
					</p>
					{calibration.n === 0 ? (
						<p className="text-xs text-foreground/60">No forecast reviews yet — a card&apos;s first review has no forecast.</p>
					) : (
						<>
							<div className="mb-2 flex gap-4 font-mono text-xs tabular-nums">
								<span>n {calibration.n}</span>
								<span>bias {calibration.bias === null ? "—" : `${calibration.bias > 0 ? "+" : ""}${(calibration.bias * 100).toFixed(1)} pp`}</span>
								<span>Brier {calibration.brier === null ? "—" : calibration.brier.toFixed(3)}</span>
							</div>
							<table className="w-full font-mono text-xs tabular-nums">
								<thead className="text-muted-foreground">
									<tr>
										<th className="text-left font-normal">forecast</th>
										<th className="text-right font-normal">n</th>
										<th className="text-right font-normal">mean</th>
										<th className="text-right font-normal">observed</th>
									</tr>
								</thead>
								<tbody>
									{calibration.bins.map((b) => (
										<tr key={b.lo} className={b.n === 0 ? "text-muted-foreground/50" : ""}>
											<td>
												{Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}%
											</td>
											<td className="text-right">{b.n}</td>
											<td className="text-right">{pct(b.meanPredicted)}</td>
											<td className="text-right">{pct(b.observedRecall)}</td>
										</tr>
									))}
								</tbody>
							</table>
							{calibration.n < 100 && (
								<p className="mt-2 text-xs text-foreground/50">
									Small sample — read the bias as a signal only after roughly 100 forecast reviews.
								</p>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
