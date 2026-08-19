#!/usr/bin/env node
import { createHash } from 'node:crypto'
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
let MAX_ROUNDS = 3

export class CasAbortError extends Error {
  constructor(reason = 'lost increment') {
    super(`gauntlet fail-closed: receipt changed during compose (${reason})`)
    this.name = 'CasAbortError'
    this.reason = reason
  }
}

function cwdRoot() {
  return process.cwd()
}

function inboxDir() {
  return path.join(cwdRoot(), '.gauntlet', 'inbox')
}

function outboxDir() {
  return path.join(cwdRoot(), '.gauntlet', 'outbox')
}

function criticsDir() {
  return path.join(inboxDir(), 'critics')
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
    default:
      console.error('usage: judge <compose|status> [file] [--stub] [--allow-empty] [--max-rounds 1..3]')
      process.exit(2)
  }
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
}) {
  const superplanPath = path.join(outbox, 'superplan.md')
  const verdictPath = path.join(outbox, 'verdict.json')
  const receiptPath = path.join(outbox, 'receipt.json')
  const superplanBody = superplanText.endsWith('\n') ? superplanText : `${superplanText}\n`
  const verdictBody = `${JSON.stringify(verdictObj, null, 2)}\n`
  const receiptBody = `${JSON.stringify(receiptObj, null, 2)}\n`

  let superplanTmp
  let verdictTmp
  let receiptTmp
  let published = 0
  try {
    superplanTmp = await stageFile(superplanPath, superplanBody)
    verdictTmp = await stageFile(verdictPath, verdictBody)
    receiptTmp = await stageFile(receiptPath, receiptBody)
    assertCas(prev, await peekReceiptAt(receiptPath), planHash, round)
    await rename(superplanTmp, superplanPath)
    published += 1
    if (failAfter === 'verdict') {
      throw new Error('injected failAfter: verdict')
    }
    await rename(verdictTmp, verdictPath)
    published += 1
    if (failAfter === 'receipt' && typeof beforeReceiptCas === 'function') {
      await beforeReceiptCas(receiptPath)
    }
    assertCas(prev, await peekReceiptAt(receiptPath), planHash, round)
    await rename(receiptTmp, receiptPath)
  } catch (error) {
    await unlink(superplanTmp).catch(() => {})
    await unlink(verdictTmp).catch(() => {})
    await unlink(receiptTmp).catch(() => {})
    if (published > 0 && !(error instanceof CasAbortError)) {
      const latest = await peekReceiptAt(receiptPath)
      const check = receiptUnchanged(prev, latest, planHash, round)
      if (check.ok) {
        await atomicWrite(
          receiptPath,
          `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
        )
      }
    }
    throw error
  }
}

async function runCompose(flags) {
  const inbox = inboxDir()
  const outbox = outboxDir()
  const critics = criticsDir()
  await mkdir(inbox, { recursive: true })
  await mkdir(outbox, { recursive: true })
  await mkdir(critics, { recursive: true })

  const sourcePath = flags.file && flags.file !== '-' ? path.resolve(flags.file) : null
  const artifact = await readArtifact(flags.file)
  const planHash = hash(artifact)
  const prev = await readReceipt()
  const round = nextRound(prev, planHash)
  if (round > MAX_ROUNDS) {
    fail(`gauntlet round cap (${MAX_ROUNDS}) already used`)
  }

  let reports
  if (flags.stub) {
    reports = await loadStubReports()
  } else {
    reports = await loadInboxReports({ planHash, sourcePath: sourcePath ?? path.join(inbox, 'review.md') })
  }

  if (reportsAreEmpty(reports) && !flags.allowEmpty) {
    fail(
      'gauntlet fail-closed: every critic was empty or missing. That is an infrastructure miss, not a clean review. Re-run critics or pass --allow-empty only if you truly accept a no-finding review.',
    )
  }

  await atomicWrite(path.join(inbox, 'review.md'), artifact)

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
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  console.log(JSON.stringify({ verdict, round, outbox }, null, 2))
}

function fail(message) {
  console.error(message)
  process.exit(1)
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

function hash(text) {
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
    fail(`gauntlet fail-closed: unreadable receipt.json (${error.message})`)
  }
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    fail('gauntlet fail-closed: unreadable receipt.json')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    fail('gauntlet fail-closed: unreadable receipt.json')
  }
  if (obj.ok === false) {
    fail(`gauntlet fail-closed: previous compose failed (${obj.error || 'ok:false'})`)
  }
  if (typeof obj.plan_hash !== 'string' || !obj.plan_hash) {
    fail('gauntlet fail-closed: receipt.json plan_hash is missing')
  }
  const round = Number(obj.round)
  if (!Number.isInteger(round) || round < 1 || round > MAX_ROUNDS) {
    fail('gauntlet fail-closed: receipt.json round is not an integer in 1..MAX_ROUNDS')
  }
  return obj
}

function nextRound(prev, planHash) {
  if (!prev) return 1
  if (prev.plan_hash !== planHash) return 1
  const round = Number(prev.round)
  if (!Number.isInteger(round)) {
    fail('gauntlet fail-closed: receipt.json round is not an integer in 1..MAX_ROUNDS')
  }
  return round + 1
}

function reportFromFile(raw, personaId, source) {
  if (raw && typeof raw === 'object' && raw.persona && raw.persona !== personaId) {
    console.error(`gauntlet: ${source} persona field "${raw.persona}" ignored; using filename ${personaId}`)
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

async function loadInboxReports({ planHash, sourcePath }) {
  const reports = []
  const missing = []
  let sourceMtime = 0
  if (sourcePath) {
    try {
      sourceMtime = (await stat(sourcePath)).mtimeMs
    } catch {
      sourceMtime = 0
    }
  }
  for (const persona of PERSONAS) {
    const file = path.join(criticsDir(), `${persona.id}.json`)
    let text
    let criticMtime = 0
    try {
      const info = await stat(file)
      criticMtime = info.mtimeMs
      text = await readFile(file, 'utf8')
    } catch (error) {
      missing.push(error?.code === 'ENOENT' ? `${persona.id}: missing ${file}` : `${persona.id}: unreadable ${file}`)
      continue
    }
    if (sourceMtime && criticMtime < sourceMtime) {
      missing.push(`${persona.id}: stale (older than review)`)
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
    fail(`gauntlet fail-closed: critic files incomplete\n${missing.join('\n')}`)
  }
  return reports
}

async function status() {
  const file = path.join(outboxDir(), 'receipt.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    console.log(JSON.stringify({ ok: false, error: 'no receipt' }))
    process.exit(1)
  }
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    fail('gauntlet fail-closed: unreadable receipt.json')
  }
  if (obj && obj.ok === false) {
    console.log(JSON.stringify(obj, null, 2))
    process.exit(1)
  }
  const receipt = await readReceipt()
  if (!receipt) {
    console.log(JSON.stringify({ ok: false, error: 'no receipt' }))
    process.exit(1)
  }
  console.log(JSON.stringify(receipt, null, 2))
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
}
