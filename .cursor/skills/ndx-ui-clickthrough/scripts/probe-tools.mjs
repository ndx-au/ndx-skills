#!/usr/bin/env node
/** Detect Playwright Chromium and browser-use. No network. JSON stdout only. */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const PIN = 'playwright@1.58.0'
export const PINNED_REL = path.join('.cache', 'ms-playwright', 'chromium-1208', 'chrome-linux64', 'chrome')
export const STAMP_REL = path.join('.cache', 'ms-playwright', 'chromium-1208', 'INSTALLATION_COMPLETE')
export const SPAWN_TIMEOUT_MS = 8000
export const CHROME_LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage']
export const LLM_KEYS = ['BROWSER_USE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']

export function defaultCtx(overrides = {}) {
  return {
    env: overrides.env ?? process.env,
    home: overrides.home ?? process.env.HOME ?? os.homedir(),
    spawnSync: overrides.spawnSync ?? spawnSync,
    existsSync: overrides.existsSync ?? existsSync,
  }
}

export function pinnedChromePath(home) {
  return path.join(home, PINNED_REL)
}

export function installationCompletePath(home) {
  return path.join(home, STAMP_REL)
}

export function spawnTimed(ctx, command, args, extra = {}) {
  try {
    const r = ctx.spawnSync(command, args, {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      detached: true,
      ...extra,
    })
    const timedOut =
      r.error?.code === 'ETIMEDOUT' ||
      r.error?.code === 'ERR_SPAWN_TIMEOUT' ||
      r.signal === 'SIGKILL' ||
      r.signal === 'SIGTERM'
    if (timedOut) return { ok: false, reason: 'spawn-timeout', status: r.status, stdout: r.stdout, stderr: r.stderr }
    if (r.error) return { ok: false, reason: 'spawn-error', status: r.status, stdout: r.stdout, stderr: r.stderr }
    if (r.status !== 0) return { ok: false, reason: 'spawn-error', status: r.status, stdout: r.stdout, stderr: r.stderr }
    return { ok: true, status: r.status, stdout: r.stdout, stderr: r.stderr }
  } catch (error) {
    const timedOut = error?.code === 'ETIMEDOUT' || error?.code === 'ERR_SPAWN_TIMEOUT'
    return { ok: false, reason: timedOut ? 'spawn-timeout' : 'spawn-error' }
  }
}

export function which(ctx, cmd) {
  const r = spawnTimed(ctx, 'which', [cmd])
  if (!r.ok) return ''
  return String(r.stdout ?? '').trim()
}

export function hasLlmKey(ctx = defaultCtx()) {
  return LLM_KEYS.some((k) => Boolean(String(ctx.env[k] ?? '').trim()))
}

export function envChromeOverride(ctx = defaultCtx()) {
  return String(ctx.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || ctx.env.CHROME_PATH || '').trim()
}

/** Env override, if set, is exclusive (no pin fallback). Pin chrome only with INSTALLATION_COMPLETE. */
export function findChrome(ctx = defaultCtx()) {
  const envPath = envChromeOverride(ctx)
  if (envPath) return ctx.existsSync(envPath) ? envPath : ''
  const pin = pinnedChromePath(ctx.home)
  const stamp = installationCompletePath(ctx.home)
  if (ctx.existsSync(pin) && ctx.existsSync(stamp)) return pin
  return ''
}

export function probePlaywright(ctx = defaultCtx()) {
  const override = envChromeOverride(ctx)
  const chrome = findChrome(ctx)
  if (!chrome) {
    return { ok: false, pin: PIN, reason: 'no-chrome', override: override || undefined }
  }
  const launched = spawnTimed(ctx, chrome, [...CHROME_LAUNCH_ARGS, '--version'])
  if (!launched.ok) {
    return { ok: false, pin: PIN, chrome, reason: launched.reason || 'spawn-error' }
  }
  return { ok: true, pin: PIN, chrome, version: String(launched.stdout ?? '').trim() || undefined }
}

export function probeBrowserUse(ctx = defaultCtx()) {
  const cli = which(ctx, 'browser-use')
  const py = which(ctx, 'python3') || which(ctx, 'python')
  let pythonVersion = ''
  let pythonImport = false
  if (py) {
    const v = spawnTimed(ctx, py, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'])
    if (v.reason === 'spawn-timeout' || v.reason === 'spawn-error') {
      return {
        ok: false,
        python: py,
        cli: cli || undefined,
        hasLlmKey: hasLlmKey(ctx),
        reason: v.reason,
      }
    }
    pythonVersion = String(v.stdout ?? '').trim()
    const imp = spawnTimed(ctx, py, ['-c', 'import browser_use'])
    if (imp.reason === 'spawn-timeout') {
      return {
        ok: false,
        python: py,
        pythonVersion: pythonVersion || undefined,
        cli: cli || undefined,
        hasLlmKey: hasLlmKey(ctx),
        reason: 'spawn-timeout',
      }
    }
    pythonImport = imp.ok
  }
  const key = hasLlmKey(ctx)
  const pkg = Boolean(cli) || pythonImport
  const base = {
    python: py || undefined,
    pythonVersion: pythonVersion || undefined,
    cli: cli || undefined,
    hasLlmKey: key,
  }
  if (!pkg) return { ok: false, ...base, reason: 'no-package' }
  if (!key) return { ok: false, ...base, reason: 'no-llm-key' }
  return { ok: true, ...base }
}

export function probeAll(ctx = defaultCtx()) {
  const playwright = probePlaywright(ctx)
  const browserUse = probeBrowserUse(ctx)
  return {
    playwright,
    browserUse,
    any: Boolean(playwright.ok || browserUse.ok),
    chrome: playwright.ok ? playwright.chrome : undefined,
  }
}

function printProbe() {
  try {
    console.log(JSON.stringify(probeAll(), null, 2))
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          playwright: { ok: false, pin: PIN, reason: 'spawn-error' },
          browserUse: { ok: false, reason: 'spawn-error' },
          any: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    )
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  printProbe()
}
