import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PERSONAS, TASK_PERSONAS } from './personas.mjs'
import {
  CasAbortError,
  EMPTY_CRITICS,
  POISON_RECOVERY,
  hash,
  publishOutbox,
} from './judge.mjs'

const JUDGE = fileURLToPath(new URL('./judge.mjs', import.meta.url))
const PUBLISH = fileURLToPath(new URL('./publish-critic.mjs', import.meta.url))
const CANNED_A11Y_BUG =
  'Primary Save control is an icon-only button with no accessible name and no associated label'

function tmpCwd() {
  return mkdtempSync(path.join(os.tmpdir(), 'clickthrough-judge-'))
}

function writeInbox(cwd, { review, critics, contract }) {
  const inbox = path.join(cwd, '.clickthrough', 'inbox')
  mkdirSync(path.join(inbox, 'critics'), { recursive: true })
  writeFileSync(path.join(inbox, 'review.md'), review)
  if (contract != null) writeFileSync(path.join(inbox, 'ui-contract.md'), contract)
  for (const [id, body] of Object.entries(critics)) {
    writeFileSync(path.join(inbox, 'critics', `${id}.json`), body)
  }
}

function compose(cwd, args = []) {
  return spawnSync(process.execPath, [JUDGE, 'compose', ...args], {
    cwd,
    encoding: 'utf8',
  })
}

function judgeCmd(cwd, args) {
  return spawnSync(process.execPath, [JUDGE, ...args], {
    cwd,
    encoding: 'utf8',
  })
}

function emptyReport(id) {
  return `${JSON.stringify({ persona: id, findings: [] })}\n`
}

function findingReport(id, extra = {}) {
  return `${JSON.stringify({
    persona: id,
    ...extra,
    findings: [
      {
        id: `${id}-1`,
        severity: 'low',
        location: 'tests',
        bug: 'leftover hazard recorded so reportsAreEmpty is false',
        predicted: 'still leftover',
        fix_hint: 'fix the leftover',
      },
    ],
  })}\n`
}

