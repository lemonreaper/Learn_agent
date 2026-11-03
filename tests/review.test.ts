/**
 * Spaced repetition (FSRS fork, 2026-11-03): the review ledger core, the
 * JSONL adapter, the conclude tool's rating contract, the settlement
 * service, and the stated-confidence input. No network, no models; the
 * ledger lives in a temp file.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	annotateDrafts,
	calibrationOf,
	canonicalEvents,
	createScheduler,
	foldCards,
	reviewEventsFromRecord,
	scheduleOf,
	type ReviewEvent,
	type ReviewEventDraft,
} from "../src/core/review.ts";
import { createReviewStore } from "../src/store/review.ts";
import { recordPracticeReviews, reviewContextLines, reviewScheduleText, reviewSummary } from "../src/server/review.ts";
import { concludeTool, createPracticeGate, problemTool } from "../src/agent/tools/practice.ts";
import {
	newThinkingMessage,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { parseChatInput, ChatInputError } from "../src/core/input-events.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

let seq = 0;
function call(name: string, id: string, args: Record<string, unknown>, ts: number): LhMessage {
	return {
		id: `msg_${++seq}`,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: ts,
		...STAMPS,
	} as LhMessage & AssistantMessage;
}
function result(toolCallId: string, name: string, isError: boolean, ts: number): LhMessage {
	return {
		id: `msg_${++seq}`,
		role: "toolResult",
		toolCallId,
		toolName: name,
		content: [{ type: "text", text: isError ? "Invalid tool input" : "ok" }],
		details: null,
		isError,
		timestamp: ts,
	} as LhMessage & ToolResultMessage;
}

const T0 = Date.parse("2026-11-01T10:00:00Z");
const DAY = 86_400_000;

/** pose(targets a,b) → thinking@80% → errored conclude → clean conclude(ratings). */
function ratedRecord(): LhMessage[] {
	const thinking = { ...newThinkingMessage("call_p1", "Answer: use IV", 80), timestamp: T0 + 1000 };
	return [
		call(PRACTICE_PROBLEM_TOOL, "call_p1", { statement: "S", mode: "discrimination", target: ["a", "b"], modelSolution: "M" }, T0),
		result("call_p1", PRACTICE_PROBLEM_TOOL, false, T0),
		thinking,
		call(PRACTICE_CONCLUDE_TOOL, "call_bad", { outcome: "solved", ratings: [{ target: "a", rating: "easy", reason: "x" }] }, T0 + 2000),
		result("call_bad", PRACTICE_CONCLUDE_TOOL, true, T0 + 2000),
		call(
			PRACTICE_CONCLUDE_TOOL,
			"call_c1",
			{
				outcome: "solvedWithHints",
				rung: "R2",
				missClass: "discrimination",
				ratings: [
					{ target: "a", rating: "hard", reason: "needed a class nudge" },
					{ target: "b", rating: "good", reason: "came unaided" },
					{ target: "a", rating: "easy", reason: "duplicate — ignored" },
				],
			},
			T0 + 3000,
		),
		result("call_c1", PRACTICE_CONCLUDE_TOOL, false, T0 + 3000),
	];
}

function draft(id: string, prop: string, rating: ReviewEventDraft["rating"], at: number): ReviewEventDraft {
	return {
		id,
		v: 1,
		at: new Date(at).toISOString(),
		propositionId: prop,
		rating,
		reason: "",
		chatId: "c",
		problemCallId: null,
		concludeCallId: id,
		outcome: null,
		rung: null,
		missClass: null,
		mode: null,
		confidence: null,
	};
}

