/** Critic lenses and deterministic compose judge. No network. */

export const PERSONAS = [
  {
    id: 'security',
    title: 'Security',
    lens: 'authz, injection, secrets, trust boundaries, sandbox escapes, confused deputies',
  },
  {
    id: 'correctness',
    title: 'Correctness',
    lens: 'silent wrongness, spec gaps, off-by-ones, inverted conditions, lost updates, wrong defaults',
  },
  {
    id: 'failure',
    title: 'Failure',
    lens: 'partial writes, crash/recovery, missing rollback, timeout holes, poison state, cleanup that never runs',
  },
  {
    id: 'concurrency',
    title: 'Concurrency',
    lens: 'races, ordering, shared mutable state, TOCTOU, lock inversion, stale caches across tasks',
  },
  {
    id: 'tests',
    title: 'Tests',
    lens: 'untested paths, assertions that cannot fail, missing adversarial cases, tests that test the mock',
  },
]

export const FINDING_SCHEMA = `{
  "persona": "security|correctness|failure|concurrency|tests",
  "findings": [
    {
      "id": "short-id",
      "severity": "critical|high|medium|low",
      "location": "path:symbol or plan section",
      "bug": "where execution fell short or what leftover hazard remains",
      "predicted": "what still goes wrong after this execution",
      "fix_hint": "one actionable leftover task"
    }
  ]
}`

export const SEVERITY_SCORE = {
  critical: 8,
  high: 5,
  medium: 2,
  low: 1,
}

const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low'])
const PERSONA_IDS = new Set(PERSONAS.map((p) => p.id))

export function normalizeReport(raw, fallbackPersona) {
  const obj = typeof raw === 'string' ? parseJsonObject(raw) : raw
  if (!obj || typeof obj !== 'object') {
    return { persona: fallbackPersona ?? 'unknown', findings: [], parsed: false }
  }
  const persona = PERSONA_IDS.has(obj.persona) ? obj.persona : (fallbackPersona ?? 'unknown')
  const findings = Array.isArray(obj.findings) ? obj.findings : []
  return {
    persona,
    parsed: true,
    findings: findings.map((f, i) => normalizeFinding(f, persona, i)).filter(Boolean),
  }
}

function normalizeSeverity(raw) {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (SEVERITIES.has(key)) return key
  return 'high'
}

function normalizeFinding(f, persona, i) {
  if (!f || typeof f !== 'object') return null
  const severity = normalizeSeverity(f.severity)
  const location = String(f.location ?? '').trim()
  const bug = String(f.bug ?? '').trim()
  if (!bug) return null
  return {
    id: String(f.id ?? `${persona}-${i + 1}`),
    severity,
    location,
    bug,
    predicted: String(f.predicted ?? '').trim(),
    fix_hint: String(f.fix_hint ?? '').trim(),
  }
}

