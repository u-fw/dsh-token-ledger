/**
 * Tests for the client half's pure logic: the view derivation, its fallback when
 * the host half has not reloaded yet, and the CSV writer.
 *
 * The bundle is a browser artifact, so it is loaded here with a stubbed
 * `window.__ModuleLoader__` and a stubbed `react`; nothing is rendered.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClientHalf } from './support/client-half.mjs'

const client = await loadClientHalf()

const buckets = (uncached, output, cacheRead = 0) => ({
  uncachedInputTokens: uncached,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
})

const session = (overrides) => ({
  id: overrides.id,
  cwd: overrides.cwd,
  name: overrides.name ?? 'proj',
  createdAt: overrides.createdAt ?? 1_000,
  parentSession: null,
  origin: overrides.origin ?? 'user',
  isSeeded: overrides.isSeeded ?? false,
  inheritedEventCount: overrides.inheritedEventCount ?? 0,
  reported: overrides.reported,
  own: overrides.own,
  byRoute: overrides.byRoute ?? [],
  problem: null,
})

const payload = (sessions) => ({
  ok: true,
  schemaVersion: 2,
  mode: 'accurate',
  deduped: true,
  generatedAt: 1,
  durationMs: 1,
  sessionsReused: 0,
  sessionsRead: sessions.length,
  problems: [],
  sessions,
  projects: [],
  routes: null,
  totals: {},
  sessionCount: sessions.length,
  projectCount: 2,
  forkCount: 1,
  subagentCount: 1,
  foldMismatches: 0,
})

const sample = payload([
  session({ id: 'a', cwd: 'C:/w/alpha', name: 'alpha', own: buckets(100, 10), reported: buckets(100, 10), byRoute: [{ route: 'p/m', ...buckets(100, 10), totalTokens: 110 }] }),
  session({ id: 'b', cwd: 'C:/w/alpha', name: 'alpha', isSeeded: true, origin: 'subagent', inheritedEventCount: 9, own: buckets(7, 3), reported: buckets(900, 90), byRoute: [{ route: 'q/n', ...buckets(7, 3), totalTokens: 10 }] }),
  session({ id: 'c', cwd: 'C:/w/beta', name: 'beta', own: buckets(1, 1), reported: buckets(1, 1), byRoute: [{ route: 'p/m', ...buckets(1, 1), totalTokens: 2 }] }),
])

test('the bundle registers under the package name and needs only react', () => {
  assert.deepEqual(client.inject, ['slots', 'locale'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(client.SUMMARY_URL, '/token-ledger/summary')
})

test('project and route aggregates sum to the derived totals', () => {
  const view = client.deriveView(sample, 'all', 2_000)
  assert.equal(view.degraded, false)
  assert.equal(view.totals.totalTokens, 122)
  assert.equal(view.totals.reportedTotalTokens, 1102)
  assert.equal(view.totals.overlapTokens, 980)
  assert.equal(view.sessions.length, 3)

  const projectSum = view.projects.reduce((sum, project) => sum + project.totalTokens, 0)
  assert.equal(projectSum, view.totals.totalTokens)
  const routeSum = view.routes.reduce((sum, route) => sum + route.totalTokens, 0)
  assert.equal(routeSum, view.totals.totalTokens)
  assert.deepEqual(view.projects.map((project) => project.name), ['alpha', 'beta'])
  assert.equal(view.projects[0].subagents, 1)
  assert.equal(view.projects[0].forks, 1)
})

test('every project and route row carries all four billing buckets', () => {
  // The input/output columns are sums of these buckets, so their presence is the
  // render's data contract rather than a formatting detail.
  const view = client.deriveView(sample, 'all', 2_000)
  const required = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
  for (const row of [...view.projects, ...view.routes]) {
    for (const field of required) {
      assert.equal(typeof row[field], 'number', `${row.name ?? row.route} is missing ${field}`)
    }
    assert.equal(
      row.totalTokens,
      row.uncachedInputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens,
    )
  }
  // 'p/m' serves alpha's 100+10 and beta's 1+1; 'q/n' only the seeded child's own 7+3.
  const byRoute = new Map(view.routes.map((route) => [route.route, route]))
  assert.equal(byRoute.get('p/m').outputTokens, 11)
  assert.equal(byRoute.get('p/m').uncachedInputTokens, 101)
  assert.equal(byRoute.get('q/n').outputTokens, 3)
})

test('the time filter keeps only sessions created inside the window', () => {
  const now = 100 * 86_400_000
  const mixed = payload([
    session({ id: 'old', cwd: 'C:/w/a', own: buckets(1000, 0), reported: buckets(1000, 0), createdAt: now - 40 * 86_400_000 }),
    session({ id: 'new', cwd: 'C:/w/a', own: buckets(5, 0), reported: buckets(5, 0), createdAt: now - 2 * 86_400_000 }),
  ])
  assert.equal(client.deriveView(mixed, 'all', now).totals.totalTokens, 1005)
  assert.equal(client.deriveView(mixed, '30', now).totals.totalTokens, 5)
  assert.equal(client.deriveView(mixed, '7', now).totals.totalTokens, 5)
  assert.equal(client.deriveView(mixed, '7', now).sessions.length, 1)
})

test('fast-mode payloads aggregate on reported figures', () => {
  const fast = { ...sample, deduped: false, sessions: sample.sessions.map((entry) => ({ ...entry, own: null, byRoute: null })) }
  const view = client.deriveView(fast, 'all', 2_000)
  assert.equal(view.totals.reportedTotalTokens, 1102)
  assert.equal(view.totals.totalTokens, 0)
  assert.deepEqual(view.routes, [])
})

test('a host half without per-session rows degrades instead of showing zero', () => {
  const legacy = {
    ok: true,
    mode: 'accurate',
    deduped: true,
    generatedAt: 1,
    durationMs: 3000,
    problems: [],
    projects: [
      { cwd: 'C:/w/alpha', name: 'alpha', sessions: 2, forks: 1, subagentSessions: 1, ownTotalTokens: 110, reportedTotalTokens: 990, own: buckets(110, 0), reported: buckets(990, 0) },
    ],
    totals: { own: buckets(110, 0), reported: buckets(990, 0), ownTotalTokens: 110, reportedTotalTokens: 990, overlapTokens: 880 },
    sessionCount: 2,
    forkCount: 1,
  }
  const view = client.deriveView(legacy, 'all', 2_000)
  assert.equal(view.degraded, true)
  assert.equal(view.sessions.length, 0)
  assert.equal(view.totals.totalTokens, 110)
  assert.equal(view.projects[0].name, 'alpha')
  assert.equal(view.projects[0].subagents, 1)
})

test('the CSV carries one line per session plus a total', () => {
  const view = client.deriveView(sample, 'all', 2_000)
  const csv = client.buildCsv(view, sample, 'zh')
  const lines = csv.replace(/^\uFEFF/u, '').split('\r\n')
  assert.ok(csv.startsWith('\uFEFF'), 'a BOM keeps Excel from mangling non-ASCII names')
  assert.ok(lines[0].startsWith('session_id,project,cwd,created_at'))
  assert.equal(lines.filter((line) => line.includes('C:/w/alpha')).length, 2)
  assert.ok(lines.some((line) => line.startsWith('TOTAL,')))
  assert.ok(lines.some((line) => line.startsWith('# mode,accurate')))
})

test('a project name containing a comma or quote is escaped', () => {
  const tricky = payload([session({ id: 'x', cwd: 'C:/w/a,b', name: 'a,"b"', own: buckets(1, 0), reported: buckets(1, 0) })])
  const csv = client.buildCsv(client.deriveView(tricky, 'all', 2_000), tricky, 'en')
  assert.ok(csv.includes('"a,""b"""'), 'quotes must be doubled and the field quoted')
})
