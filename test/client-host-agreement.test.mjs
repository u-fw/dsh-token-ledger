/**
 * The two halves must agree on the same corpus.
 *
 * The host aggregates per-session rows into projects, routes and totals; the
 * client re-derives all of that from those same rows so the time filter and the
 * drill-down share one code path. This test feeds the host's own aggregate into
 * the client's derivation over the real corpus and requires them to match, which
 * is also what the page's own consistency warning checks at runtime.
 *
 * Needs a real session corpus; without one it skips.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { aggregate, bucketTotal, foldUsageDetailed } from '../lib/index.js'
import { corpusAvailable, indexSessionLogs, loadProjectionRecords, readSessionLog } from './support/session-corpus.mjs'
import { loadClientHalf } from './support/client-half.mjs'

const available = corpusAvailable()
const skip = available ? false : 'no DSH session corpus on this machine (set DSH_HOME to point at one)'

const client = await loadClientHalf()

/** Rebuild the host's per-session rows the way a sweep would produce them. */
function hostRows() {
  const logs = indexSessionLogs()
  const rows = []
  for (const { id, record } of loadProjectionRecords()) {
    const file = logs.get(id)
    if (file === undefined) continue
    const { header, events } = readSessionLog(file)
    const inheritedEventCount = record.identity?.inheritedEventCount ?? 0
    const whole = foldUsageDetailed(events, 0)
    const own = inheritedEventCount > 0 ? foldUsageDetailed(events, inheritedEventCount) : whole
    rows.push({
      header: {
        ...header,
        id: header?.id ?? id,
        isSeeded: record.identity?.isSeeded === true,
      },
      isSeeded: record.identity?.isSeeded === true,
      inheritedEventCount,
      reported: whole.totals,
      own: own.totals,
      byRoute: own.byRoute,
      foldMismatch: false,
    })
  }
  return rows
}

const rows = available ? hostRows() : []

test('the client derives exactly the host aggregate it was given', { skip }, () => {
  assert.ok(rows.length > 0, 'expected a non-empty corpus')
  const payload = { ok: true, schemaVersion: 2, mode: 'accurate', deduped: true, generatedAt: Date.now(), problems: [], ...aggregate(rows, true) }
  const view = client.deriveView(payload, 'all', Date.now())

  assert.equal(view.degraded, false, 'a per-session payload must not take the fallback path')
  assert.equal(view.sessions.length, payload.sessionCount)
  assert.equal(view.totals.totalTokens, payload.totals.ownTotalTokens, 'headline figure must match the host')
  assert.equal(view.totals.reportedTotalTokens, payload.totals.reportedTotalTokens)
  assert.equal(view.totals.overlapTokens, payload.totals.overlapTokens)
  assert.equal(view.projects.length, payload.projectCount)

  for (const project of payload.projects) {
    const derived = view.projects.find((candidate) => (candidate.cwd ?? '') === (project.cwd ?? ''))
    assert.ok(derived !== undefined, `client lost project ${project.name}`)
    assert.equal(derived.totalTokens, project.ownTotalTokens, `project ${project.name} tokens`)
    assert.equal(derived.reportedTotalTokens, project.reportedTotalTokens, `project ${project.name} reported`)
    assert.equal(derived.sessions, project.sessions)
    assert.equal(derived.forks, project.forks)
    assert.equal(derived.subagents, project.subagentSessions)
  }

  const hostRouteSum = payload.routes.reduce((sum, route) => sum + route.totalTokens, 0)
  const clientRouteSum = view.routes.reduce((sum, route) => sum + route.totalTokens, 0)
  assert.equal(clientRouteSum, hostRouteSum, 'route tables must agree')
  assert.equal(clientRouteSum, payload.totals.ownTotalTokens)
})

test('a period filter can only remove sessions, never invent tokens', { skip }, () => {
  const payload = { ok: true, schemaVersion: 2, mode: 'accurate', deduped: true, generatedAt: Date.now(), problems: [], ...aggregate(rows, true) }
  const now = Date.now()
  const all = client.deriveView(payload, 'all', now)
  const recent = client.deriveView(payload, '30', now)

  assert.ok(recent.sessions.length <= all.sessions.length)
  assert.ok(recent.totals.totalTokens <= all.totals.totalTokens)
  assert.equal(recent.sessions.length, payload.sessions.filter((session) => session.createdAt >= now - 30 * 86_400_000).length)

  // Every project and route in the filtered view must still sum to its total.
  const projectSum = recent.projects.reduce((sum, project) => sum + project.totalTokens, 0)
  const routeSum = recent.routes.reduce((sum, route) => sum + route.totalTokens, 0)
  assert.equal(projectSum, recent.totals.totalTokens)
  assert.equal(routeSum, recent.totals.totalTokens)
})

test('the CSV row count matches the derived view', { skip }, () => {
  const payload = { ok: true, schemaVersion: 2, mode: 'accurate', deduped: true, generatedAt: Date.now(), problems: [], ...aggregate(rows, true) }
  const view = client.deriveView(payload, 'all', Date.now())
  const lines = client.buildCsv(view, payload, 'zh').replace(/^\uFEFF/u, '').split('\r\n')
  const body = lines.slice(1, 1 + view.sessions.length)
  assert.equal(body.length, view.sessions.length)
  const csvTotal = body.reduce((sum, line) => sum + Number(line.split(',')[11]), 0)
  assert.equal(csvTotal, view.totals.totalTokens, 'the CSV per-session column must sum to the headline')
  assert.equal(bucketTotal(view.totals.own), view.totals.totalTokens)
})