function killPid(pid) {
  if (!pid) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

const REVIEW = '# Test review\n\nplan plus execution\n'

test('TASK_PERSONAS is the five non-clickops ids', () => {
  assert.deepEqual(
    TASK_PERSONAS.map((p) => p.id),
    ['a11y', 'states', 'contract', 'visual', 'security'],
  )
  assert.equal(PERSONAS.some((p) => p.id === 'clickops'), true)
  assert.equal(PERSONAS.length, 6)
})

test('six present empty findings is every-critic-was-empty, not ENOENT', () => {
  const cwd = tmpCwd()
  const critics = Object.fromEntries(PERSONAS.map((p) => [p.id, emptyReport(p.id)]))
  writeInbox(cwd, { review: REVIEW, critics })
  const r = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md')])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /every critic was empty/)
  assert.doesNotMatch(r.stderr, /critic files incomplete/)
  assert.doesNotMatch(r.stderr, /ENOENT/)
  assert.equal(r.stderr.includes(EMPTY_CRITICS.split('\n')[0]), true)
})

test('--allow-empty succeeds when six empty finding files are present', () => {
  const cwd = tmpCwd()
  const critics = Object.fromEntries(PERSONAS.map((p) => [p.id, emptyReport(p.id)]))
  writeInbox(cwd, { review: REVIEW, critics })
  const r = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md'), '--allow-empty'])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.verdict, 'ship')
})

test('missing clickops.json is critic files incomplete, not empty-all', () => {
  const cwd = tmpCwd()
  const critics = Object.fromEntries(TASK_PERSONAS.map((p) => [p.id, findingReport(p.id)]))
  writeInbox(cwd, { review: REVIEW, critics })
  const r = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md')])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /critic files incomplete/)
  assert.match(r.stderr, /clickops: missing/)
  assert.doesNotMatch(r.stderr, /every critic was empty/)
})

test('--allow-empty + missing clickops.json is incomplete, not ship', () => {
  const cwd = tmpCwd()
  const critics = Object.fromEntries(TASK_PERSONAS.map((p) => [p.id, emptyReport(p.id)]))
  writeInbox(cwd, { review: REVIEW, critics })
  const r = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md'), '--allow-empty'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /critic files incomplete/)
  assert.match(r.stderr, /clickops: missing/)
  assert.doesNotMatch(r.stderr, /every critic was empty/)
  assert.equal(existsSync(path.join(cwd, '.clickthrough', 'outbox', 'superplan.md')), false)
})

test('plan_hash mismatch fail-closes', () => {
  const cwd = tmpCwd()
  const critics = Object.fromEntries(PERSONAS.map((p) => [p.id, findingReport(p.id, { plan_hash: 'deadbeef' })]))
  writeInbox(cwd, { review: REVIEW, critics })
  const r = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md')])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /plan_hash mismatch/)
  assert.notEqual(hash(REVIEW), 'deadbeef')
})

test('compose requires all six including clickops when hashes match and copies ui-contract', () => {
  const cwd = tmpCwd()
  const planHash = hash(REVIEW)
  const critics = Object.fromEntries(PERSONAS.map((p) => [p.id, findingReport(p.id, { plan_hash: planHash })]))
  writeInbox(cwd, { review: REVIEW, critics, contract: '# Inbox contract\n' })
  const r = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md')])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.verdict, 'ship')
  assert.equal(readFileSync(path.join(cwd, '.clickthrough', 'outbox', 'ui-contract.md'), 'utf8'), '# Inbox contract\n')
})

test('inbox lock held fails compose before empty/missing checks', () => {
  const cwd = tmpCwd()
  writeInbox(cwd, { review: REVIEW, critics: {} })
  writeFileSync(path.join(cwd, '.clickthrough', 'inbox', '.lock'), `${process.pid}\n`)
  const r = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md')])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /inbox lock held/)
})

test('--stub still loads canned fixtures (not live inbox)', () => {
  const cwd = tmpCwd()
  writeInbox(cwd, { review: REVIEW, critics: {} })
  const r = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md'), '--stub'])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.verdict, 'revise')
})

test('--stub with six planted live ship critics still revises from canned highs', () => {
  const cwd = tmpCwd()
  const critics = Object.fromEntries(PERSONAS.map((p) => [p.id, findingReport(p.id)]))
  writeInbox(cwd, { review: REVIEW, critics })
  const live = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md')])
  assert.equal(live.status, 0, live.stderr)
  assert.equal(JSON.parse(live.stdout).verdict, 'ship')

  const r = compose(cwd, [path.join(cwd, '.clickthrough', 'inbox', 'review.md'), '--stub'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).verdict, 'revise')
  const superplan = readFileSync(path.join(cwd, '.clickthrough', 'outbox', 'superplan.md'), 'utf8')
  assert.match(superplan, new RegExp(CANNED_A11Y_BUG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(superplan, /leftover hazard recorded so reportsAreEmpty is false/)
})

test('publish-critic refuses unless inbox lock is live', () => {
  const cwd = tmpCwd()
  mkdirSync(path.join(cwd, '.clickthrough', 'inbox', 'critics'), { recursive: true })
  const r = spawnSync(process.execPath, [PUBLISH, 'a11y'], {
    cwd,
    encoding: 'utf8',
    input: emptyReport('a11y'),
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /inbox lock not held/)
})

test('reset-critics moves critics aside, holds lock until unlock-inbox with six files', async () => {
  const cwd = tmpCwd()
  writeInbox(cwd, { review: REVIEW, critics: { a11y: emptyReport('a11y') } })
  const reset = judgeCmd(cwd, ['reset-critics'])
  let holderPid
  try {
    assert.equal(reset.status, 0, reset.stderr)
    const info = JSON.parse(reset.stdout)
    holderPid = info.pid
    assert.equal(typeof holderPid, 'number')
    await new Promise((r) => setTimeout(r, 50))
    process.kill(holderPid, 0)
    assert.equal(existsSync(path.join(cwd, '.clickthrough', 'inbox', 'critics', 'a11y.json')), false)
    const bak = readdirSync(path.join(cwd, '.clickthrough', 'inbox')).filter((n) => n.startsWith('critics.bak.'))
    assert.equal(bak.length, 1)
    assert.equal(existsSync(path.join(cwd, '.clickthrough', 'inbox', bak[0], 'a11y.json')), true)

    const tooSoon = judgeCmd(cwd, ['unlock-inbox'])
    assert.notEqual(tooSoon.status, 0)
    assert.match(tooSoon.stderr, /critic files incomplete/)
    process.kill(holderPid, 0)

    const pub = spawnSync(process.execPath, [PUBLISH, 'a11y'], {
      cwd,
      encoding: 'utf8',
      input: emptyReport('a11y'),
    })
    assert.equal(pub.status, 0, pub.stderr)

    for (const p of PERSONAS) {
      writeFileSync(path.join(cwd, '.clickthrough', 'inbox', 'critics', `${p.id}.json`), emptyReport(p.id))
    }
    const unlocked = judgeCmd(cwd, ['unlock-inbox'])
    assert.equal(unlocked.status, 0, unlocked.stderr)
    assert.equal(existsSync(path.join(cwd, '.clickthrough', 'inbox', '.lock')), false)
    holderPid = null
  } finally {
    killPid(holderPid)
  }
})

test('publishOutbox: CAS abort after staging leaves dests; non-CAS failAfter poisons', async () => {
  const cwd = tmpCwd()
  const prevCwd = process.cwd()
  process.chdir(cwd)
  try {
    const outbox = path.join(cwd, '.clickthrough', 'outbox')
    mkdirSync(outbox, { recursive: true })
    const superplanPath = path.join(outbox, 'superplan.md')
    const verdictPath = path.join(outbox, 'verdict.json')
    const receiptPath = path.join(outbox, 'receipt.json')
    const contractPath = path.join(outbox, 'ui-contract.md')
    writeFileSync(superplanPath, 'PREV SUPERPLAN\n')
    writeFileSync(verdictPath, '{"verdict":"old"}\n')
    writeFileSync(contractPath, 'PREV CONTRACT\n')
    const prev = { plan_hash: 'abc', round: 1 }
    writeFileSync(receiptPath, `${JSON.stringify(prev)}\n`)

    await assert.rejects(
      () =>
        publishOutbox({
          outbox,
          superplanText: 'NEW SUPER',
          verdictObj: { verdict: 'ship' },
          receiptObj: { plan_hash: 'abc', round: 2 },
          prev,
          planHash: 'abc',
          round: 2,
          contractText: 'NEW CONTRACT',
          failAfter: 'before-rename',
        }),
      (err) => err instanceof CasAbortError,
    )
    assert.equal(readFileSync(superplanPath, 'utf8'), 'PREV SUPERPLAN\n')
    assert.equal(readFileSync(verdictPath, 'utf8'), '{"verdict":"old"}\n')
    assert.equal(readFileSync(contractPath, 'utf8'), 'PREV CONTRACT\n')
    assert.equal(readFileSync(receiptPath, 'utf8'), `${JSON.stringify(prev)}\n`)

    await publishOutbox({
      outbox,
      superplanText: 'NEW SUPER',
      verdictObj: { verdict: 'ship' },
      receiptObj: { plan_hash: 'abc', round: 2 },
      prev,
      planHash: 'abc',
      round: 2,
      contractText: 'INBOX CONTRACT',
    })
    assert.equal(readFileSync(contractPath, 'utf8'), 'INBOX CONTRACT\n')

    writeFileSync(superplanPath, 'KEEP ME\n')
    const after = JSON.parse(readFileSync(receiptPath, 'utf8'))
    await assert.rejects(() =>
      publishOutbox({
        outbox,
        superplanText: 'POISON SUPER',
        verdictObj: { verdict: 'revise' },
        receiptObj: { plan_hash: 'abc', round: 3 },
        prev: after,
        planHash: 'abc',
        round: 3,
        contractText: 'POISON CONTRACT',
        failAfter: 'verdict',
      }),
    )
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assert.equal(receipt.ok, false)
    assert.equal(receipt.recovery, POISON_RECOVERY)
    assert.equal(readFileSync(superplanPath, 'utf8'), 'KEEP ME\n')
    assert.equal(readFileSync(contractPath, 'utf8'), 'INBOX CONTRACT\n')
  } finally {
    process.chdir(prevCwd)
  }
})
