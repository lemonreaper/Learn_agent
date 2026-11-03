# Learn_agent — a fork of LearnHarness

This repository is a modified fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist, based on release 0.4.1 (`e69e852`). It is licensed under AGPL-3.0 like the original.

## Changes from upstream

- **Spaced repetition (FSRS).** Practice now feeds a long-term review schedule: graph propositions become cards, and the practice agent grades each target of a concluded problem (`again | hard | good | easy`, with a reason). Scheduling uses `ts-fsrs` with default weights. See `docs/architecture.md` §4a.
- **Stated confidence.** The practice dock has an optional confidence slider, and the agent reads it when grading.
- **Review sessions.** The home screen has a "Review N due" button that seeds a practice session with due cards. The agent gets a `review_queue` tool and full freedom over how to run the review.
- **Forecast calibration.** Every review stores FSRS's forecast recall before it happens. A panel compares forecasts with observed recall (bias, Brier score, reliability bins), which is how the agent's grading is monitored.
- **Update feed.** The desktop auto-updater reads this repository's releases, not upstream's. Without this, a fork build would update itself back to a version without FSRS.

## Building installers

Open Actions → Release → Run workflow and pick the branch. The run produces unsigned Windows, Linux and macOS installers as artifacts, kept for 7 days. See `docs/desktop-release.md`.
