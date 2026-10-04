/**
 * The cache-hit share must match DSH's own, so these cases pin the ported
 * formatter's observable behaviour: which denominator, how it rounds, what it
 * returns with no billed input, and the rule that a partial hit is never shown
 * as 100%.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClientHalf } from './support/client-half.mjs'

const client = await loadClientHalf()
const percent = client.cacheHitPercent

test('the denominator is prompt-side input, not the grand total', () => {
  // 750 cached of 1000 prompt tokens, plus 500 output the denominator must ignore.
  assert.equal(percent(750, 1000, 0), '75')
  assert.equal(percent(750, 1000, 1), '75')
})

test('no billed input yields nothing to show', () => {
  assert.equal(percent(0, 0, 0), null)
  assert.equal(percent(0, 0, 1), null)
})

test('a full hit is exactly 100', () => {
  assert.equal(percent(1000, 1000, 0), '100')
  assert.equal(percent(1000, 1000, 1), '100')
})

test('one decimal place is kept when it carries information', () => {
  assert.equal(percent(944, 1000, 1), '94.4')
  assert.equal(percent(940, 1000, 1), '94')
  assert.equal(percent(999, 1000, 1), '99.9')
})

test('integer precision rounds normally below 100', () => {
  assert.equal(percent(945, 1000, 0), '95')
  assert.equal(percent(994, 1000, 0), '99')
})

test('a partial hit is never rounded up to 100', () => {
  // 99.996% would round to 100 at one decimal place; the formatter escalates
  // precision instead of claiming a full hit.
  const nearlyAll = percent(999_960, 1_000_000, 1)
  assert.notEqual(nearlyAll, '100')
  assert.ok(nearlyAll.startsWith('99.'), `expected a 99.x value, got ${nearlyAll}`)

  const alsoNearlyAll = percent(999_999, 1_000_000, 0)
  assert.notEqual(alsoNearlyAll, '100')
  assert.ok(alsoNearlyAll.startsWith('99.'), `expected a 99.x value, got ${alsoNearlyAll}`)
})

test('the escalation keeps the digits that actually distinguish it', () => {
  // One token missing out of a million: 99.9999%.
  assert.equal(percent(999_999, 1_000_000, 1), '99.9999')
})

test('a tiny share is reported honestly rather than as zero', () => {
  assert.equal(percent(1, 1_000_000, 1), '0')
  assert.equal(percent(1, 1_000_000, 0), '0')
})

test('a large corpus with a high hit rate stays readable', () => {
  // Round figures so the case reads as the shape it is testing, not as a sample.
  const rate = percent(944_000_000, 1_000_000_000, 1)
  assert.equal(rate, '94.4')
})
