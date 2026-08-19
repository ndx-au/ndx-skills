---
name: ndx-gauntlet
description: >-
  After a Cursor plan has been implemented, compose five complementary critic
  lenses (security, correctness, failure, concurrency, tests) into one leftover
  plan. Use when the user says gauntlet, review the last plan, harden after
  implementation, or asks how execution fell short of a plan file.
---

# Gauntlet Harden

Optional **after-pass** for Cursor’s plan runner. The user plans and implements as usual. This skill reviews the original plan against what shipped and writes a composite leftover plan. It does not wrap CreatePlan.

Skill root: the directory that contains this `SKILL.md`. Inbox/outbox live in the **current project**: `.gauntlet/`.

Judge: `node <skill-root>/scripts/judge.mjs`

## Resolve the plan

1. Explicit argument, `@` mention, attached `.plan.md`, or a path in the user message.
2. Else the last plan location **already in this conversation** (Cursor’s “Plan file created at…”, `~/.cursor/plans/*.plan.md`, workspace `.cursor/plans/`). **Ask** before spending five critic passes — token budget.
3. Else stop and ask for a path. Do not glob the disk for plans.

## Loop (max 3 rounds)

1. Gather **execution**: `git diff`, changed-file list, and the plan’s todo statuses if present. If `git diff` fails (no repo), record that explicitly in the review plus a file listing — do not omit execution proof.
2. Write `.gauntlet/inbox/review.md` (must start with a `#` heading): original plan, then execution.
3. Wipe `$PWD/.gauntlet/inbox/critics/*.json` (mkdir the dir). Spawn **five** `Task` subagents **in parallel** (`generalPurpose`). Each prompt is `personaPrompt(persona, 'compose', artifact)` from `scripts/personas.mjs`, plus any files the plan names. Write **only** raw JSON (no markdown fences) via the Write tool to the **absolute** path `$PWD/.gauntlet/inbox/critics/<id>.json`. Schema `FINDING_SCHEMA`; `persona` must match the id. Optional `plan_hash` must equal the sha256 of that `review.md`. Critics assess where execution succeeded and where it fell short. If a critic file is missing or empty, **fix this prompt**, not the judge.
4. After all five Tasks return, confirm each `<id>.json` exists and parses. Then run `node <skill-root>/scripts/judge.mjs compose .gauntlet/inbox/review.md` (optional `--max-rounds 1..3`; do not pass env caps). Do **not** wipe critics inside compose — the judge loads those files. If it exits non-zero, **stop**. Empty critics are an infrastructure miss, not a clean review. Flags `--stub` / `--allow-empty` / `--max-rounds` are argv-only (no env). Do not pass `--stub` on a live run.
5. Present `.gauntlet/outbox/superplan.md` (leftover tasks live here). Do not intercept CreatePlan. If verdict is `revise` and the user wants another impl round, they can feed that composite into Cursor’s plan runner.
6. Read `.gauntlet/outbox/verdict.json` for `verdict` / `round` / coverage totals only (no critic strings):
   - `ship` → stop. Summarize residual risks.
   - `revise` and `round` < 3 → another after-pass after the next impl (max 3).
   - `round` == 3 → stop even if revise. Show residuals.

## Lenses

| id | lens |
|---|---|
| security | authz, injection, secrets, trust boundaries |
| correctness | silent wrongness, spec gaps, off-by-ones |
| failure | partial writes, crash/recovery, missing rollback |
| concurrency | races, ordering, shared mutable state |
| tests | untested paths, assertions that cannot fail |

The judge **merges** overlapping findings (same location+bug) into one task tagged with contributing lenses. Coverage scores are telemetry, not a championship.

## Do not

- Skip the judge because the review looks fine
- Treat missing or empty critic JSON as `ship`
- Wrap or block CreatePlan
- Fix skill bugs in this skill directory, not by patching a one-off copy in a product repo
