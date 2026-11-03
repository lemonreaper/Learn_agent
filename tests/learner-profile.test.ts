/**
 * The learner profile (fork, 2026-11-03): settings' learner.profile is
 * standing context composed into every conversation agent's system prompt.
 * Record sanitizer, effective resolution, the strict PUT parser, and the
 * prompt composition for prober, teacher and practice agents.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FACTORY_SETTINGS,
	LEARNER_PROFILE_MAX_CHARS,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseLearnerSettingsBody, SETTINGS_SECTIONS } from "../src/server/settings-body.ts";
import {
	composeInstructions,
	createPracticeAgent,
	createProberAgent,
	createTeacherAgent,
	withLearnerProfile,
} from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";

const PROFILE = "Econometrics student; anti-fraud analyst. Goal: DS master's in Germany.";

describe("learner settings — record, resolution, PUT", () => {
	it("the sanitizer trims, caps, and drops non-strings", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, learner: { profile: `  ${PROFILE}  ` } })?.learner, { profile: PROFILE });
		const long = "x".repeat(LEARNER_PROFILE_MAX_CHARS + 50);
		assert.equal(sanitizeUserSettings({ version: 1, learner: { profile: long } })?.learner?.profile?.length, LEARNER_PROFILE_MAX_CHARS);
		assert.deepEqual(sanitizeUserSettings({ version: 1, learner: { profile: 42 } })?.learner, {});
		assert.equal(sanitizeUserSettings({ version: 1 })?.learner, undefined);
	});

	it("resolves to the factory empty profile when unset", () => {
		assert.equal(FACTORY_SETTINGS.learner.profile, "");
		assert.equal(resolveSettings(null).learner.profile, "");
		assert.equal(resolveSettings({ version: 1, learner: { profile: PROFILE } }).learner.profile, PROFILE);
	});

	it("the PUT parser is strict: refuses non-strings and over-long text", () => {
		assert.ok("learner" in SETTINGS_SECTIONS);
		assert.deepEqual(parseLearnerSettingsBody({ profile: ` ${PROFILE} ` }), { ok: true, settings: { profile: PROFILE } });
		assert.deepEqual(parseLearnerSettingsBody({}), { ok: true, settings: {} });
		assert.equal(parseLearnerSettingsBody({ profile: 7 }).ok, false);
		assert.equal(parseLearnerSettingsBody({ profile: "x".repeat(LEARNER_PROFILE_MAX_CHARS + 1) }).ok, false);
	});
});

describe("learner profile in the system prompt", () => {
	it("an empty profile leaves the prompt byte-identical", () => {
		assert.equal(withLearnerProfile("BASE", ""), "BASE");
		assert.equal(withLearnerProfile("BASE", "   "), "BASE");
		assert.equal(withLearnerProfile("BASE", undefined), "BASE");
	});

	it("a profile is appended LAST, fenced, with the context-not-knowledge rule", () => {
		const out = withLearnerProfile("BASE", PROFILE);
		assert.ok(out.startsWith("BASE"), "the doctrine stays a stable, cacheable prefix");
		assert.ok(out.endsWith(`<learner_profile>\n${PROFILE}\n</learner_profile>`));
		assert.match(out, /context, not evidence of knowledge/);
	});

	it("prober, teacher and practice agents all carry it", () => {
		const engine = {
			model: { provider: "test", id: "test-model", api: "faux" },
			streamFn: () => {
				throw new Error("never called");
			},
			level: "off",
		} as unknown as PiEngine;
		const ctx = { chatId: "c", chatStore: { getChat: () => ({ messages: [], kind: "practice" }) } };
		const opts = { engine, learnerProfile: PROFILE, tools: {} };
		const builds = [
			["prober", createProberAgent(ctx as never, opts)],
			["teacher", createTeacherAgent(ctx as never, opts)],
			["practice", createPracticeAgent(ctx as never, opts)],
		] as const;
		for (const [kind, agent] of builds) {
			const prompt = agent.state.systemPrompt;
			assert.ok(prompt.startsWith(composeInstructions(kind)), `${kind}: doctrine first`);
			assert.ok(prompt.includes(PROFILE), `${kind}: profile present`);
		}
		const plain = createPracticeAgent(ctx as never, { engine, tools: {} });
		assert.equal(plain.state.systemPrompt, composeInstructions("practice"));
	});
});
