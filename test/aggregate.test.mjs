/**
 * Unit tests for the aggregate: the invariants every view depends on, including
 * the route table summing to the headline figure.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { aggregate, bucketTotal } from '../lib/index.js'

const buckets = (uncached, output, cacheRead = 0, cacheWrite = 0) => ({
  uncachedInputTokens: uncached,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
})

const row = (overrides) => ({
  header: {
    id: overrides.id,
    cwd: overrides.cwd,
    createdAt: overrides.createdAt ?? 1,
    isSeeded: overrides.isSeeded ?? false,
    origin: overrides.origin,
    parentSession: overrides.parentSession,
  },
  isSeeded: overrides.isSeeded ?? false,
  inheritedEventCount: overrides.inheritedEventCount ?? 0,
  reported: overrides.reported,
  own: overrides.own,
  byRoute: overrides.byRoute ?? [],
  ...(overrides.foldMismatch === undefined ? {} : { foldMismatch: overrides.foldMismatch }),
  ...(overrides.problem === undefined ? {} : { problem: overrides.problem }),
})

const rows = () => [
  row({
    id: 'a',
    cwd: 'C:/work/alpha',
    own: buckets(100, 10),
    reported: buckets(100, 10),
    byRoute: [{ route: 'p/m', ...buckets(100, 10), totalTokens: 110 }],
  }),
  row({
    id: 'b',
    cwd: 'C:/work/alpha',
    isSeeded: true,
    inheritedEventCount: 500,
    origin: 'subagent',
    parentSession: 'a',
    own: buckets(7, 3),
    reported: buckets(900, 90),
    byRoute: [{ route: 'q/n', ...buckets(7, 3), totalTokens: 10 }],
  }),
  row({
    id: 'c',
    cwd: 'C:/work/beta',
    own: buckets(1, 1),
    reported: buckets(1, 1),
    byRoute: [
      { route: 'p/m', ...buckets(1, 1), totalTokens: 2 },
      { route: 'q/n', ...buckets(0, 0), totalTokens: 0 },
    ],
  }),
]

test('project totals sum to the corpus totals', () => {
  const result = aggregate(rows(), true)
  const own = result.projects.reduce((sum, project) => sum + project.ownTotalTokens, 0)
  const reported = result.projects.reduce((sum, project) => sum + project.reportedTotalTokens, 0)
  assert.equal(own, result.totals.ownTotalTokens)
  assert.equal(reported, result.totals.reportedTotalTokens)
  assert.equal(own, 110 + 10 + 2)
  assert.equal(reported, 110 + 990 + 2)
})

test('route rows sum to the headline figure and drop empty buckets', () => {
  const result = aggregate(rows(), true)
  const summed = result.routes.reduce((sum, route) => sum + route.totalTokens, 0)
  assert.equal(summed, result.totals.ownTotalTokens)
  assert.deepEqual(result.routes.map((route) => route.route), ['p/m', 'q/n'])
  assert.equal(result.routes[0].totalTokens, 112)
  assert.equal(result.routes[1].totalTokens, 10)
})

test('overlap is exactly the reported minus own gap', () => {
  const result = aggregate(rows(), true)
  assert.equal(result.totals.overlapTokens, result.totals.reportedTotalTokens - result.totals.ownTotalTokens)
  for (const project of result.projects) {
    assert.equal(project.overlapTokens, project.reportedTotalTokens - project.ownTotalTokens)
  }
})

test('counts separate subagent sessions from inherited ones', () => {
  const result = aggregate(rows(), true)
  assert.equal(result.sessionCount, 3)
  assert.equal(result.projectCount, 2)
  assert.equal(result.forkCount, 1)
  assert.equal(result.subagentCount, 1)
  const alpha = result.projects.find((project) => project.name === 'alpha')
  assert.equal(alpha.sessions, 2)
  assert.equal(alpha.forks, 1)
  assert.equal(alpha.subagentSessions, 1)
})

test('session rows are ordered by own tokens and carry their own route table', () => {
  const result = aggregate(rows(), true)
  assert.deepEqual(result.sessions.map((session) => session.id), ['a', 'b', 'c'])
  assert.equal(bucketTotal(result.sessions[0].own), 110)
  assert.equal(result.sessions[1].origin, 'subagent')
  assert.equal(result.sessions[1].parentSession, 'a')
  assert.equal(result.sessions[1].inheritedEventCount, 500)
  assert.equal(result.sessions[1].byRoute.length, 1)
})

test('fast mode reports no own figures and no route table', () => {
  const fast = rows().map((entry) => ({ ...entry, own: undefined, byRoute: [] }))
  const result = aggregate(fast, false)
  assert.equal(result.totals.own, null)
  assert.equal(result.totals.ownTotalTokens, null)
  assert.equal(result.totals.overlapTokens, null)
  assert.equal(result.routes, null)
  assert.equal(result.projects[0].ownTotalTokens, null)
  assert.equal(result.totals.reportedTotalTokens, 110 + 990 + 2)
})

test('a session with no cwd still counts, under one project row', () => {
  const result = aggregate([row({ id: 'x', cwd: undefined, own: buckets(5, 0), reported: buckets(5, 0) })], true)
  assert.equal(result.projectCount, 1)
  assert.equal(result.projects[0].cwd, null)
  assert.equal(result.totals.ownTotalTokens, 5)
})

test('fold mismatches and read problems are surfaced as counts', () => {
  const result = aggregate([
    row({ id: 'a', cwd: 'C:/w', own: buckets(1, 0), reported: buckets(1, 0), foldMismatch: true }),
    row({ id: 'b', cwd: 'C:/w', problem: 'boom' }),
  ], true)
  assert.equal(result.foldMismatches, 1)
  const failed = result.sessions.find((session) => session.id === 'b')
  assert.equal(failed.problem, 'boom')
  assert.equal(failed.own, null)
})
