/**
 * ReviewStore — the fs JSONL adapter for the spaced-repetition ledger
 * (config.REVIEW_LOG_FILE; FSRS fork, 2026-11-03). Same idioms as the
 * graph ledgers (store/graph.ts): sync fs, append-only lines, corrupt or
 * shape-invalid lines skipped on read — a torn append never takes the
 * schedule down. Idempotent append: ids already present are skipped.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { REVIEW_LOG_FILE } from "../../config.ts";
import { isReviewRating, type ReviewEvent } from "../core/review.ts";
import type { ReviewStore } from "../core/ports.ts";

function isEvent(v: unknown): v is ReviewEvent {
	if (typeof v !== "object" || v === null) return false;
	const e = v as Record<string, unknown>;
	return (
		e.v === 1 &&
		typeof e.id === "string" &&
		typeof e.at === "string" &&
		!Number.isNaN(Date.parse(e.at)) &&
		typeof e.propositionId === "string" &&
		isReviewRating(e.rating) &&
		typeof e.chatId === "string" &&
		typeof e.concludeCallId === "string" &&
		(e.predictedR === null || typeof e.predictedR === "number")
	);
}

export function createReviewStore(file: string = REVIEW_LOG_FILE): ReviewStore {
	const read = (): ReviewEvent[] => {
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf-8");
		} catch {
			return []; // no ledger yet — nothing has ever been reviewed
		}
		const out: ReviewEvent[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (isEvent(parsed)) out.push(parsed);
			} catch {
				// Corrupt line: skip, never guess.
			}
		}
		return out;
	};
	return {
		listEvents: read,
		appendEvents(events) {
			if (events.length === 0) return [];
			const known = new Set(read().map((e) => e.id));
			const fresh: ReviewEvent[] = [];
			for (const e of events) {
				if (known.has(e.id)) continue;
				known.add(e.id);
				fresh.push(e);
			}
			if (fresh.length === 0) return [];
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, fresh.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf-8");
			return fresh;
		},
	};
}

export const reviewStore: ReviewStore = createReviewStore();
