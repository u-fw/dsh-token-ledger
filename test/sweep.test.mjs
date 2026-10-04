/**
 * Tests for the sweep itself: which sessions get re-read, and whether every
 * observation lease is released.
 *
 * A fake context stands in for `sessionQuery` / `sessionPersistence` /
 * `sessionProjectionCache`, so these run without a live harness and without
 * touching the real corpus.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { computeLedger } from '../lib/index.js'

/** One `assistant/message` carrying usage and a model route. */
const settlement = (seq, turn, step, input, output, provider = 'p', model = 'm') => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq,
  data: {
    turn,
    step,
    message: { role: 'assistant', content: [], source: { kind: 'model', provider, model } },
    stream: [],
    usage: { inputTokens: input, outputTokens: output },
  },
})

/**
 * A fake host context.
 *
 * @param sessions - `{ header, events, inheritedEventCount, revision }` per session.
 *   `revision` is what the persistence index reports; `undefined` means the
 *   session is not durable yet.
 */
function fakeContext(sessions) {
  const state = {
    sessions: new Map(sessions.map((session) => [session.header.id, session])),
    observations: 0,
    disposed: 0,
    listed: 0,
    fastReads: 0,
  }

  const ctx = {
    sessionQuery: {
      async listSessions() {
        state.listed += 1
        return [...state.sessions.values()].map((session) => ({
          header: session.header,
          live: false,
          persisted: session.revision !== undefined,
        }))
      },
      async observeSession(id) {
        const session = state.sessions.get(id)
        if (session === undefined) throw new Error(`no such session ${id}`)
        if (session.fail === true) throw new Error('stored session is corrupt')
        state.observations += 1
        let disposed = false
        return {
          source: 'prepared',
          header: session.header,
          inheritedEventCount: session.inheritedEventCount ?? 0,
          events: session.events,
          cursor: session.events.at(-1)?.seq ?? -1,
          projections: { asOfSeq: 0, values: { tokenUsage: session.projected } },
          retain() {
            return this
          },
          [Symbol.dispose]() {
            if (disposed) return
            disposed = true
            state.disposed += 1
          },
        }
      },
    },
    get(name) {
      if (name === 'sessionPersistence') {
        return {
          async list() {
            return [...state.sessions.values()]
              .filter((session) => session.revision !== undefined)
              .map((session) => ({ header: session.header, revision: session.revision }))
          },
        }
      }
      if (name === 'sessionProjectionCache') {
        return {
          cachedSnapshot(header) {
            state.fastReads += 1
            const session = state.sessions.get(header.id)
            if (session?.cached === undefined) return undefined
            return { asOfSeq: 0, values: { tokenUsage: session.cached } }
          },
        }
      }
      return undefined
    },
  }

  return { ctx, state }
}

const header = (id, overrides = {}) => ({
  id,
  cwd: overrides.cwd ?? 'C:/w',
  createdAt: overrides.createdAt ?? 1,
  isSeeded: overrides.isSeeded ?? false,
  origin: overrides.origin,
  version: 4,
})

const sessionsFixture = () => [
  {
    header: header('a'),
    events: [settlement(1, 1, 1, 100, 10)],
    projected: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    revision: 'r1',
  },
  {
    header: header('b', { isSeeded: true, origin: 'subagent' }),
    // Own events start AT this sequence, so 2 inherits seq 1 and keeps seq 2.
    inheritedEventCount: 2,
    events: [settlement(1, 1, 1, 900, 90), settlement(2, 2, 1, 7, 3)],
    projected: { uncachedInputTokens: 907, outputTokens: 93, cacheReadTokens: 0, cacheWriteTokens: 0 },
    revision: 'r1',
  },
]

test('a cold sweep reads every session and releases every lease', async () => {
  const { ctx, state } = fakeContext(sessionsFixture())
  const payload = await computeLedger(ctx, new Map(), 'accurate', false, undefined)

  assert.equal(payload.sessionsRead, 2)
  assert.equal(payload.sessionsReused, 0)
  assert.equal(state.observations, 2)
  assert.equal(state.disposed, 2, 'an undisposed lease pins a whole parsed log in the query cache')
  assert.equal(payload.totals.ownTotalTokens, 110 + 10, 'the seeded session counts only its own event')
  assert.equal(payload.totals.reportedTotalTokens, 110 + 1000)
  assert.equal(payload.foldMismatches, 0)
})

test('an unchanged revision is never read again', async () => {
  const { ctx, state } = fakeContext(sessionsFixture())
  const cache = new Map()
  await computeLedger(ctx, cache, 'accurate', false, undefined)
  const second = await computeLedger(ctx, cache, 'accurate', false, undefined)

  assert.equal(second.sessionsRead, 0)
  assert.equal(second.sessionsReused, 2)
  assert.equal(state.observations, 2, 'the second sweep must not observe anything')
  assert.equal(second.totals.ownTotalTokens, 120)
})

