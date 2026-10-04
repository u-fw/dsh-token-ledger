/**
 * Unit tests for the fold itself: replacement within a step, retry retirement,
 * inherited-prefix skipping, and route attribution. These use synthetic events,
 * so they run anywhere.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { bucketTotal, foldUsage, foldUsageDetailed, routeLabel, usageOf } from '../lib/index.js'

/** One `assistant/message` carrying an explicit usage record. */
const settlement = (seq, turn, step, usage, source) => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq,
  data: {
    turn,
    step,
    message: { role: 'assistant', content: [], source: source ?? { kind: 'model', provider: 'p', model: 'm' } },
    stream: [],
    usage: { inputTokens: 0, outputTokens: 0, ...usage },
  },
})

/** One `assistant/attempt` carrying usage only inside its embedded stream. */
const attempt = (seq, turn, step, usage) => ({
  type: 'assistant/attempt',
  seq,
  time: 1000 + seq,
  data: {
    turn,
    step,
    stream: [{ type: 'chunk', time: 1000 + seq, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, ...usage } } }],
  },
})

/** One `request/header` naming the route put in force. */
const requestHeader = (seq, provider, model) => ({
  type: 'request/header',
  seq,
  time: 1000 + seq,
  data: { header: { config: { provider, model } }, reason: 'initial' },
})

test('sums one settlement into the four buckets', () => {
  const events = [settlement(1, 1, 1, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 })]
  const totals = foldUsage(events, 0)
  assert.deepEqual(totals, { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 })
})

test('a later settlement in the same step replaces the earlier one', () => {
  const events = [
    attempt(1, 1, 1, { inputTokens: 10, outputTokens: 1 }),
    settlement(2, 1, 1, { inputTokens: 100, outputTokens: 20 }),
  ]
  assert.equal(bucketTotal(foldUsage(events, 0)), 120)
})

test('llm/retry-started retires the slot so both attempts are billed', () => {
  const events = [
    attempt(1, 1, 1, { inputTokens: 10, outputTokens: 1 }),
    { type: 'llm/retry-started', seq: 2, time: 1002, data: { turn: 1, step: 1 } },
    settlement(3, 1, 1, { inputTokens: 100, outputTokens: 20 }),
  ]
  assert.equal(bucketTotal(foldUsage(events, 0)), 131)
})

test('a separate step adds rather than replaces', () => {
  const events = [
    settlement(1, 1, 1, { inputTokens: 100, outputTokens: 20 }),
    settlement(2, 1, 2, { inputTokens: 7, outputTokens: 3 }),
  ]
  assert.equal(bucketTotal(foldUsage(events, 0)), 130)
})

test('fromSeq skips an inherited prefix', () => {
  const events = [
    settlement(1, 1, 1, { inputTokens: 1000, outputTokens: 100 }),
    settlement(2, 2, 1, { inputTokens: 7, outputTokens: 3 }),
  ]
  assert.equal(bucketTotal(foldUsage(events, 0)), 1110)
  assert.equal(bucketTotal(foldUsage(events, 2)), 10)
})

test('usage comes from the stream when the message carries none', () => {
  const events = [attempt(1, 1, 1, { inputTokens: 42, outputTokens: 8 })]
  assert.equal(usageOf(events[0]).inputTokens, 42)
  assert.equal(bucketTotal(foldUsage(events, 0)), 50)
})

test('attributes a settlement to its own message route', () => {
  const events = [
    settlement(1, 1, 1, { inputTokens: 100, outputTokens: 0 }, { kind: 'model', provider: 'provider-a', model: 'model-x' }),
    settlement(2, 1, 2, { inputTokens: 50, outputTokens: 0 }, { kind: 'model', provider: 'provider-b', model: 'model-y' }),
  ]
  const { totals, byRoute } = foldUsageDetailed(events, 0)
  assert.deepEqual(byRoute.map((entry) => entry.route), ['provider-a/model-x', 'provider-b/model-y'])
  assert.equal(byRoute[0].uncachedInputTokens, 100)
  assert.equal(byRoute[1].uncachedInputTokens, 50)
  assert.equal(bucketTotal(totals), 150)
})

test('an attempt without a route falls back to the newest request header', () => {
  const events = [
    requestHeader(1, 'provider-c', 'model-z'),
    attempt(2, 1, 1, { inputTokens: 30, outputTokens: 0 }),
  ]
  const { byRoute } = foldUsageDetailed(events, 0)
  assert.equal(byRoute.length, 1)
  assert.equal(byRoute[0].route, 'provider-c/model-z')
  assert.equal(byRoute[0].uncachedInputTokens, 30)
})

test('a settlement with neither message route nor header lands in the unknown bucket', () => {
  const events = [attempt(1, 1, 1, { inputTokens: 5, outputTokens: 0 })]
  assert.equal(foldUsageDetailed(events, 0).byRoute[0].route, '(unknown)')
})

test('byRoute always sums to totals, including across a replacement', () => {
  const events = [
    settlement(1, 1, 1, { inputTokens: 100, outputTokens: 20 }, { kind: 'model', provider: 'a', model: 'x' }),
    requestHeader(2, 'b', 'y'),
    attempt(3, 1, 1, { inputTokens: 9, outputTokens: 1 }),
    { type: 'llm/retry-started', seq: 4, time: 1004, data: { turn: 1, step: 1 } },
    attempt(5, 1, 1, { inputTokens: 11, outputTokens: 2 }),
    settlement(6, 1, 2, { inputTokens: 1, outputTokens: 1 }, { kind: 'model', provider: 'c', model: 'z' }),
  ]
  const { totals, byRoute } = foldUsageDetailed(events, 0)
  const summed = byRoute.reduce((accumulator, entry) => ({
    uncachedInputTokens: accumulator.uncachedInputTokens + entry.uncachedInputTokens,
    outputTokens: accumulator.outputTokens + entry.outputTokens,
    cacheReadTokens: accumulator.cacheReadTokens + entry.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens + entry.cacheWriteTokens,
  }), { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.deepEqual(summed, totals)
})

test('routeLabel degrades predictably', () => {
  assert.equal(routeLabel('p', 'm'), 'p/m')
  assert.equal(routeLabel(undefined, 'm'), 'm')
  assert.equal(routeLabel('p', undefined), 'p')
  assert.equal(routeLabel(undefined, undefined), '(unknown)')
})
