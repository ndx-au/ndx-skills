#!/usr/bin/env node
/** Atomic critic publish: stdin JSON → .clickthrough/inbox/critics/<id>.json via temp+rename. */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PERSONAS } from './personas.mjs'
import { atomicWrite, criticsDir, inboxLockPath, lockIsLive } from './judge.mjs'

const id = process.argv[2]
if (!PERSONAS.some((p) => p.id === id)) {
  console.error('usage: publish-critic <persona-id>  (JSON on stdin, or a file as argv 3)')
  process.exit(2)
}

if (!lockIsLive(inboxLockPath())) {
  console.error('publish-critic: inbox lock not held')
  process.exit(1)
}

let raw
if (process.argv[3] && process.argv[3] !== '-') {
  raw = await readFile(path.resolve(process.argv[3]), 'utf8')
} else {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  raw = Buffer.concat(chunks).toString('utf8')
}

const trimmed = raw.trim()
if (!trimmed) {
  console.error('publish-critic: empty input')
  process.exit(1)
}
JSON.parse(trimmed)

const dest = path.join(criticsDir(), `${id}.json`)
const body = trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
await atomicWrite(dest, body)
console.log(JSON.stringify({ ok: true, file: dest }))
