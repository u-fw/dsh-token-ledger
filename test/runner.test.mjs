/**
 * Tests for the request-handling layer: one shared memo, one in-flight sweep per
 * mode, and a throttle that keeps a hammered refresh parameter from forcing
 * repeated full-corpus reads.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createLedgerRunner } from '../lib/index.js'

const settlement = (seq, turn, step, input, output) => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq,
  data: {
    turn,
    step,
    message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
    stream: [],
    usage: { inputTokens: input, outputTokens: output },
  },
})

/** A fake context that counts how many sweeps touched the corpus. */
function fakeContext(sessions) {
  const state = { sessions, listed: 0, observations: 0 }
  const ctx = {
    sessionQuery: {
      async listSessions() {
        state.listed += 1
        return state.sessions.map((session) => ({ header: session.header, live: false, persisted: true }))
      },
      async observeSession(id) {
        const session = state.sessions.find((candidate) => candidate.header.id === id)
        state.observations += 1
        return {
          source: 'prepared',
          header: session.header,
          inheritedEventCount: 0,
          events: session.events,
          cursor: 0,
          projections: { asOfSeq: 0, values: { tokenUsage: session.projected } },
          retain() {
            return this
          },
          [Symbol.dispose]() {},
        }
      },
    },
    get(name) {
      if (name === 'sessionPersistence') {
        return { async list() { return state.sessions.map((session) => ({ header: session.header, revision: session.revision })) } }
      }
      return undefined
    },
  }
  return { ctx, state }
}

const fixture = () => [{
  header: { id: 'a', cwd: 'C:/w', createdAt: 1, isSeeded: false, version: 4 },
  events: [settlement(1, 1, 1, 100, 10)],
  projected: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  revision: 'r1',
}]

/** A controllable clock. */
function clock(start = 1_000_000) {
  const state = { value: start }
  return { now: () => state.value, advance: (ms) => { state.value += ms } }
}

test('a burst of same-mode requests shares one sweep', async () => {
  const { ctx, state } = fakeContext(fixture())
  const runner = createLedgerRunner(ctx)

  const [first, second, third] = await Promise.all([
    runner.run('accurate', false, undefined),
    runner.run('accurate', false, undefined),
    runner.run('accurate', false, undefined),
  ])

  assert.equal(state.listed, 1, 'three concurrent requests must list the corpus once')
  assert.equal(state.observations, 1)
  assert.equal(first.totals.ownTotalTokens, 110)
  assert.equal(second.totals.ownTotalTokens, 110)
  assert.equal(third.totals.ownTotalTokens, 110)
})

test('the two modes do not share an in-flight sweep', async () => {
  const { ctx } = fakeContext(fixture())
  const runner = createLedgerRunner(ctx)
  const [accurate, fast] = await Promise.all([
    runner.run('accurate', false, undefined),
    runner.run('fast', false, undefined),
  ])
  assert.equal(accurate.deduped, true)
  assert.equal(fast.deduped, false)
  assert.equal(accurate.totals.ownTotalTokens, 110)
  assert.equal(fast.totals.ownTotalTokens, null)
})

test('the second sweep reuses the memo without touching the corpus', async () => {
  const { ctx, state } = fakeContext(fixture())
  const runner = createLedgerRunner(ctx)
  await runner.run('accurate', false, undefined)
  const second = await runner.run('accurate', false, undefined)

  assert.equal(state.observations, 1, 'the log must not be read twice')
  assert.equal(second.sessionsReused, 1)
  assert.equal(second.sessionsRead, 0)
})

test('a refresh inside the cooldown is throttled and says so', async () => {
  const { ctx, state } = fakeContext(fixture())
  const time = clock()
  const runner = createLedgerRunner(ctx, { now: time.now, refreshCooldownMs: 5_000 })

  await runner.run('accurate', false, undefined)
  // The first explicit refresh is always honoured — an unforced sweep does not
  // start the cooldown — and it is the one that arms it.
  const honoured = await runner.run('accurate', true, undefined)
  assert.equal(honoured.refreshThrottled, undefined)
  assert.equal(honoured.sessionsRead, 1)
  assert.equal(state.observations, 2)

  const refused = await runner.run('accurate', true, undefined)
  assert.equal(refused.refreshThrottled, true)
  assert.equal(refused.sessionsReused, 1, 'the memo stands, so no second full re-read happened')
  assert.equal(state.observations, 2, 'the throttled refresh must not touch the corpus')
})

test('a refresh after the cooldown is honoured', async () => {
  const { ctx, state } = fakeContext(fixture())
  const time = clock()
  const runner = createLedgerRunner(ctx, { now: time.now, refreshCooldownMs: 5_000 })

  await runner.run('accurate', false, undefined)
  time.advance(5_000)
  const forced = await runner.run('accurate', true, undefined)

  assert.equal(forced.refreshThrottled, undefined)
  assert.equal(forced.sessionsRead, 1, 'the memo was cleared and the log re-read')
  assert.equal(forced.sessionsReused, 0)
  assert.equal(state.observations, 2)
})

test('an unforced request is never reported as throttled', async () => {
  const { ctx } = fakeContext(fixture())
  const runner = createLedgerRunner(ctx, { refreshCooldownMs: 5_000 })
  const payload = await runner.run('accurate', false, undefined)
  assert.equal(payload.refreshThrottled, undefined)
})
