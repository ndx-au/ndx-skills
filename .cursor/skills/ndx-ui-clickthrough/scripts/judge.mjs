#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PERSONAS,
  buildSuperplan,
  reportsAreEmpty,
  judgeReports,
  normalizeReport,
  parseJsonObject,
} from './personas.mjs'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JUDGE_SELF = fileURLToPath(import.meta.url)
let MAX_ROUNDS = 3

export const WRITERS_LIVE = 'clickthrough fail-closed: inbox lock held (writers live)'
export const OUTBOX_LOCK_HELD = 'clickthrough fail-closed: outbox lock held'
export const EMPTY_CRITICS =
  'clickthrough fail-closed: every critic was empty or missing. That is an infrastructure miss, not a clean review. Re-run critics or pass --allow-empty only if you truly accept a no-finding review.'
export const POISON_RECOVERY = 'delete .clickthrough/outbox/receipt.json'

export class CasAbortError extends Error {
  constructor(reason = 'lost increment') {
    super(`clickthrough fail-closed: receipt changed during compose (${reason})`)
    this.name = 'CasAbortError'
    this.reason = reason
  }
}

export class JudgeFailError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'JudgeFailError'
    this.exitCode = exitCode
  }
}

export function cwdRoot() {
  return process.cwd()
}

export function inboxDir() {
  return path.join(cwdRoot(), '.clickthrough', 'inbox')
}

export function outboxDir() {
  return path.join(cwdRoot(), '.clickthrough', 'outbox')
}

export function criticsDir() {
  return path.join(inboxDir(), 'critics')
}

export function inboxLockPath() {
  return path.join(inboxDir(), '.lock')
}

export function outboxLockPath() {
  return path.join(outboxDir(), '.lock')
}

export function readLockPid(lockFile) {
  try {
    const line = String(readFileSync(lockFile, 'utf8')).split('\n')[0].trim()
    const pid = Number(line)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'EPERM') return true
    return false
  }
}

export function lockIsLive(lockFile) {
  if (!existsSync(lockFile)) return false
  const pid = readLockPid(lockFile)
  return pid != null && pidAlive(pid)
}

export function lockHeld(lockFile) {
  return lockIsLive(lockFile)
}

export async function acquireLock(lockFile) {
  await mkdir(path.dirname(lockFile), { recursive: true })
  if (existsSync(lockFile) && !lockIsLive(lockFile)) {
    await unlink(lockFile).catch(() => {})
  }
  try {
    const fh = await open(lockFile, 'wx')
    await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`)
    return fh
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (lockIsLive(lockFile)) return null
    await unlink(lockFile).catch(() => {})
    try {
      const fh = await open(lockFile, 'wx')
      await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`)
      return fh
    } catch (retry) {
      if (retry?.code === 'EEXIST') return null
      throw retry
    }
  }
}

export async function releaseLock(lockFile, fh) {
  const pid = process.pid
  await fh?.close().catch(() => {})
  if (readLockPid(lockFile) === pid || readLockPid(lockFile) == null) {
    await unlink(lockFile).catch(() => {})
  }
}

function parseIntegerRounds(raw, label) {
  if (!/^[0-9]+$/.test(String(raw ?? ''))) {
    fail(`${label} must be an integer 1..3 (got ${raw})`)
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 3) {
    fail(`${label} must be an integer 1..3 (got ${raw})`)
  }
  return n
}

function parseComposeArgs(args) {
  let stub = false
  let allowEmpty = false
  let maxRounds = 3
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--stub') stub = true
    else if (a === '--allow-empty') allowEmpty = true
    else if (a === '--max-rounds') {
      maxRounds = parseIntegerRounds(args[i + 1], '--max-rounds')
      i += 1
    } else if (a.startsWith('--')) fail(`unknown flag ${a}`)
    else positional.push(a)
  }
  return { stub, allowEmpty, maxRounds, file: positional[0] }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'compose': {
      const flags = parseComposeArgs(rest)
      MAX_ROUNDS = flags.maxRounds
      await runCompose(flags)
      break
    }
    case 'status':
      await status()
      break
    case 'reset-critics':
      await resetCritics()
      break
    case 'unlock-inbox':
      await unlockInbox()
      break
    case 'unlock-outbox':
      await unlockOutbox()
      break
    case 'hold-lock':
      await holdLock(rest[0])
      break
    default:
      console.error(
        'usage: judge <compose|status|reset-critics|unlock-inbox|unlock-outbox> [file] [--stub] [--allow-empty] [--max-rounds 1..3]',
      )
      process.exit(2)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(pred, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await pred()) return true
    await sleep(20)
  }
  return pred()
}

