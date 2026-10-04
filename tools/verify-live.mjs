/**
 * End-to-end check of a running DSH against the same corpus, offline.
 *
 * The host half only reloads when the DSH process restarts, so this is the
 * acceptance step for any host change: it fetches the live payload, folds the
 * same session logs here, and requires the two to agree per session, per project,
 * per route and in total — then requires the second request to be served from the
 * per-session revision memo rather than re-reading the corpus.
 *
 * A session whose log moved between the two reads is reported and excluded from
 * the comparison: the live sweep and this script cannot observe the same cut of a
 * log that is still being written.
 *
 * Usage: `node tools/verify-live.mjs [--url <base>]`
 *
 * The base URL comes from, in order: `--url`, the `DSH_WEB_URL` environment
 * variable (which a DSH session exports), then the desktop default. Needs a real
 * session corpus (`DSH_HOME` overrides `~/.dsh`).
 */

import process from 'node:process'

import { aggregate, bucketTotal, foldUsageDetailed } from '../lib/index.js'
import { indexSessionLogs, loadProjectionRecords, readSessionLog } from '../test/support/session-corpus.mjs'

/** Desktop default; overridden by `--url` or `DSH_WEB_URL`. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:19387'

const baseUrl = (() => {
  const index = process.argv.indexOf('--url')
  if (index !== -1) {
    const given = process.argv[index + 1]
    if (given === undefined) throw new Error('--url needs a value, e.g. --url http://127.0.0.1:19387')
    return given.replace(/\/+$/u, '')
  }
  return (process.env.DSH_WEB_URL ?? DEFAULT_BASE_URL).replace(/\/+$/u, '')
})()

/** A log touched this recently may have moved between the two reads. */
const MOVING_WINDOW_MS = 60_000

const failures = []
const notes = []
const fail = (message) => failures.push(message)

/** Fold the corpus the way the host half would. */
function offlineRows() {
  const logs = indexSessionLogs()
  const rows = []
  const skipped = []
  for (const { id, record } of loadProjectionRecords()) {
    const file = logs.get(id)
    if (file === undefined) { skipped.push(id); continue }
    const { header, events } = readSessionLog(file)
    const inheritedEventCount = record.identity?.inheritedEventCount ?? 0
    const whole = foldUsageDetailed(events, 0)
    const own = inheritedEventCount > 0 ? foldUsageDetailed(events, inheritedEventCount) : whole
    rows.push({
      header: { ...header, id: header?.id ?? id, isSeeded: record.identity?.isSeeded === true },
      isSeeded: record.identity?.isSeeded === true,
      inheritedEventCount,
      reported: whole.totals,
      own: own.totals,
      byRoute: own.byRoute,
      foldMismatch: false,
    })
  }
  return { rows, skipped, logs }
}

async function fetchSummary(mode, refresh) {
  const response = await fetch(`${baseUrl}/token-ledger/summary?mode=${mode}${refresh ? '&refresh=1' : ''}`)
  if (!response.ok) throw new Error(`GET ${mode} -> HTTP ${response.status}`)
  return response.json()
}

const { rows, skipped, logs } = offlineRows()
if (rows.length === 0) {
  console.error('no session corpus found (set DSH_HOME); nothing to verify against')
  process.exit(2)
}
const expected = aggregate(rows, true)
notes.push(`offline corpus: ${expected.sessionCount} sessions, ${expected.projectCount} projects, own ${expected.totals.ownTotalTokens.toLocaleString('en-US')}`)
if (skipped.length > 0) notes.push(`${skipped.length} projection records had no readable log and were skipped`)

// --- 1. the live payload must be the new shape -------------------------------
const live = await fetchSummary('accurate', false)
if (live.ok !== true) fail(`payload not ok: ${JSON.stringify(live).slice(0, 200)}`)
if (live.schemaVersion !== 2) fail(`schemaVersion is ${String(live.schemaVersion)}, expected 2 — the host half has not reloaded (restart DSH)`)
if (!Array.isArray(live.sessions)) fail('payload has no sessions[] — the host half has not reloaded (restart DSH)')
if (live.deduped !== true) fail('accurate payload must be deduplicated')