export function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  let candidate = trimmed
  if (trimmed.startsWith('```')) {
    const rest = trimmed.replace(/^```(?:json)?[ \t]*\r?\n?/i, '')
    const end = rest.lastIndexOf('```')
    candidate = (end >= 0 ? rest.slice(0, end) : rest).trim()
  }
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

export function scoreFinding(finding) {
  let score = SEVERITY_SCORE[finding.severity] ?? 1
  const loc = finding.location
  if (!loc) score -= 2
  else {
    if (/[./\\]/.test(loc) || loc.includes(':')) score += 1
    if (/[A-Za-z_][A-Za-z0-9_]*/.test(loc)) score += 1
  }
  if (finding.bug.length < 20) score -= 2
  if (!finding.predicted) score -= 1
  if (!finding.fix_hint) score -= 1
  if (/^(maybe|might|unclear|various|general|improve)/i.test(finding.bug)) score -= 2
  return score
}

export function noveltyKey(finding) {
  return `${finding.location}|${finding.bug}`
    .toLowerCase()
    .replace(/[^a-z0-9|:/._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function reportsAreEmpty(reports) {
  return reports.length === 0 || reports.every((r) => (r.findings ?? []).length === 0)
}

function pickBetterText(a, b) {
  const left = String(a ?? '').trim()
  const right = String(b ?? '').trim()
  return right.length > left.length ? right : left
}

function mergeFinding(existing, incoming, persona) {
  const incomingRank = SEVERITY_RANK[incoming.severity] ?? 0
  const existingRank = SEVERITY_RANK[existing.severity] ?? 0
  if (incomingRank > existingRank) {
    existing.severity = incoming.severity
    existing.bug = incoming.bug
    existing.predicted = incoming.predicted || existing.predicted
    existing.location = incoming.location || existing.location
    if (incoming.fix_hint) existing.fix_hint = incoming.fix_hint
  } else if (incomingRank === existingRank) {
    existing.predicted = pickBetterText(existing.predicted, incoming.predicted)
    existing.fix_hint = pickBetterText(existing.fix_hint, incoming.fix_hint)
  }
  existing.score = Math.max(existing.score ?? 0, incoming.score ?? 0)
  if (!existing.lenses.includes(persona)) existing.lenses.push(persona)
}

export function sanitizeField(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/#{1,}/g, ' ')
    .replace(/`+/g, ' ')
    .replace(/\bVerdict\s*:/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fenceField(text) {
  const body = sanitizeField(text) || 'unspecified'
  return ['```', body === '```' ? 'unspecified' : body, '```']
}

export function judgeReports(reports) {
  const mergedByKey = new Map()
  const scored = reports.map((report) => {
    let total = 0
    let critical = 0
    let high = 0
    const findings = []
    for (const finding of report.findings) {
      const score = scoreFinding(finding)
      total += score
      if (finding.severity === 'critical') critical += 1
      if (finding.severity === 'high') high += 1
      const keyed = { ...finding, score, lenses: [report.persona] }
      findings.push(keyed)
      const key = noveltyKey(finding)
      const existing = mergedByKey.get(key)
      if (!existing) mergedByKey.set(key, { ...keyed, lenses: [report.persona] })
      else mergeFinding(existing, keyed, report.persona)
    }
    return { persona: report.persona, total, critical, high, findings }
  })

  scored.sort((a, b) => b.total - a.total || b.critical - a.critical || b.high - a.high || a.persona.localeCompare(b.persona))
  const merged = [...mergedByKey.values()].sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      a.id.localeCompare(b.id),
  )
  const hasBlocker = merged.some((f) => f.severity === 'critical' || f.severity === 'high')
  return { scores: scored, merged, verdict: hasBlocker ? 'revise' : 'ship' }
}

export function personaPrompt(persona, phase, artifact) {
  return `You are the ${persona.title} lens in a complementary review. Other lenses cover different domains; the judge will merge overlapping findings. Stay in your lens. Specific locations and leftover hazards beat verbosity.

Lens: ${persona.lens}

Phase: ${phase} — compare the original plan to what was executed. Report where execution succeeded and where it fell short.

Review the artifact below. Output ONLY a JSON object matching this schema (no markdown, no preamble):
${FINDING_SCHEMA}

Rules:
- persona must be "${persona.id}"
- Every finding must name a location (file, symbol, or plan section heading)
- predicted = what still goes wrong after this execution
- fix_hint = one leftover task the implementer can execute
- If another lens would file the same bug, you may still file it; the judge merges by location+bug
- If this lens truly sees nothing, return {"persona":"${persona.id}","findings":[]} — the judge fails the whole review if every critic is empty

--- ARTIFACT ---
${artifact}
--- END ARTIFACT ---
`
}

function lensTag(finding) {
  const lenses = finding.lenses?.length ? finding.lenses : [finding.persona].filter(Boolean)
  return lenses.join(', ')
}

export function buildSuperplan({ verdict, round, maxRounds, scores, merged, artifactTitle }) {
  const findings = merged ?? []
  const blockers = findings.filter((f) => f.severity === 'critical' || f.severity === 'high')
  const rest = findings.filter((f) => f.severity !== 'critical' && f.severity !== 'high')
  const forcedShip = round >= maxRounds && verdict === 'revise'
  const title = sanitizeField(artifactTitle) || 'review artifact'
  const heading = forcedShip
    ? `# Residual-risk ship (${title})`
    : verdict === 'ship'
      ? `# Composite review: ${title}`
      : `# Composite leftover plan: ${title}`

  const lines = [
    heading,
    '',
    `Round ${round}/${maxRounds}. Verdict: **${forcedShip ? 'ship (round cap)' : verdict}**.`,
    '',
    '## Coverage',
    '',
    ...scores.map((s) => `- ${s.persona}: ${s.total} (${s.critical} critical, ${s.high} high, ${s.findings.length} findings)`),
    '',
    '## Must fix',
    '',
  ]

  const must = forcedShip ? [] : blockers
  if (must.length === 0) {
    lines.push(
      forcedShip
        ? 'Round cap reached. Record residual risks below; do not open another leftover loop.'
        : 'No critical/high findings. Proceed, but keep residual risks in view.',
    )
  } else {
    for (const f of must) {
      lines.push(`### ${sanitizeField(f.id)} (${lensTag(f)}, ${f.severity})`)
      lines.push('')
      lines.push('- Location:')
      lines.push(...fenceField(f.location || 'unspecified'))
      lines.push('- Bug:')
      lines.push(...fenceField(f.bug))
      lines.push('- Predicted:')
      lines.push(...fenceField(f.predicted || 'unspecified'))
      lines.push('- Task:')
      lines.push(...fenceField(f.fix_hint || f.bug))
      lines.push('')
    }
  }

  lines.push('## Residual risks')
  lines.push('')
  const residuals = forcedShip ? findings : rest
  if (residuals.length === 0) {
    lines.push('None recorded.')
  } else {
    for (const f of residuals) {
      lines.push(`- **${f.severity}** (${lensTag(f)})`)
      lines.push(`- Id:`)
      lines.push(...fenceField(f.id))
      lines.push('- Bug:')
      lines.push(...fenceField(f.bug))
      if (f.fix_hint) {
        lines.push('- Task:')
        lines.push(...fenceField(f.fix_hint))
      }
      lines.push('')
    }
  }

  if (blockers.length && !forcedShip) {
    lines.push('', '## Sequence', '')
    blockers.forEach((f, i) => {
      lines.push(`${i + 1}. [${lensTag(f)}]`)
      lines.push(...fenceField(f.fix_hint || f.bug))
    })
  }

  lines.push('', '## Guardrails', '')
  lines.push('- Do not drop a finding without saying why it is invalid.')
  lines.push('- After the next impl round, run `node scripts/judge.mjs compose` on an updated review (plan + new diff).')
  if (round < maxRounds && verdict === 'revise' && !forcedShip) {
    lines.push(`- This is round ${round}. If compose still says revise, another after-pass is allowed (max ${maxRounds} rounds).`)
  } else {
    lines.push('- No further gauntlet leftover loop after this round.')
  }
  lines.push('')
  return lines.join('\n')
}