async function holdLock(lockFile) {
  if (!lockFile) fail('hold-lock requires a lock path')
  const abs = path.resolve(lockFile)
  const fh = await acquireLock(abs)
  if (!fh) fail(WRITERS_LIVE)
  const keepAlive = setInterval(() => {}, 60_000)
  const stop = async () => {
    clearInterval(keepAlive)
    await releaseLock(abs, fh)
    process.exit(0)
  }
  process.on('SIGHUP', () => {})
  process.on('SIGTERM', () => {
    stop().catch(() => process.exit(0))
  })
  process.on('SIGINT', () => {
    stop().catch(() => process.exit(0))
  })
  await new Promise(() => {})
}

export async function resetCritics() {
  const inbox = inboxDir()
  await mkdir(inbox, { recursive: true })
  const lockFile = inboxLockPath()
  if (lockIsLive(lockFile)) fail(WRITERS_LIVE)
  if (existsSync(lockFile)) await unlink(lockFile).catch(() => {})

  const child = spawn(process.execPath, [JUDGE_SELF, 'hold-lock', lockFile], {
    detached: true,
    stdio: 'ignore',
    cwd: cwdRoot(),
  })
  child.unref()
  const pid = child.pid
  if (!pid) fail('clickthrough fail-closed: inbox lock holder did not start')
  const ready = await waitUntil(() => lockIsLive(lockFile) && readLockPid(lockFile) === pid, 5000)
  if (!ready) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* holder never started */
    }
    fail('clickthrough fail-closed: inbox lock holder did not take the lock')
  }

  const critics = criticsDir()
  try {
    if (existsSync(critics)) {
      await rename(critics, `${critics}.bak.${Date.now()}`)
    }
    await mkdir(critics, { recursive: true })
  } catch (error) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    fail(error instanceof Error ? error.message : String(error))
  }
  console.log(JSON.stringify({ ok: true, critics, lock: lockFile, pid }))
}

export async function criticFileGaps() {
  const missing = []
  for (const persona of PERSONAS) {
    const file = path.join(criticsDir(), `${persona.id}.json`)
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      missing.push(error?.code === 'ENOENT' ? `${persona.id}: missing ${file}` : `${persona.id}: unreadable ${file}`)
      continue
    }
    if (!parseJsonObject(text)) missing.push(`${persona.id}: unparseable`)
  }
  return missing
}

export async function unlockInbox() {
  const gaps = await criticFileGaps()
  if (gaps.length) {
    fail(`clickthrough fail-closed: critic files incomplete\n${gaps.join('\n')}`)
  }
  const lockFile = inboxLockPath()
  const pid = readLockPid(lockFile)
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') fail(error instanceof Error ? error.message : String(error))
    }
    await waitUntil(() => !pidAlive(pid), 5000)
  }
  if (existsSync(lockFile) && !lockIsLive(lockFile)) {
    await unlink(lockFile).catch(() => {})
  }
  if (lockIsLive(lockFile)) fail(WRITERS_LIVE)
  console.log(JSON.stringify({ ok: true, lock: lockFile }))
}

export async function unlockOutbox() {
  const lockFile = outboxLockPath()
  if (lockIsLive(lockFile)) fail(OUTBOX_LOCK_HELD)
  await unlink(lockFile).catch(() => {})
  console.log(JSON.stringify({ ok: true, lock: lockFile }))
}

