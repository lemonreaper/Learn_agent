"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { LEARNER_PROFILE_MAX_CHARS } from "@/src/core";

/**
 * ABOUT ME (fork, 2026-11-03): the learner profile — field, work, goals —
 * written once and composed into every conversation agent's system prompt
 * (prober, teacher, practice). Explicit Save, not save-on-type: the text
 * rides every model call, so a half-typed sentence must never ship.
 */
export function LearnerSection({
	profile,
	onSave,
}: {
	profile: string;
	onSave: (profile: string) => Promise<void> | void;
}) {
	const [draft, setDraft] = useState(profile);
	const [saving, setSaving] = useState(false);
	// A server-side change (another window, the first load) resets the draft.
	useEffect(() => setDraft(profile), [profile]);
	const dirty = draft.trim() !== profile.trim();
	const over = draft.trim().length > LEARNER_PROFILE_MAX_CHARS;
	return (
		<div data-testid="learner-section" className="space-y-3 px-6 py-5">
			<p className="text-xs text-muted-foreground">
				Who you are and where you are heading — field, work, study and career goals, what you want to be able to do.
				Every session (probe, teaching, practice) reads this, so you never have to re-explain it. It shapes plans,
				priorities and examples; it is not treated as proof of what you already know. It is sent to your model
				provider with every request — keep anything private out.
			</p>
			<textarea
				data-testid="learner-profile"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				rows={12}
				placeholder={
					"E.g.: Econometrics student; analyst in an anti-fraud modeling team (PySpark, SQL). Goal: a Data Science / Economics master's in Germany, and Data Analyst interviews. Prefer examples from fraud detection and econometrics."
				}
				className="lh-input w-full resize-y rounded-md border border-border bg-background/60 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50"
			/>
			<div className="flex items-center justify-between gap-2">
				<span
					data-testid="learner-profile-count"
					className={`font-mono text-xs tabular-nums ${over ? "text-red-500" : "text-muted-foreground"}`}
				>
					{draft.trim().length} / {LEARNER_PROFILE_MAX_CHARS}
				</span>
				<Button
					type="button"
					data-testid="learner-profile-save"
					disabled={!dirty || over || saving}
					onClick={async () => {
						setSaving(true);
						try {
							await onSave(draft.trim());
						} finally {
							setSaving(false);
						}
					}}
					className="h-8 px-3 text-sm"
				>
					{saving ? "Saving…" : dirty ? "Save" : "Saved"}
				</Button>
			</div>
		</div>
	);
}
