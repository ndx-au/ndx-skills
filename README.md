# ndx-skills

Cursor Agent skills for **after** a plan has been implemented. They do not write the plan or take over CreatePlan. You plan and ship as usual; these skills review what actually landed and write a leftover task list you can feed back into Cursor.

The idea is to work WITH your cursor harness, not against it.

Each skill is a folder under [`.cursor/skills/`](.cursor/skills/) (`SKILL.md` plus scripts). Clone this repo into a project, copy a folder into the project’s `.cursor/skills/`, or symlink one into `~/.cursor/skills/` for every repo on the machine.

Private NDX skills (flavored STE, desktop overlay) live in [`ndx-au/agent-skills`](https://github.com/ndx-au/agent-skills).

---

## [ndx-gauntlet](.cursor/skills/ndx-gauntlet)

**Why use it.** A single agent pass is good at looking finished. It is weaker at noticing the hazard that sits just outside the happy path: an authorization hole, a crash that leaves half a write, a test that cannot fail. Gauntlet runs five complementary critics **in parallel** against the original plan plus the diff, then merges overlapping findings into one leftover plan.

**When.** After the plan runner has marked work done — or whenever you want to know how execution fell short of a `.plan.md`. Say `gauntlet`, `review the last plan`, or `harden after implementation`.

**What you get.** `.gauntlet/outbox/superplan.md` (actionable leftovers) and a `ship` / `revise` verdict. Up to three after-passes if you implement the leftovers and run it again.

### Lenses

The gauntlet agent (the Judge) will spawn `critic` sub-agents, each of which use a different lens for what they are looking to critique. 

| Lens | Goal |
|------|------|
| **security** | Find trust-boundary mistakes the implementation left open: missing or broken authorization, injection, leaked secrets, sandbox escapes, confused deputies. |
| **correctness** | Catch silent wrongness versus the plan or spec: off-by-ones, inverted conditions, lost updates, wrong defaults, gaps the code never implemented. |
| **failure** | Ask what happens when something goes wrong: partial writes, crash/recovery, missing rollback, timeout holes, poison state, cleanup that never runs. |
| **concurrency** | Surface races and ordering bugs: shared mutable state, TOCTOU, lock inversion, stale caches across tasks. |
| **tests** | Check that coverage can actually fail: untested paths, assertions that cannot fail, missing adversarial cases, tests that only exercise the mock. |

The judge merges the same location+bug from multiple lenses into one leftover task tagged with every lens that reported it.

---

## [ndx-ui-clickthrough](.cursor/skills/ndx-ui-clickthrough)

**Why use it.** Gauntlet reads the diff. It does not click the screen. If the plan shipped pages, buttons, forms, or nav, you still need to know whether those controls work live — and whether accessibility, empty/error states, and the UI contract match what the plan promised. Clickthrough walks the confirmed origin with Playwright (or browser-use), reviews the UI with five quality lenses, and records click-ops evidence from the live session.

**When.** After an implemented plan that touched user-visible UI. Say `clickthrough`, `visual check the plan`, or `UI walk the last plan`. It asks before inventing a tour the plan never touched, and it will not walk a host you did not confirm.

**What you get.** `.clickthrough/outbox/superplan.md` plus a UI-contract draft (`ui-contract.md`). It will not overwrite a product contract under `docs/`. Prefer Playwright when the surface touches tokens or PII; it will not fall back to browser-use in that case.

Install Chromium / browser-use only after you agree; details are in the skill’s [reference.md](.cursor/skills/ndx-ui-clickthrough/reference.md).

### Lenses

| Lens | Goal |
|------|------|
| **a11y** | Make sure people can actually use the controls: accessible names, roles, keyboard paths, focus order, contrast, unlabeled buttons, missing live regions. |
| **states** | Check loading, empty, error, disabled, and offline against what the plan shipped — including dishonest status copy that pretends success. |
| **contract** | Diff routes, labels, and information architecture against the product UI contract, or against the pre-walk stub if none existed. Flag invented screens. |
| **visual** | Catch layout, overflow, stacking, and responsive breakpoints on surfaces the plan actually touched. |
| **security** | Look at the UI surface: client-side authorization theatre, XSS, secrets in the DOM, CSRF-ish clicks, open redirects. |
| **clickops** | Walk the live app (Playwright or browser-use) and record failed or blocked steps the plan called done. Written by the parent agent from the walk, not by a separate critic task. |

Five code-review lenses run in parallel with the live walk. The judge merges overlapping findings the same way gauntlet does.
