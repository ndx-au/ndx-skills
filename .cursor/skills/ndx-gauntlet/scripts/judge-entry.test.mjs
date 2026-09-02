import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { cliEntryUrl } from './judge.mjs'

const JUDGE_URL = new URL('./judge.mjs', import.meta.url).href
const JUDGE = fileURLToPath(JUDGE_URL)

function runJudge(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' })
}

test('cliEntryUrl realpaths a symlink to this module', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gauntlet-judge-entry-'))
  const link = path.join(dir, 'judge.mjs')
  symlinkSync(JUDGE, link)
  const prev = process.argv[1]
  process.argv[1] = link
  try {
    assert.equal(cliEntryUrl(), JUDGE_URL)
  } finally {
    process.argv[1] = prev
  }
})

test('node via file symlink still runs main (usage on no args)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gauntlet-judge-link-'))
  const link = path.join(dir, 'judge.mjs')
  symlinkSync(JUDGE, link)
  const r = runJudge(link)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: judge/)
  assert.equal(r.stdout, '')
})

test('node via parent-directory symlink still runs main', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gauntlet-judge-dirlink-'))
  const skillRoot = path.resolve(path.dirname(JUDGE), '..')
  const linkRoot = path.join(dir, 'ndx-gauntlet')
  symlinkSync(skillRoot, linkRoot)
  const r = runJudge(path.join(linkRoot, 'scripts', 'judge.mjs'))
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: judge/)
  assert.equal(r.stdout, '')
})