const tmpDirs: string[] = [];
function tmpLedger(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-"));
	tmpDirs.push(dir);
	return path.join(dir, "review", "log.jsonl");
}
after(() => {
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ── deriving events from the record ─────────────────────────────────────────

describe("reviewEventsFromRecord — the record is the source of truth", () => {
	it("one draft per rated target of each CLEAN conclude, with problem context and stated confidence", () => {
		const drafts = reviewEventsFromRecord("chat1", ratedRecord());
		assert.equal(drafts.length, 2, "the errored conclude yields nothing; the duplicate target keeps its first rating");
		const [a, b] = drafts;
		assert.equal(a!.id, "chat1:call_c1:a");
		assert.equal(a!.rating, "hard");
		assert.equal(a!.reason, "needed a class nudge");
		assert.equal(b!.rating, "good");
		for (const d of drafts) {
			assert.equal(d.problemCallId, "call_p1");
			assert.equal(d.mode, "discrimination");
			assert.equal(d.outcome, "solvedWithHints");
			assert.equal(d.rung, "R2");
			assert.equal(d.missClass, "discrimination");
			assert.equal(d.confidence, 80);
			assert.equal(d.at, new Date(T0 + 3000).toISOString());
		}
	});

	it("is deterministic — re-deriving yields the same ids (idempotent appends)", () => {
		assert.deepEqual(
			reviewEventsFromRecord("chat1", ratedRecord()).map((d) => d.id),
			reviewEventsFromRecord("chat1", ratedRecord()).map((d) => d.id),
		);
	});

	it("an untagged problem or a conclude without ratings yields nothing", () => {
		const record = [
			call(PRACTICE_PROBLEM_TOOL, "p", { statement: "S", mode: "recall", modelSolution: "M" }, T0),
			result("p", PRACTICE_PROBLEM_TOOL, false, T0),
			call(PRACTICE_CONCLUDE_TOOL, "c", { outcome: "solved" }, T0 + 1),
			result("c", PRACTICE_CONCLUDE_TOOL, false, T0 + 1),
		];
		assert.deepEqual(reviewEventsFromRecord("chat", record), []);
	});
});

// ── FSRS fold, prediction annotation, schedule ──────────────────────────────

describe("the FSRS fold", () => {
	it("first review carries no prediction; the next carries FSRS's pre-review recall forecast", () => {
		const first = annotateDrafts([], [draft("e1", "a", "good", T0)]);
		assert.equal(first[0]!.predictedR, null);
		assert.equal(first[0]!.elapsedDays, null);
		const second = annotateDrafts(first, [draft("e2", "a", "good", T0 + 3 * DAY)]);
		const r = second[0]!.predictedR!;
		assert.ok(r > 0 && r < 1, `R is a probability (got ${r})`);
		assert.ok(Math.abs(second[0]!.elapsedDays! - 3) < 1e-9);
	});

	it("annotation is idempotent: drafts already in the ledger are dropped", () => {
		const ledger = annotateDrafts([], [draft("e1", "a", "good", T0)]);
		assert.deepEqual(annotateDrafts(ledger, [draft("e1", "a", "good", T0)]), []);
	});

	it("again shortens the next interval relative to good", () => {
		const good = foldCards(annotateDrafts([], [draft("g", "x", "good", T0)])).get("x")!.card;
		const again = foldCards(annotateDrafts([], [draft("a", "x", "again", T0)])).get("x")!.card;
		assert.ok(new Date(again.due).getTime() < new Date(good.due).getTime());
	});

	it("merging two ledger copies is a union — file order does not change the fold", () => {
		const events = annotateDrafts([], [
			draft("e1", "a", "good", T0),
			draft("e2", "b", "hard", T0 + DAY),
			draft("e3", "a", "again", T0 + 2 * DAY),
		]);
		const copyA = [events[0]!, events[2]!];
		const copyB = [events[1]!, events[0]!];
		const merged = [...copyB, ...copyA]; // duplicate e1, scrambled order
		const fold = (es: ReviewEvent[]) =>
			[...foldCards(es).values()].map((s) => [s.propositionId, s.card.stability, String(s.card.due)]);
		assert.deepEqual(fold(merged).sort(), fold(events).sort());
		assert.equal(canonicalEvents(merged).length, 3);
	});

	it("scheduleOf: due flags, weakest-first order, misconception flag from structural misses", () => {
		const events = annotateDrafts([], [
			{ ...draft("e1", "strong", "easy", T0) },
			{ ...draft("e2", "weak", "again", T0), missClass: "structural" },
		]);
		const now = new Date(T0 + 30 * DAY);
		const schedule = scheduleOf(events, now, createScheduler());
		assert.equal(schedule[0]!.propositionId, "weak", "lowest recall first");
		assert.ok(schedule.every((s) => s.isDue), "both are due after 30 days");
		assert.equal(schedule[0]!.misconceptionFlag, true);
		assert.equal(schedule[1]!.misconceptionFlag, false);
	});
});

// ── calibration ─────────────────────────────────────────────────────────────

describe("calibrationOf — forecast vs observed recall", () => {
	it("Brier and bias by hand: predictions .9,.9,.6,.8 with outcomes pass,fail,pass,pass", () => {
		const mk = (id: string, r: number, rating: ReviewEvent["rating"]): ReviewEvent => ({
			...draft(id, id, rating, T0),
			predictedR: r,
			elapsedDays: 1,
		});
		const c = calibrationOf([mk("1", 0.9, "good"), mk("2", 0.9, "again"), mk("3", 0.6, "hard"), mk("4", 0.8, "easy"), { ...mk("5", 0, "good"), predictedR: null }]);
		// Brier = (0.1² + 0.9² + 0.4² + 0.2²) / 4 = (0.01 + 0.81 + 0.16 + 0.04) / 4 = 1.02 / 4 = 0.255
		assert.equal(c.n, 4);
		assert.ok(Math.abs(c.brier! - 0.255) < 1e-12);
		// bias = mean forecast 3.2/4 = 0.8 minus observed 3/4 = 0.75 → 0.05
		assert.ok(Math.abs(c.bias! - 0.05) < 1e-12);
		const bin90 = c.bins.find((b) => b.lo === 0.9)!;
		assert.equal(bin90.n, 2);
		assert.equal(bin90.observedRecall, 0.5);
	});

	it("an empty ledger reports nulls, not zeros", () => {
		const c = calibrationOf([]);
		assert.equal(c.n, 0);
		assert.equal(c.brier, null);
		assert.equal(c.bias, null);
	});
});

// ── the JSONL adapter ───────────────────────────────────────────────────────

describe("ReviewStore (JSONL)", () => {
	it("appends only new ids and skips corrupt lines on read", () => {
		const file = tmpLedger();
		const store = createReviewStore(file);
		assert.deepEqual(store.listEvents(), []);
		const events = annotateDrafts([], [draft("e1", "a", "good", T0), draft("e2", "b", "hard", T0)]);
		assert.equal(store.appendEvents(events).length, 2);
		assert.equal(store.appendEvents(events).length, 0, "idempotent by id");
		fs.appendFileSync(file, "{torn line\n");
		fs.appendFileSync(file, `${JSON.stringify({ id: "x", v: 1 })}\n`); // shape-invalid
		assert.deepEqual(store.listEvents().map((e) => e.id), ["e1", "e2"]);
	});
});

// ── the conclude tool's rating contract ─────────────────────────────────────

describe("conclude ratings — values free, coverage enforced", () => {
	const NODES = [
		{ id: "n_iv", name: "IV relevance", statement: "An instrument must correlate with the regressor." },
		{ id: "n_ex", name: "IV exogeneity", statement: "An instrument must be uncorrelated with the error." },
	];
	const graphNodes = () => NODES;
	const ctx = { chatId: "c", chatStore: { getChat: () => ({ messages: [] as LhMessage[], kind: "practice" }) } };
	const POSE = { statement: "S", mode: "recall", target: ["n_iv", "n_ex"], modelSolution: "M" };
	const BASE = { outcome: "solved", verdict: "v", rung: null, missClass: null, retest: false };

	async function posed() {
		const gate = createPracticeGate(ctx);
		const tools = { problem: problemTool(gate, graphNodes), conclude: concludeTool(gate, graphNodes) };
		const pose = await tools.problem.execute("p", POSE as never);
		assert.equal(pose.isError, undefined);
		return tools;
	}

	it("a tagged problem cannot conclude without a rating for every target", async () => {
		const { conclude } = await posed();
		const none = await conclude.execute("c1", BASE as never);
		assert.equal(none.isError, true);
		const partial = await conclude.execute("c2", { ...BASE, ratings: [{ target: "n_iv", rating: "good", reason: "r" }] } as never);
		assert.equal(partial.isError, true);
		assert.match((partial.content[0] as { text: string }).text, /n_ex/);
	});

	it("any grade is accepted once coverage holds — even easy after surrender (no value constraints)", async () => {
		const { conclude } = await posed();
		const ok = await conclude.execute("c1", {
			...BASE,
			outcome: "surrendered",
			ratings: [
				{ target: "n_iv", rating: "easy", reason: "r" },
				{ target: "n_ex", rating: "again", reason: "r" },
			],
		} as never);
		assert.equal(ok.isError, undefined);
	});

	it("an unknown rating target is rejected; names normalize to ids", async () => {
		const { conclude } = await posed();
		const healed = conclude.prepareArguments!({
			...BASE,
			ratings: [
				{ target: "IV relevance", rating: "good", reason: "r" },
				{ target: "n_ex", rating: "hard", reason: "r" },
			],
		}) as { ratings: Array<{ target: string }> };
		assert.deepEqual(healed.ratings.map((r) => r.target), ["n_iv", "n_ex"]);
		const ghost = await conclude.execute("c1", {
			...BASE,
			ratings: [
				{ target: "n_iv", rating: "good", reason: "r" },
				{ target: "n_ex", rating: "good", reason: "r" },
				{ target: "ghost", rating: "good", reason: "r" },
			],
		} as never);
		assert.equal(ghost.isError, true);
	});

	it("an untagged problem concludes without ratings", async () => {
		const gate = createPracticeGate(ctx);
		const p = await problemTool(gate, graphNodes).execute("p", { statement: "S", mode: "recall", modelSolution: "M" } as never);
		assert.equal(p.isError, undefined);
		const c = await concludeTool(gate, graphNodes).execute("c", BASE as never);
		assert.equal(c.isError, undefined);
	});

	it("the gate seeds active targets from the record (a conclude in a later turn)", async () => {
		const record = [
			call(PRACTICE_PROBLEM_TOOL, "p", POSE, T0),
			result("p", PRACTICE_PROBLEM_TOOL, false, T0),
		];
		const gate = createPracticeGate({ chatId: "c", chatStore: { getChat: () => ({ messages: record, kind: "practice" }) } });
		assert.deepEqual(gate.activeTargets, ["n_iv", "n_ex"]);
		const c = await concludeTool(gate, graphNodes).execute("c", BASE as never);
		assert.equal(c.isError, true);
	});
});

// ── the settlement service + context text ───────────────────────────────────

describe("recordPracticeReviews + schedule text", () => {
	function deps(messages: LhMessage[], kind: string | undefined = "practice") {
		const reviewStore = createReviewStore(tmpLedger());
		return {
			reviewStore,
			chatStore: { getChat: () => ({ messages, kind }) } as never,
			graphStore: {
				readNodes: () => [
					{ id: "a", name: "Prop A", statement: "A holds." },
					{ id: "b", name: "Prop B", statement: "B holds." },
				],
			} as never,
			now: () => new Date(T0 + 30 * DAY),
		};
	}

	it("appends the record's rated reviews once; re-settling writes nothing", () => {
		const d = deps(ratedRecord());
		assert.equal(recordPracticeReviews("chat1", d), 2);
		assert.equal(recordPracticeReviews("chat1", d), 0);
		assert.equal(d.reviewStore.listEvents().length, 2);
	});

	it("non-practice chats are never read into the ledger", () => {
		// A teaching record has no kind; any non-"practice" kind must be ignored.
		assert.equal(recordPracticeReviews("chat1", deps(ratedRecord(), "teach")), 0);
	});

	it("the agent's schedule text names cards, R, history and reasons", () => {
		const d = deps(ratedRecord());
		assert.match(reviewScheduleText("due", 30, d), /No spaced-repetition cards yet/);
		recordPracticeReviews("chat1", d);
		const text = reviewScheduleText("all", 30, d);
		assert.match(text, /2 cards, 2 due/);
		assert.match(text, /\[a\] Prop A — R \d+%/);
		assert.match(text, /hard @80% \(discrimination\): needed a class nudge/);
	});

	it("summary + session-context lines for a review session", () => {
		const d = deps(ratedRecord());
		recordPracticeReviews("chat1", d);
		const s = reviewSummary(d);
		assert.equal(s.total, 2);
		assert.equal(s.dueCount, 2);
		assert.deepEqual(s.due.map((x) => x.id).sort(), ["a", "b"]);
		assert.equal(s.calibration.n, 0, "first reviews carry no forecast");
		const lines = reviewContextLines(["a"], true, d).join("\n");
		assert.match(lines, /SPACED-REPETITION REVIEW session/);
		assert.match(lines, /\[a\] Prop A/);
		assert.doesNotMatch(lines, /\[b\]/, "only the picked propositions' history");
	});
});

// ── stated confidence on thinking submissions ───────────────────────────────

describe("thinking input — optional stated confidence", () => {
	it("parses a 0–100 confidence and refuses anything else", () => {
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p", text: "t", confidence: 70 }), {
			type: "thinking",
			problemCallId: "p",
			text: "t",
			confidence: 70,
		});
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p", text: "t" }), {
			type: "thinking",
			problemCallId: "p",
			text: "t",
		});
		for (const bad of [-1, 101, "70", Number.NaN]) {
			assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p", text: "t", confidence: bad }), ChatInputError);
		}
	});

	it("the marker states confidence to the model and keeps it in details", () => {
		const m = newThinkingMessage("p", "my answer", 30);
		assert.match(m.content, /^Your thinking \(stated confidence this is correct: 30%\):\nmy answer$/);
		assert.deepEqual(m.details, { problemCallId: "p", text: "my answer", confidence: 30 });
		const plain = newThinkingMessage("p", "trace");
		assert.equal(plain.content, "Your thinking:\ntrace");
		assert.deepEqual(plain.details, { problemCallId: "p", text: "trace" });
	});
});
