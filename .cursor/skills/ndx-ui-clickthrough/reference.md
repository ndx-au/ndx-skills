# Clickthrough — tools, install, contract

Pin **`playwright@1.58.0`**. Pin **`browser-use==0.13.8`**. Do not add either to production Docker/Go images.

`--no-sandbox` is **loopback / operator-local** (`localhost`, `127.0.0.1`, `*.dwp.solutions`) only. Confirm the exact http(s) origin before launch; refuse off-origin redirects.

## Tool choice

| Prefer | When |
|---|---|
| Playwright | Known routes/selectors; deterministic click-and-assert; **plan/contract touches tokens or PII** |
| browser-use | Unknown selectors; exploratory flows; **and** the walk is not a token/PII/settings/key surface |

If the plan/contract touches tokens or PII and Playwright is not usable, **stop and ask to install Chromium**. Do not fall back to browser-use. Otherwise if the preferred tool is missing but the other is usable, use the other.

Probe: `node <skill-root>/scripts/probe-tools.mjs` — JSON `playwright`, `browserUse`, `any`, `chrome` (set when Playwright launched). `playwright.ok` means `--version` succeeded. A **set** env chrome path is exclusive (no pin fallback). Pin path counts only with `INSTALLATION_COMPLETE`. No PATH chrome.

Re-probe immediately before the walk. `executablePath` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` = JSON `chrome`.

## Playwright

```
$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
$HOME/.cache/ms-playwright/chromium-1208/INSTALLATION_COMPLETE
```

### Install (only after the user agrees)

Under dest flock: **delete** `INSTALLATION_COMPLETE` first. Timeout install/unzip/`--version` with `timeout -k`. Stamp only after `--version` on a regular (non-symlink) `chrome-linux64/chrome`.

```bash
DEST="$HOME/.cache/ms-playwright/chromium-1208"
mkdir -p "$DEST"
flock "$DEST/.clickthrough.lock" bash -c '
  rm -f "$DEST/INSTALLATION_COMPLETE"
  timeout -k 5s 180s deno run -A npm:playwright@1.58.0 install chromium
'
```

Hung zip (use the **exact** zip this install downloaded; never glob `/tmp/playwright-download-*`):

```bash
ZIP=<exact path from this install>
python3 - "$ZIP" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for info in z.infolist():
    name = info.filename.replace("\\", "/")
    if name.startswith("/") or ".." in name.split("/"):
        raise SystemExit(f"refuse zip member {name}")
    # symlink bit in Unix extra / external attr
    if (info.external_attr >> 16) & 0o170000 == 0o120000:
        raise SystemExit(f"refuse symlink zip member {name}")
print("ok")
PY
flock "$DEST/.clickthrough.lock" timeout -k 5s 60s unzip -q "$ZIP" -d "$DEST"
CHROME="$DEST/chrome-linux64/chrome"
test -f "$CHROME" && test ! -L "$CHROME"
timeout -k 5s 15s "$CHROME" --no-sandbox --disable-dev-shm-usage --version
touch "$DEST/INSTALLATION_COMPLETE" "$DEST/DEPENDENCIES_VALIDATED"
```

Do not invent a chrome SHA. Refuse symlink / non-file chrome instead.

### Walk script

Copy [scripts/walk-template.ts](scripts/walk-template.ts) to `.clickthrough/inbox/walk.ts` **after** gitignoring `.clickthrough/`. Confirmed origin is http(s) only.

**Never** `deno run -A`. Deno is only how this skill launches the Playwright walk script. It does not imply anything about the product’s runtime or framework.

Playwright-core 1.58 enumerates `process.env`, calls Node `os.*` (`release`, `homedir`, …), and writes launch artifacts under `/tmp`. The walk needs unlisted `--allow-env`, `--allow-sys`, and `--allow-write` for `.clickthrough/inbox` **and** `/tmp`. That is still not `deno run -A` (no blanket run/read/net).

Working allowlist (`CHROME` = probe JSON `chrome`; `ORIGIN` = `host:port` of the confirmed origin, e.g. `127.0.0.1:4173` or `example.com:443`):

```bash
timeout -k 5s 120s deno run \
  --allow-run="$CHROME" \
  --allow-read="$CHROME","$HOME/.cache/ms-playwright","$HOME/.cache/deno","$PWD/.clickthrough/inbox" \
  --allow-write=.clickthrough/inbox,/tmp \
  --allow-net="$ORIGIN",127.0.0.1,0.0.0.0 \
  --allow-env \
  --allow-sys \
  --allow-import \
  .clickthrough/inbox/walk.ts
```

`--allow-net` 127.0.0.1 / 0.0.0.0 is for Playwright’s local transport, not the product origin.

Parent maps non-zero/timeout to a **critical** `clickops` finding. `findings: []` only after a completed all-pass walk.

Locator screenshots beat full-page. Never copy live secrets into PNGs, JSON, `walk.ts`, or `review.md` (last-four only).

## browser-use

A usable walk **sends live page DOM** to the LLM vendor. Prefer Playwright for tokens/PII; do not fall back.

Pin:

```bash
uv pip install 'browser-use==0.13.8'
uvx --from 'browser-use==0.13.8' browser-use install
```

Walk: goal list from plan + contract. Pass confirmed origin as hard `allowed_domains` (or equivalent). Fail if the session URL origin changes. No settings/key pages. Publish clickops with `publish-critic.mjs clickops`.

## Click-ops critic

Failed/blocked steps become findings. Crash → **critical**. Completed all-pass:

```json
{"persona":"clickops","findings":[]}
```

## UI contract template

Pre-walk stub: `.clickthrough/inbox/ui-contract.md`. Judge copies to `.clickthrough/outbox/ui-contract.md`. Never overwrite `docs/**/ui-contract.md`.

```markdown
# <Product> — UI contract

Scope: <screens this plan touched>.
Out of scope: <explicit non-goals>.

## Principles

1. <one job per screen / honest status language / …>

## Information architecture

| Screen | Path or id | Job |
|--------|------------|-----|
| … | `/…` | … |

## Primary actions

| Screen | Control label | Result |
|--------|---------------|--------|
| … | **Exact label** | … |

## States

| Surface | Empty | Loading | Error | Disabled / offline |
|---------|-------|---------|-------|--------------------|
| … | … | … | … | … |
```

## Viewport

Match the product (mobile-first ~390×844; desktop ~1280×800).

## Gitignore

**Before** any write under `.clickthrough/`, if missing from the product `.gitignore`, add only:

```
.clickthrough/
```

## Locks and poison receipt

Inbox lock is a **live holder pid**. Crash recovery: if the pid is not alive, `reset-critics` / compose treat the lock as stale.

If compose wrote `{ "ok": false }` to `.clickthrough/outbox/receipt.json`:

```bash
rm .clickthrough/outbox/receipt.json
node <skill-root>/scripts/judge.mjs unlock-outbox
```