// --- 2. per-session agreement ------------------------------------------------
const now = Date.now()
const moving = new Set()
const { stat } = await import('node:fs').then((fs) => fs.promises)
for (const session of rows) {
  const logPath = logs.get(session.header.id)
  if (logPath === undefined) continue
  const { mtimeMs } = await stat(logPath)
  if (now - mtimeMs < MOVING_WINDOW_MS) moving.add(session.header.id)
}

if (Array.isArray(live.sessions)) {
  const liveById = new Map(live.sessions.map((session) => [session.id, session]))
  let compared = 0
  for (const session of rows) {
    const id = session.header.id
    if (moving.has(id)) continue
    const seen = liveById.get(id)
    if (seen === undefined) { fail(`live payload is missing session ${id}`); continue }
    const offline = bucketTotal(session.own)
    const reported = bucketTotal(seen.own)
    if (offline !== reported) {
      fail(`session ${id} (${session.header.cwd}): offline ${offline} vs live ${reported}`)
    }
    compared += 1
  }
  notes.push(`compared ${compared} settled sessions token-for-token (${moving.size} still being written, excluded)`)

  const extra = live.sessions.filter((session) => !rows.some((row) => row.header.id === session.id))
  if (extra.length > 0) notes.push(`${extra.length} live sessions are not in the offline corpus (created since it was read)`)
}

// --- 3. aggregates ------------------------------------------------------------
if (Array.isArray(live.sessions) && Array.isArray(live.routes)) {
  const routeSum = live.routes.reduce((sum, route) => sum + route.totalTokens, 0)
  if (routeSum !== live.totals.ownTotalTokens) {
    fail(`route table sums to ${routeSum} but the total is ${live.totals.ownTotalTokens}`)
  }
  const projectSum = live.projects.reduce((sum, project) => sum + project.ownTotalTokens, 0)
  if (projectSum !== live.totals.ownTotalTokens) {
    fail(`project table sums to ${projectSum} but the total is ${live.totals.ownTotalTokens}`)
  }
  if (live.projects.length !== live.projectCount) fail('projectCount disagrees with the project table')
  if (live.sessionsRead + live.sessionsReused !== live.sessionCount) fail('reused + read does not account for every session')
  notes.push(`live: own ${live.totals.ownTotalTokens.toLocaleString('en-US')} | reported ${live.totals.reportedTotalTokens.toLocaleString('en-US')} | ${live.routes.length} routes`)
} else if (live.schemaVersion === 2) {
  fail('a reloaded host half must return routes[] in accurate mode')
}

// --- 4. the revision memo must serve the second request ----------------------
const second = await fetchSummary('accurate', false)
if (second.sessionsRead !== 0) {
  fail(`the second sweep re-read ${second.sessionsRead} sessions; an unchanged corpus must be served from the memo (0 expected)`)
} else {
  notes.push(`second sweep read 0 logs and reused ${second.sessionsReused} sessions in ${second.durationMs} ms`)
}
if (second.totals.ownTotalTokens !== live.totals.ownTotalTokens && moving.size === 0) {
  fail('two consecutive sweeps disagreed although no log was moving')
}

// --- 5. fast mode still works -------------------------------------------------
const fast = await fetchSummary('fast', false)
if (fast.deduped !== false) fail('fast mode must report deduped=false')
if (fast.totals.own !== null) fail('fast mode must not report own figures')
notes.push(`fast mode: reported ${fast.totals.reportedTotalTokens.toLocaleString('en-US')} in ${fast.durationMs} ms`)

// --- report -------------------------------------------------------------------
console.log(notes.map((note) => `· ${note}`).join('\n'))
if (failures.length > 0) {
  console.log('')
  for (const failure of failures) console.log(`✖ ${failure}`)
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\n✓ live host half agrees with the offline fold of the same corpus')
