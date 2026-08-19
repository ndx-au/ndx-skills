---
name: ndx-ui-clickthrough
description: >-
  After a Cursor plan has been implemented, walk click-testable UI with
  Playwright or browser-use and compose five hybrid quality lenses (a11y,
  states, contract, visual, security) plus click-ops into one leftover plan
  and a UI-contract draft. Use when the user says clickthrough, visual check
  the plan, UI walk the last plan, or asks to click-test what an executed plan
  shipped.
---

# UI Clickthrough

Optional **after-pass** for Cursor’s plan runner. The user plans and implements as usual. This skill checks whether the shipped UI is click-testable, walks it live, reviews the UI code with complementary lenses, and writes a composite leftover plan plus a UI-contract draft. It does not wrap CreatePlan.

Skill root: the directory that contains this `SKILL.md`. Inbox/outbox live in the **current project**: `.clickthrough/`. Tools, install, walk flags, contract template: [reference.md](reference.md).

Probe: `node <skill-root>/scripts/probe-tools.mjs` — use JSON `chrome` (same as `playwright.chrome` when launchable).

Judge: `node <skill-root>/scripts/judge.mjs`

Task lenses: each **object** in `TASK_PERSONAS` from `scripts/personas.mjs`. Prompt: `personaPrompt(p, 'compose', artifact)`. Schema: `TASK_FINDING_SCHEMA`.

Walk template: [scripts/walk-template.ts](scripts/walk-template.ts) — copy only **after** `.clickthrough/` is gitignored.

## Resolve the plan

1. Explicit argument, `@` mention, attached `.plan.md`, or a path in the user message.
2. Else the last plan location **already in this conversation**. **Ask** before spending click-ops + five lenses.
3. Else stop and ask for a path. Do not glob the disk for plans.

Gather **execution**: `git diff`, changed-file list, and the plan’s todo statuses if present. If `git diff` fails (no repo), record that plus a file listing.

## Gitignore first

If `.clickthrough/` is missing from the product `.gitignore`, add **only** that entry **before** any copy of `walk.ts`, probe dumps, shots, or critic JSON.

## Probe tools, install only with consent

Run the probe (JSON only). A tool is usable when `ok` is true:

- **Playwright:** Chromium **launchable**. Env `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` / `CHROME_PATH` if **set** is exclusive (no pin fallback). Pin requires `INSTALLATION_COMPLETE`. No PATH chrome.
- **browser-use:** CLI or `import browser_use`, **and** a trimmed LLM key. Do not invent keys. Do not write keys into the product `.env`.

If **neither** is usable: ask whether to install. **Decline → stop** (no critics). Do not present a stale `.clickthrough/outbox/superplan.md` as this run’s result. Install per [reference.md](reference.md). Never `curl | bash`. Never add Playwright to production Docker/Go images. Re-probe. Still unusable → stop.

If one tool is usable, continue. Only ask to install the *preferred* tool when the walk cannot succeed without it.

**Re-probe immediately before launching the walk.** Walk `executablePath` = JSON `chrome`.

## UI-testable gate

Click-ops is in-scope only if the executed plan (and/or diff) has **user-visible, clickable** surfaces: pages, routes, buttons, forms, screens, nav, dialogs, or frontend files (`.tsx` / `.vue` / `.svelte` / `.html`, templates, WASM UI, etc.).

If none — or the plan is backend / infra / docs / CLI-only — **ask** what to walk (or confirm skip). Do not invent an admin tour the plan never touched. If the user cannot name a surface, **stop**.

## UI contract + live URL

**Contract:**

1. Path in the user message.
2. Else `docs/ui-contract.md`.
3. Else bounded glob `docs/**/ui-contract.md`. **Ignore** `.clickthrough/**`, `node_modules/**`, other skills.
4. Else links from `AGENTS.md` / `README.md`.

Never treat `.clickthrough/outbox/ui-contract.md` as the product contract. Never overwrite the product file.

**URL:** candidate from user / plan / `CLICKTHROUGH_BASE_URL` / `DOCS_BASE_URL` / `AGENTS.md` / README. Then **AskQuestion to confirm the exact origin** (http(s) only). Do not guess a host. Refuse off-origin redirects. `--no-sandbox` is loopback / operator-local only.

