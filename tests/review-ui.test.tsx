/**
 * Spaced-repetition UI render pins (FSRS fork, 2026-11-03) — the render
 * suite's discipline: pure bodies, renderToStaticMarkup, testids. The
 * dock's optional confidence row, the thinking card's stated confidence,
 * the conclusion's review grades, and the home review control.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";

import { PracticeDock } from "../components/practice-dock.tsx";
import { ConcludeCard, ThinkingCard } from "../components/practice-cards.tsx";
import { ReviewControl } from "../components/review-control.tsx";

describe("PracticeDock — optional stated confidence", () => {
	it("renders the confidence row unset (—) with the clear button disabled", () => {
		const html = renderToStaticMarkup(
			<PracticeDock problemCallId="p" input={{ statement: "S" }} expanded={true} onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.match(html, /data-testid="practice-confidence"/);
		assert.match(html, /data-testid="practice-confidence-value"[^>]*>—</);
		assert.match(html, /aria-valuetext="not set"/);
		assert.match(html, /data-testid="practice-confidence-clear"[^>]*disabled/);
	});
});

describe("ThinkingCard — stated confidence in the label", () => {
	it("shows the percentage only when the submission carried one", () => {
		assert.match(renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "p", text: "t", confidence: 70 }} />), /YOUR THINKING · 70% CONFIDENT/);
		const plain = renderToStaticMarkup(<ThinkingCard data={{ problemCallId: "p", text: "t" }} />);
		assert.match(plain, /YOUR THINKING/);
		assert.doesNotMatch(plain, /CONFIDENT/);
	});
});

describe("ConcludeCard — the agent's review grades", () => {
	const base = { type: "tool-conclude", state: "output-available", toolCallId: "c1" } as const;
	it("lists each target's grade and reason", () => {
		const html = renderToStaticMarkup(
			<ConcludeCard
				part={{
					...base,
					input: {
						outcome: "solvedWithHints",
						verdict: "v",
						ratings: [
							{ target: "n_iv", rating: "hard", reason: "needed a class nudge" },
							{ target: "n_ex", rating: "good", reason: "came unaided" },
						],
					},
				} as never}
			/>,
		);
		assert.match(html, /data-testid="review-grades"/);
		assert.match(html, />hard</);
		assert.match(html, /needed a class nudge/);
		assert.match(html, />good</);
	});

	it("renders no grades block for an untagged conclusion", () => {
		const html = renderToStaticMarkup(<ConcludeCard part={{ ...base, input: { outcome: "solved", verdict: "v" } } as never} />);
		assert.doesNotMatch(html, /review-grades/);
	});
});

describe("ReviewControl", () => {
	const calibration = { n: 0, brier: null, bias: null, bins: [] };
	it("hidden until the ledger has cards", () => {
		assert.equal(renderToStaticMarkup(<ReviewControl summary={null} onStartReview={() => {}} />), "");
		assert.equal(
			renderToStaticMarkup(<ReviewControl summary={{ total: 0, dueCount: 0, due: [], nextDue: null, calibration }} onStartReview={() => {}} />),
			"",
		);
	});

	it("shows the due count, or the next due date when nothing is due", () => {
		const due = [{ id: "a", name: "A", statement: "s", retrievability: 0.6, overdueDays: 2, misconceptionFlag: false }];
		const html = renderToStaticMarkup(
			<ReviewControl summary={{ total: 3, dueCount: 1, due, nextDue: null, calibration }} onStartReview={() => {}} />,
		);
		assert.match(html, /Review 1 due/);
		assert.match(html, /data-testid="review-stats-button"/);
		const none = renderToStaticMarkup(
			<ReviewControl summary={{ total: 3, dueCount: 0, due: [], nextDue: "2026-11-10T10:00:00.000Z", calibration }} onStartReview={() => {}} />,
		);
		assert.match(none, /Nothing due · next/);
	});
});