test('only the session whose log moved is re-read', async () => {
  const sessions = sessionsFixture()
  const { ctx, state } = fakeContext(sessions)
  const cache = new Map()
  await computeLedger(ctx, cache, 'accurate', false, undefined)

  sessions[0].revision = 'r2'
  sessions[0].events.push(settlement(2, 2, 1, 5, 1))
  const payload = await computeLedger(ctx, cache, 'accurate', false, undefined)

  assert.equal(payload.sessionsRead, 1)
  assert.equal(payload.sessionsReused, 1)
  assert.equal(state.observations, 3)
  assert.equal(payload.totals.ownTotalTokens, 116 + 10)
})

test('a session that is not durable yet has no revision and is always read', async () => {
  const sessions = sessionsFixture()
  sessions[1].revision = undefined
  const { ctx, state } = fakeContext(sessions)
  const cache = new Map()
  await computeLedger(ctx, cache, 'accurate', false, undefined)
  const second = await computeLedger(ctx, cache, 'accurate', false, undefined)

  assert.equal(second.sessionsRead, 1)
  assert.equal(second.sessionsReused, 1)
  assert.equal(state.observations, 3, 'the live session is observed on both sweeps')
})

test('refresh discards the memo and re-reads everything', async () => {
  const { ctx, state } = fakeContext(sessionsFixture())
  const cache = new Map()
  await computeLedger(ctx, cache, 'accurate', false, undefined)
  const refreshed = await computeLedger(ctx, cache, 'accurate', true, undefined)

  assert.equal(refreshed.sessionsRead, 2)
  assert.equal(refreshed.sessionsReused, 0)
  assert.equal(state.observations, 4)
})

test('a failing observation becomes a problem row without aborting the sweep', async () => {
  const sessions = sessionsFixture()
  sessions[1].fail = true
  const { ctx } = fakeContext(sessions)
  const payload = await computeLedger(ctx, new Map(), 'accurate', false, undefined)

  assert.equal(payload.sessionCount, 2)
  assert.equal(payload.problems.length, 1)
  assert.equal(payload.problems[0].sessionId, 'b')
  assert.equal(payload.totals.ownTotalTokens, 110, 'the readable session still counts')
})

test('a failed read is retried instead of being memoized', async () => {
  const sessions = sessionsFixture()
  sessions[1].fail = true
  const { ctx, state } = fakeContext(sessions)
  const cache = new Map()

  const first = await computeLedger(ctx, cache, 'accurate', false, undefined)
  assert.equal(first.problems.length, 1)
  assert.equal(cache.size, 1, 'only the successful session may be memoized')

  // The log did not move, so only a non-memoized failure can recover.
  sessions[1].fail = false
  const second = await computeLedger(ctx, cache, 'accurate', false, undefined)

  assert.equal(second.problems.length, 0)
  assert.equal(second.sessionsRead, 1, 'the previously failed session is read again')
  assert.equal(second.sessionsReused, 1)
  // The failed attempt threw before it could be counted, so the counter reaches
  // two: the successful cold read, then the retry.
  assert.equal(state.observations, 2)
  assert.equal(second.totals.ownTotalTokens, 120, 'its tokens are counted on the retry')
})

test('the memo does not retain sessions that left the corpus', async () => {
  const { ctx, state } = fakeContext(sessionsFixture())
  const cache = new Map()
  await computeLedger(ctx, cache, 'accurate', false, undefined)
  assert.equal(cache.size, 2)

  state.sessions.delete('b')
  const payload = await computeLedger(ctx, cache, 'accurate', false, undefined)

  assert.equal(cache.size, 1, 'the memo is bounded by the corpus')
  assert.equal(payload.sessionCount, 1)
  assert.equal(payload.totals.ownTotalTokens, 110)
})

test('fast mode reads no logs at all', async () => {
  const sessions = sessionsFixture()
  sessions[0].cached = sessions[0].projected
  sessions[1].cached = sessions[1].projected
  const { ctx, state } = fakeContext(sessions)
  const payload = await computeLedger(ctx, new Map(), 'fast', false, undefined)

  assert.equal(state.observations, 0, 'the fast path must never observe a session')
  assert.equal(state.fastReads, 2)
  assert.equal(payload.deduped, false)
  assert.equal(payload.totals.own, null)
  assert.equal(payload.routes, null)
  assert.equal(payload.totals.reportedTotalTokens, 1110)
})

test('the payload carries the schema version and per-session rows for the client', async () => {
  const { ctx } = fakeContext(sessionsFixture())
  const payload = await computeLedger(ctx, new Map(), 'accurate', false, undefined)

  assert.equal(payload.schemaVersion, 2)
  assert.equal(payload.sessions.length, 2)
  assert.equal(payload.sessions[0].id, 'a')
  assert.deepEqual(payload.routes.map((route) => route.route), ['p/m'])
  const routeSum = payload.routes.reduce((sum, route) => sum + route.totalTokens, 0)
  assert.equal(routeSum, payload.totals.ownTotalTokens)
  assert.equal(payload.sessionsRead + payload.sessionsReused, payload.sessionCount)
})