## Choose Playwright vs browser-use

Pick using [reference.md](reference.md). Prefer Playwright when the plan/contract touches tokens or PII. **If the plan/contract touches tokens or PII and Playwright is not usable, stop and ask to install Chromium — do not fall back to browser-use.** Otherwise, if the preferred tool is missing but the other is usable, use the other.

Playwright: copy the walk template to `.clickthrough/inbox/walk.ts`; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` = probe JSON `chrome`.

browser-use: goal list from plan + contract. Pass the confirmed origin as a hard `allowed_domains` (or equivalent) constraint; fail if the session URL origin changes. **Do not** include settings/key pages. Never paste secrets into goals, critic JSON, `walk.ts`, or `review.md`.

## Loop (max 3 rounds)

1. Write `.clickthrough/inbox/review.md` (must start with `#`): original plan, execution, contract path or `none`, confirmed origin, chosen tool.
2. Write a **pre-walk** `.clickthrough/inbox/ui-contract.md` stub (plan + template, or copy the product contract). The **contract** lens diffs this file.
3. `node <skill-root>/scripts/judge.mjs reset-critics` — lock holder + **rename** `critics/` aside, mkdir fresh. Never `rm critics/*.json` after writers start. Lock stays held (live pid).
4. Spawn **five** `Task` subagents **in parallel** (`generalPurpose`) — one per **object** in `TASK_PERSONAS`. `personaPrompt(p, 'compose', artifact)` plus files the plan names. Schema `TASK_FINDING_SCHEMA`. Publish with `node <skill-root>/scripts/publish-critic.mjs <id>` (refuses unless inbox lock is live) or tmp+`mv`. Optional `plan_hash` = sha256 of `review.md`.
5. **At the same time**, click-ops on the parent. **Re-probe first.** Crash/timeout/non-zero → **critical** `clickops` finding (`stderr` plus step) before compose. `findings: []` only after a completed all-pass walk. Do **not** spawn a Task for `clickops`.
6. After five Tasks return **and** `clickops.json` exists, confirm all six JSON files parse. Refine `inbox/ui-contract.md`. Then `node <skill-root>/scripts/judge.mjs unlock-inbox` (fails unless six files parse) and `node <skill-root>/scripts/judge.mjs compose .clickthrough/inbox/review.md`. Compose **fails** if the inbox lock pid is still alive. Do **not** wipe critics inside compose. If compose exits non-zero, **stop**. Poison receipt: delete `.clickthrough/outbox/receipt.json` (and `unlock-outbox` if a dead/wedged outbox lock remains). `--stub` / `--allow-empty` / `--max-rounds` are argv-only. Do not pass `--stub` on a live run.
7. Present `.clickthrough/outbox/superplan.md`. Do not intercept CreatePlan. Judge copies `inbox/ui-contract.md` to outbox in the same publish set.
8. Read `.clickthrough/outbox/verdict.json` for `verdict` / `round` / coverage totals only:
   - `ship` → stop. Summarize residual risks.
   - `revise` and `round` < 3 → another after-pass after the next impl (max 3).
   - `round` == 3 → stop even if revise.

## Lenses

| id | lens |
|---|---|
| a11y | names, roles, keyboard, focus, contrast, unlabeled controls |
| states | loading / empty / error / disabled / offline vs what the plan shipped |
| contract | routes, labels, IA vs product ui-contract and/or the pre-walk stub |
| visual | layout, overflow, stacking, responsive breakpoints touched by the plan |
| security | UI-surface authz, XSS, secret-in-DOM, CSRF-ish clicks, open redirects |
| clickops | live click/assert evidence (parent writes this file; not a Task persona) |

The judge **merges** overlapping findings (same location+bug). Coverage scores are telemetry.

## Do not

- Skip the judge because the walk looked fine
- Treat missing or empty critic JSON as `ship`
- Wrap or block CreatePlan
- Install tools after the user declined
- Walk without a **confirmed** http(s) origin
- Fall back to browser-use on token/PII surfaces when Playwright is missing
- Overwrite an existing product UI contract
- Run `walk.ts` with `deno run -A`
- Use findings `[]` on clickops after a crashed walk
- Fix skill bugs in this skill directory, not by patching a one-off copy in a product repo
