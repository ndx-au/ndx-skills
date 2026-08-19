import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  PIN,
  defaultCtx,
  findChrome,
  hasLlmKey,
  probeAll,
  probeBrowserUse,
  probePlaywright,
  spawnTimed,
} from './probe-tools.mjs'

function tmpHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'clickthrough-probe-'))
}

function pinLayout(home, { stamp = true, chrome = true } = {}) {
  const dir = path.join(home, '.cache', 'ms-playwright', 'chromium-1208', 'chrome-linux64')
  mkdirSync(dir, { recursive: true })
  const chromePath = path.join(dir, 'chrome')
  if (chrome) writeFileSync(chromePath, '')
  if (stamp) writeFileSync(path.join(home, '.cache', 'ms-playwright', 'chromium-1208', 'INSTALLATION_COMPLETE'), '')
  return chromePath
}

function launchOk(cmd, args) {
  return (
    args.includes('--no-sandbox') &&
    args.includes('--disable-dev-shm-usage') &&
    args.includes('--version')
  )
}

test('pin without INSTALLATION_COMPLETE is no-chrome', () => {
  const home = tmpHome()
  pinLayout(home, { stamp: false })
  const ctx = defaultCtx({ home, env: { HOME: home } })
  assert.equal(findChrome(ctx), '')
  const p = probePlaywright(ctx)
  assert.equal(p.ok, false)
  assert.equal(p.reason, 'no-chrome')
  assert.equal(p.pin, PIN)
})

test('stamped pin, env unset: findChrome is pin; probePlaywright uses it', () => {
  const home = tmpHome()
  const pinChrome = pinLayout(home, { stamp: true })
  const ctx = defaultCtx({
    home,
    env: { HOME: home },
    spawnSync: (cmd, args) => {
      if (cmd === pinChrome && launchOk(cmd, args)) {
        return { status: 0, stdout: 'Chromium 120.0\n', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: '' }
    },
  })
  assert.equal(findChrome(ctx), pinChrome)
  const p = probePlaywright(ctx)
  assert.equal(p.ok, true)
  assert.equal(p.chrome, pinChrome)
})

test('env chrome wins over pin', () => {
  const home = tmpHome()
  const pinChrome = pinLayout(home, { stamp: true })
  const envChrome = path.join(home, 'override-chrome')
  writeFileSync(envChrome, '')
  const ctx = defaultCtx({
    home,
    env: { HOME: home, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: envChrome },
  })
  assert.equal(findChrome(ctx), envChrome)
  assert.notEqual(findChrome(ctx), pinChrome)
})

test('non-empty missing env override does not fall back to pin', () => {
  const home = tmpHome()
  pinLayout(home, { stamp: true })
  const missing = path.join(home, 'no-such-chrome')
  const ctx = defaultCtx({
    home,
    env: { HOME: home, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: missing },
  })
  assert.equal(findChrome(ctx), '')
  const p = probePlaywright(ctx)
  assert.equal(p.ok, false)
  assert.equal(p.reason, 'no-chrome')
})

test('whitespace-only LLM keys are not a key', () => {
  const ctx = defaultCtx({
    env: {
      OPENAI_API_KEY: '   ',
      ANTHROPIC_API_KEY: '\n',
      BROWSER_USE_API_KEY: '',
      GOOGLE_API_KEY: '\t',
    },
  })
  assert.equal(hasLlmKey(ctx), false)
})

test('no-chrome / no-package / no-llm-key', () => {
  const home = tmpHome()
  const none = defaultCtx({
    home,
    env: { HOME: home },
    spawnSync: () => ({ status: 1, stdout: '', stderr: '', error: null }),
  })
  const noChrome = probePlaywright(none)
  assert.equal(noChrome.ok, false)
  assert.equal(noChrome.reason, 'no-chrome')

  const noPkg = probeBrowserUse(none)
  assert.equal(noPkg.ok, false)
  assert.equal(noPkg.reason, 'no-package')

  const withPkg = defaultCtx({
    home,
    env: { HOME: home },
    spawnSync: (cmd, args) => {
      if (cmd === 'which' && args[0] === 'browser-use') {
        return { status: 0, stdout: '/tmp/browser-use\n', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: '' }
    },
  })
  const noKey = probeBrowserUse(withPkg)
  assert.equal(noKey.ok, false)
  assert.equal(noKey.reason, 'no-llm-key')
  assert.equal(noKey.hasLlmKey, false)

  const all = probeAll(none)
  assert.equal(all.any, false)
})

test('probeAll.any is true when only browser-use is ok', () => {
  const home = tmpHome()
  const ctx = defaultCtx({
    home,
    env: { HOME: home, OPENAI_API_KEY: 'sk-test' },
    spawnSync: (cmd, args) => {
      if (cmd === 'which' && args[0] === 'browser-use') {
        return { status: 0, stdout: '/tmp/browser-use\n', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: '' }
    },
  })
  const all = probeAll(ctx)
  assert.equal(all.playwright.ok, false)
  assert.equal(all.browserUse.ok, true)
  assert.equal(all.any, true)
  assert.equal(all.chrome, undefined)
})

test('playwright.ok only after launch; spawn-error when chrome exists but --version fails', () => {
  const home = tmpHome()
  const envChrome = path.join(home, 'broken-chrome')
  writeFileSync(envChrome, '')
  const ctx = defaultCtx({
    home,
    env: { HOME: home, CHROME_PATH: envChrome },
    spawnSync: (cmd, args) => {
      if (cmd === envChrome && launchOk(cmd, args)) {
        return { status: 1, stdout: '', stderr: 'cannot exec', error: null }
      }
      return { status: 1, stdout: '', stderr: '' }
    },
  })
  assert.equal(findChrome(ctx), envChrome)
  const p = probePlaywright(ctx)
  assert.equal(p.ok, false)
  assert.equal(p.reason, 'spawn-error')
  assert.equal(p.chrome, envChrome)
})

test('playwright.ok true when chosen chrome --version succeeds', () => {
  const home = tmpHome()
  const envChrome = path.join(home, 'ok-chrome')
  writeFileSync(envChrome, '')
  let launched = false
  const ctx = defaultCtx({
    home,
    env: { HOME: home, CHROME_PATH: envChrome },
    spawnSync: (cmd, args) => {
      if (cmd === envChrome && launchOk(cmd, args)) {
        launched = true
        return { status: 0, stdout: 'Chromium 120.0\n', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: '' }
    },
  })
  const p = probePlaywright(ctx)
  assert.equal(launched, true)
  assert.equal(p.ok, true)
  assert.equal(p.chrome, envChrome)
  const all = probeAll(ctx)
  assert.equal(all.any, true)
  assert.equal(all.chrome, envChrome)
})

test('spawnTimed maps SIGKILL to spawn-timeout', () => {
  const ctx = defaultCtx({
    spawnSync: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: null }),
  })
  const r = spawnTimed(ctx, '/bin/true', [])
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'spawn-timeout')
})
