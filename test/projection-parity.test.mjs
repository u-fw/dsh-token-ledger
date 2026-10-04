/**
 * Parity tests against the projections DSH itself persisted.
 *
 * The strongest available check on this package's fold: for every session on
 * this machine, fold the log up to the watermark of DSH's own `tokenUsage` row
 * and require the result to equal that row. The watermark cut is what makes the
 * comparison deterministic — folding the whole log would also count events the
 * projection had not yet observed, which is normal for a session being written.
 *
 * These tests need a real session corpus; without one they skip.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { bucketTotal, foldUsageDetailed } from '../lib/index.js'
import { corpusAvailable, indexSessionLogs, loadProjectionRecords, readSessionLog } from './support/session-corpus.mjs'

const available = corpusAvailable()
const skip = available ? false : 'no DSH session corpus on this machine (set DSH_HOME to point at one)'

/** Every session that has both a readable log and a persisted usage row. */
function comparableSessions() {
  const logs = indexSessionLogs()
  const out = []
  for (const { id, record } of loadProjectionRecords()) {
    const file = logs.get(id)
    if (file === undefined) continue
    const row = record.rows?.tokenUsage
    const totals = row?.val?.totals
    if (totals === undefined || typeof row.seq !== 'number') continue
    out.push({
      id,
      file,
      cut: row.seq,
      expected: {
        uncachedInputTokens: totals.uncachedInputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
      },
      inheritedEventCount: record.identity?.inheritedEventCount ?? 0,
      isSeeded: record.identity?.isSeeded === true,
    })
  }
  return out
}

test('the fold reproduces every persisted tokenUsage projection at its watermark', { skip }, () => {
  const sessions = comparableSessions()
  assert.ok(sessions.length > 0, 'expected at least one comparable session')

  const mismatches = []
  for (const session of sessions) {
    const { events } = readSessionLog(session.file)
    const upto = events.filter((event) => typeof event.seq === 'number' && event.seq <= session.cut)
    const actual = foldUsageDetailed(upto, 0).totals
    if (bucketTotal(actual) !== bucketTotal(session.expected)) {
      mismatches.push(`${session.id}: folded ${bucketTotal(actual)} vs persisted ${bucketTotal(session.expected)} (cut seq ${session.cut})`)
    }
  }

  assert.deepEqual(mismatches, [], `${mismatches.length}/${sessions.length} sessions disagree with DSH's own projection`)
})

test('route attribution sums to the session total for every session', { skip }, () => {
  const logs = indexSessionLogs()
  const failures = []
  for (const { id } of loadProjectionRecords()) {
    const file = logs.get(id)
    if (file === undefined) continue
    const { events } = readSessionLog(file)
    const { totals, byRoute } = foldUsageDetailed(events, 0)
    const summed = byRoute.reduce((sum, entry) => sum + entry.totalTokens, 0)
    if (summed !== bucketTotal(totals)) failures.push(`${id}: byRoute ${summed} vs totals ${bucketTotal(totals)}`)
  }
  assert.deepEqual(failures, [])
})

test('a seeded session never counts more of its own than it reports overall', { skip }, () => {
  const logs = indexSessionLogs()
  const failures = []
  for (const session of comparableSessions()) {
    if (!session.isSeeded || session.inheritedEventCount === 0) continue
    const { events } = readSessionLog(logs.get(session.id))
    const own = bucketTotal(foldUsageDetailed(events, session.inheritedEventCount).totals)
    if (own > bucketTotal(session.expected)) {
      failures.push(`${session.id}: own ${own} exceeds reported ${bucketTotal(session.expected)}`)
    }
  }
  assert.deepEqual(failures, [])
})

test('own + inherited prefix equals the whole log for seeded sessions', { skip }, () => {
  const logs = indexSessionLogs()
  const failures = []
  for (const session of comparableSessions()) {
    if (session.inheritedEventCount === 0) continue
    const { events } = readSessionLog(logs.get(session.id))
    const whole = bucketTotal(foldUsageDetailed(events, 0).totals)
    const own = bucketTotal(foldUsageDetailed(events, session.inheritedEventCount).totals)
    const prefix = bucketTotal(foldUsageDetailed(events, 0).totals) - own
    if (own + prefix !== whole) failures.push(`${session.id}: ${own} + ${prefix} != ${whole}`)
  }
  assert.deepEqual(failures, [])
})