export async function stageFile(file, contents) {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`)
  let fh
  try {
    fh = await open(tmp, 'w')
    await fh.writeFile(contents)
    await fh.sync()
    return tmp
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  } finally {
    await fh?.close().catch(() => {})
  }
}

export async function atomicWrite(file, contents, { renameFile = rename } = {}) {
  const tmp = await stageFile(file, contents)
  let renamed = false
  try {
    await renameFile(tmp, file)
    renamed = true
  } finally {
    if (!renamed) await unlink(tmp).catch(() => {})
  }
}

async function snapshotFile(file) {
  try {
    return await readFile(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function restoreFile(file, bytes) {
  if (bytes == null) {
    await unlink(file).catch(() => {})
    return
  }
  await atomicWrite(file, bytes)
}

function isSuccessReceipt(latest) {
  return (
    latest &&
    typeof latest === 'object' &&
    latest.ok !== false &&
    !latest.unreadable &&
    typeof latest.plan_hash === 'string' &&
    latest.plan_hash
  )
}

export function receiptUnchanged(prev, latest, planHash, intendedRound) {
  if (latest?.unreadable) return { ok: false, reason: 'unreadable' }
  if (latest?.ok === false) return { ok: false, reason: 'ok:false' }

  const missing = latest == null
  if (prev == null) {
    if (missing) return { ok: true }
    if (isSuccessReceipt(latest) && latest.plan_hash === planHash) {
      const latestRound = Number(latest.round)
      if (Number.isInteger(latestRound) && latestRound >= intendedRound) {
        return { ok: false, reason: 'lost increment' }
      }
    }
    return { ok: false, reason: 'lost increment' }
  }

  if (missing) return { ok: false, reason: 'missing' }
  if (!isSuccessReceipt(latest)) return { ok: false, reason: 'unreadable' }

  const prevRound = Number(prev.round)
  const latestRound = Number(latest.round)
  if (latest.plan_hash === planHash && Number.isInteger(latestRound) && latestRound >= intendedRound) {
    return { ok: false, reason: 'lost increment' }
  }
  if (latest.plan_hash !== prev.plan_hash || latestRound !== prevRound) {
    return { ok: false, reason: 'lost increment' }
  }
  return { ok: true }
}

export async function peekReceiptAt(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return { unreadable: true }
  }
  try {
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { unreadable: true }
    return obj
  } catch {
    return { unreadable: true }
  }
}

function assertCas(prev, latest, planHash, intendedRound) {
  const check = receiptUnchanged(prev, latest, planHash, intendedRound)
  if (!check.ok) throw new CasAbortError(check.reason)
}

function poisonBody(error) {
  return `${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    recovery: POISON_RECOVERY,
  })}\n`
}

export async function publishOutbox({
  outbox,
  superplanText,
  verdictObj,
  receiptObj,
  prev,
  planHash,
  round,
  failAfter,
  beforeReceiptCas,
  contractText,
}) {
  const superplanPath = path.join(outbox, 'superplan.md')
  const verdictPath = path.join(outbox, 'verdict.json')
  const receiptPath = path.join(outbox, 'receipt.json')
  const contractPath = path.join(outbox, 'ui-contract.md')
  const superplanBody = superplanText.endsWith('\n') ? superplanText : `${superplanText}\n`
  const verdictBody = `${JSON.stringify(verdictObj, null, 2)}\n`
  const receiptBody = `${JSON.stringify(receiptObj, null, 2)}\n`
  const contractBody =
    contractText == null ? null : contractText.endsWith('\n') ? contractText : `${contractText}\n`

  const fh = await acquireLock(outboxLockPath())
  if (!fh) throw new Error(OUTBOX_LOCK_HELD)

  const snap = {
    superplan: await snapshotFile(superplanPath),
    verdict: await snapshotFile(verdictPath),
    contract: await snapshotFile(contractPath),
  }

  let superplanTmp
  let verdictTmp
  let receiptTmp
  let contractTmp
  let destTouched = false
  try {
    superplanTmp = await stageFile(superplanPath, superplanBody)
    verdictTmp = await stageFile(verdictPath, verdictBody)
    receiptTmp = await stageFile(receiptPath, receiptBody)
    if (contractBody != null) contractTmp = await stageFile(contractPath, contractBody)
    assertCas(prev, await peekReceiptAt(receiptPath), planHash, round)
    if (failAfter === 'before-rename') throw new CasAbortError('injected')
    await rename(superplanTmp, superplanPath)
    destTouched = true
    superplanTmp = undefined
    if (failAfter === 'verdict') {
      throw new Error('injected failAfter: verdict')
    }
    await rename(verdictTmp, verdictPath)
    verdictTmp = undefined
    if (contractTmp) {
      await rename(contractTmp, contractPath)
      contractTmp = undefined
    }
    if (failAfter === 'receipt' && typeof beforeReceiptCas === 'function') {
      await beforeReceiptCas(receiptPath)
    }
    assertCas(prev, await peekReceiptAt(receiptPath), planHash, round)
    await rename(receiptTmp, receiptPath)
    receiptTmp = undefined
  } catch (error) {
    await unlink(superplanTmp).catch(() => {})
    await unlink(verdictTmp).catch(() => {})
    await unlink(receiptTmp).catch(() => {})
    await unlink(contractTmp).catch(() => {})
    if (error instanceof CasAbortError) {
      if (destTouched) {
        await restoreFile(superplanPath, snap.superplan)
        await restoreFile(verdictPath, snap.verdict)
        await restoreFile(contractPath, snap.contract)
      }
    } else if (destTouched) {
      await restoreFile(superplanPath, snap.superplan)
      await restoreFile(verdictPath, snap.verdict)
      await restoreFile(contractPath, snap.contract)
      await atomicWrite(receiptPath, poisonBody(error))
    }
    throw error
  } finally {
    await releaseLock(outboxLockPath(), fh)
  }
}

export async function writeReviewIfChanged(artifact) {
  const dest = path.join(inboxDir(), 'review.md')
  let prev = null
  try {
    prev = await readFile(dest, 'utf8')
  } catch {
    prev = null
  }
  if (prev === artifact) return false
  await atomicWrite(dest, artifact)
  return true
}

async function readInboxContract() {
  try {
    return await readFile(path.join(inboxDir(), 'ui-contract.md'), 'utf8')
  } catch {
    return null
  }
}

async function ensureInboxWritersIdle() {
  const lockFile = inboxLockPath()
  if (lockIsLive(lockFile)) fail(WRITERS_LIVE)
  if (existsSync(lockFile)) await unlink(lockFile).catch(() => {})
}

async function runCompose(flags) {
  await ensureInboxWritersIdle()

  const inbox = inboxDir()
  const outbox = outboxDir()
  const critics = criticsDir()
  await mkdir(inbox, { recursive: true })
  await mkdir(outbox, { recursive: true })
  await mkdir(critics, { recursive: true })

  const artifact = await readArtifact(flags.file)
  const planHash = hash(artifact)
  const prev = await readReceipt()
  const round = nextRound(prev, planHash)
  if (round > MAX_ROUNDS) {
    fail(`clickthrough round cap (${MAX_ROUNDS}) already used`)
  }

  let reports
  if (flags.stub) {
    reports = await loadStubReports()
  } else {
    reports = await loadInboxReports({ planHash })
  }

  if (lockIsLive(inboxLockPath())) fail(WRITERS_LIVE)

  if (reportsAreEmpty(reports) && !flags.allowEmpty) {
    fail(EMPTY_CRITICS)
  }

  await writeReviewIfChanged(artifact)

  const judged = judgeReports(reports)
  const capped = round >= MAX_ROUNDS
  const verdict = capped ? 'ship' : judged.verdict
  const title = firstHeading(artifact) || 'review artifact'
  const superplan = buildSuperplan({
    verdict: judged.verdict,
    round,
    maxRounds: MAX_ROUNDS,
    scores: judged.scores,
    merged: judged.merged,
    artifactTitle: title,
  })

  const coverage = judged.scores.map((s) => ({
    persona: s.persona,
    total: s.total,
    critical: s.critical,
    high: s.high,
    count: s.findings.length,
  }))

  const receipt = {
    plan_hash: planHash,
    round,
    verdict,
    stub: flags.stub,
    cwd: cwdRoot(),
    coverage: Object.fromEntries(coverage.map((s) => [s.persona, s.total])),
    created_at: new Date().toISOString(),
  }

  try {
    await publishOutbox({
      outbox,
      superplanText: superplan,
      verdictObj: { verdict, round, maxRounds: MAX_ROUNDS, coverage, capped },
      receiptObj: receipt,
      prev,
      planHash,
      round,
      contractText: await readInboxContract(),
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  console.log(JSON.stringify({ verdict, round, outbox }, null, 2))
}

function fail(message) {
  throw new JudgeFailError(message)
}

async function readArtifact(filePath) {
  if (filePath && filePath !== '-') {
    return readFile(path.resolve(filePath), 'utf8')
  }
  const fallback = path.join(inboxDir(), 'review.md')
  try {
    return await readFile(fallback, 'utf8')
  } catch {
    fail(`no compose artifact: pass a file or write ${fallback}`)
  }
}

export function hash(text) {
  return createHash('sha256').update(text).digest('hex')
}

function firstHeading(text) {
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim()
}

async function readReceipt() {
  const file = path.join(outboxDir(), 'receipt.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    fail(`clickthrough fail-closed: unreadable receipt.json (${error.message})`)
  }
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    fail('clickthrough fail-closed: unreadable receipt.json')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    fail('clickthrough fail-closed: unreadable receipt.json')
  }
  if (obj.ok === false) {
    fail(
      `clickthrough fail-closed: previous compose failed (${obj.error || 'ok:false'}). Recovery: ${POISON_RECOVERY}`,
    )
  }
  if (typeof obj.plan_hash !== 'string' || !obj.plan_hash) {
    fail('clickthrough fail-closed: receipt.json plan_hash is missing')
  }
  const round = Number(obj.round)
  if (!Number.isInteger(round) || round < 1 || round > MAX_ROUNDS) {
    fail('clickthrough fail-closed: receipt.json round is not an integer in 1..MAX_ROUNDS')
  }
  return obj
}

function nextRound(prev, planHash) {
  if (!prev) return 1
  if (prev.plan_hash !== planHash) return 1
  const round = Number(prev.round)
  if (!Number.isInteger(round)) {
    fail('clickthrough fail-closed: receipt.json round is not an integer in 1..MAX_ROUNDS')
  }
  return round + 1
}

function reportFromFile(raw, personaId, source) {
  if (raw && typeof raw === 'object' && raw.persona && raw.persona !== personaId) {
    console.error(`clickthrough: ${source} persona field "${raw.persona}" ignored; using filename ${personaId}`)
  }
  const report = normalizeReport(raw, personaId)
  report.persona = personaId
  return report
}

async function loadStubReports() {
  const dir = path.join(SKILL_ROOT, 'fixtures', 'canned')
  const reports = []
  for (const persona of PERSONAS) {
    const text = await readFile(path.join(dir, `${persona.id}.json`), 'utf8')
    const raw = parseJsonObject(text)
    reports.push(reportFromFile(raw, persona.id, `${persona.id}.json`))
  }
  return reports
}

export async function readStableFile(file, { tries = 8, delayMs = 20 } = {}) {
  let last = null
  for (let i = 0; i < tries; i += 1) {
    const info = await stat(file)
    const text = await readFile(file, 'utf8')
    const sig = `${info.size}:${info.mtimeMs}`
    if (last && last.sig === sig && last.text === text) return text
    last = { sig, text }
    await sleep(delayMs)
  }
  return last?.text ?? readFile(file, 'utf8')
}

export async function loadInboxReports({ planHash }) {
  const reports = []
  const missing = []
  for (const persona of PERSONAS) {
    const file = path.join(criticsDir(), `${persona.id}.json`)
    let text
    try {
      text = await readStableFile(file)
    } catch (error) {
      missing.push(error?.code === 'ENOENT' ? `${persona.id}: missing ${file}` : `${persona.id}: unreadable ${file}`)
      continue
    }
    const raw = parseJsonObject(text)
    if (!raw) {
      missing.push(`${persona.id}: unparseable`)
      continue
    }
    if (raw.plan_hash != null && raw.plan_hash !== planHash) {
      missing.push(`${persona.id}: plan_hash mismatch`)
      continue
    }
    const report = reportFromFile(raw, persona.id, path.basename(file))
    if (!report.parsed) missing.push(`${persona.id}: unparseable`)
    reports.push(report)
  }
  if (missing.length) {
    fail(`clickthrough fail-closed: critic files incomplete\n${missing.join('\n')}`)
  }
  return reports
}

async function status() {
  const fh = await acquireLock(outboxLockPath())
  if (!fh) fail(OUTBOX_LOCK_HELD)
  try {
    const file = path.join(outboxDir(), 'receipt.json')
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      console.log(JSON.stringify({ ok: false, error: 'no receipt' }))
      throw new JudgeFailError('no receipt')
    }
    let obj
    try {
      obj = JSON.parse(text)
    } catch {
      fail('clickthrough fail-closed: unreadable receipt.json')
    }
    if (obj && obj.ok === false) {
      console.log(JSON.stringify(obj, null, 2))
      throw new JudgeFailError(obj.error || 'ok:false')
    }
    const receipt = await readReceipt()
    if (!receipt) {
      console.log(JSON.stringify({ ok: false, error: 'no receipt' }))
      throw new JudgeFailError('no receipt')
    }
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    await releaseLock(outboxLockPath(), fh)
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  main().catch((error) => {
    if (error instanceof JudgeFailError) {
      console.error(error.message)
      process.exit(error.exitCode ?? 1)
    }
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
