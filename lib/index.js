/**
 * Host half of the token ledger: totals provider-billed token usage across every
 * project (session `cwd`) in this DSH installation, per model route, and per
 * session.
 *
 * Three figures describe the same corpus:
 *
 * - `reported` — the sum of each session's `tokenUsage` projection, exactly the
 *   numbers the chat stats strip shows for one session. A forked session's log
 *   carries its parent's inherited prefix, so this figure counts that shared
 *   history once per fork and overstates a corpus total.
 * - `own` — the same fold applied only to a session's OWN events (those at or
 *   after `inheritedEventCount`), so every billed model call in the corpus is
 *   counted exactly once. This is the headline figure.
 * - `byRoute` — `own` attributed to the provider/model that actually served each
 *   call, taken from the settlement's own `message.source` and otherwise from the
 *   newest `request/header`/`request/context` route in force.
 *
 * Reads come from `ctx.sessionQuery.observeSession(..., { projectionMode: 'all' })`.
 * The fold mirrors `tokenUsage` in `@deepseek-ai/dsh-token-meter`, and for a
 * session with no inherited prefix it must equal the projection's own value — a
 * self-check the payload reports as `foldMismatches`.
 *
 * A whole-log read costs a zstd decode plus a JSON parse, so results are cached
 * per session against `sessionPersistence`'s opaque `revision`, which that
 * service documents as existing precisely for derived read-model caches: an
 * unchanged revision means an unchanged log, and only a session whose log moved
 * is read again.
 *
 * @module dsh-token-ledger
 */

/** Cordis plugin name. */
export const name = 'token-ledger'

/** The ledger reads the session corpus and owns one route on the web carrier. */
export const inject = ['webServer', 'sessionQuery']

/** Exact route the client half polls. */
export const SUMMARY_PATH = '/token-ledger/summary'

/** Payload shape version; bump when a consumer-visible field changes meaning. */
export const SCHEMA_VERSION = 2

/** Route label used when a settlement reports no provider/model at all. */
const UNKNOWN_ROUTE = '(unknown)'

/** A zeroed bucket set: the four counters the `tokenUsage` wire view carries. */
const zeroBuckets = () => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** Sum two bucket sets. */
function addBuckets(left, right) {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
}

/** Sum minus one bucket set. */
function subtractBuckets(left, right) {
  return {
    uncachedInputTokens: left.uncachedInputTokens - right.uncachedInputTokens,
    outputTokens: left.outputTokens - right.outputTokens,
    cacheReadTokens: left.cacheReadTokens - right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens - right.cacheWriteTokens,
  }
}

/** Whether two bucket sets are equal. */
function sameBuckets(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

/** One scalar for sorting and display: every billed token, cache traffic included. */
export const bucketTotal = (buckets) =>
  buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens

/** Convert one provider `TokenUsage` record into the projection's bucket shape. */
function bucketsFromUsage(usage) {
  return {
    uncachedInputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

/** Accept one already-shaped `tokenUsage` wire view, or `undefined` when absent. */
export function bucketsFromWire(value) {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = value
  if ([uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].some((n) => typeof n !== 'number')) return undefined
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

/** Render one provider/model pair as the route label used throughout the payload. */
export function routeLabel(provider, model) {
  if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') return `${provider}/${model}`
  if (typeof model === 'string' && model !== '') return model
  if (typeof provider === 'string' && provider !== '') return provider
  return UNKNOWN_ROUTE
}

/** The route a settlement's own message declares, or `undefined` when it declares none. */
function routeOfMessage(event) {
  const source = event.data?.message?.source
  if (source === undefined || source === null || typeof source !== 'object') return undefined
  if (typeof source.provider !== 'string' && typeof source.model !== 'string') return undefined
  return routeLabel(source.provider, source.model)
}

/** The route a request-scoped event puts in force, or `undefined` when it names none. */
function routeOfRequest(event) {
  if (event.type === 'request/header') {
    const config = event.data?.header?.config
    if (config === undefined || config === null) return undefined
    return routeLabel(config.provider, config.model)
  }
  if (event.type === 'request/context') return routeLabel(event.data?.provider, event.data?.model)
  return undefined
}

/**
 * The usage one durable Assistant settlement reports for its attempt: the
 * message's own `usage`, else the last `usage` chunk embedded in its stream.
 * Mirrors `usageOf` in `@deepseek-ai/dsh-token-meter`.
 */
export function usageOf(event) {
  if (event.data?.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    const chunk = record?.type === 'chunk' ? record.chunk : undefined
    if (chunk?.type === 'usage') return chunk.usage
  }
  return undefined
}

/**
 * Mirror of the `tokenUsage` projection fold over the events at or after
 * `fromSeq`, additionally attributing every counted sample to a provider/model
 * route. A retry in the same step retires the replaced attempt's sample, and one
 * step's later sample replaces its earlier one, so every billed attempt is
 * counted once in the total and exactly once in its route's bucket.
 *
 * @param events - a session's full event log.
 * @param fromSeq - first sequence to fold; a session's own-events start.
 * @returns `{ totals, byRoute }`, where `totals` equals the sum over `byRoute`.
 */
export function foldUsageDetailed(events, fromSeq) {
  let totals = zeroBuckets()
  const byRoute = new Map()
  let last = null
  let currentRoute

  const routeBuckets = (route) => {
    let buckets = byRoute.get(route)
    if (buckets === undefined) {
      buckets = zeroBuckets()
      byRoute.set(route, buckets)
    }
    return buckets
  }

  for (const event of events) {
    if (typeof event.seq === 'number' && event.seq < fromSeq) continue

    const requested = routeOfRequest(event)
    if (requested !== undefined) currentRoute = requested

    if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === event.data.turn && last.step === event.data.step) last = null
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const usage = usageOf(event)
    if (usage === undefined) continue

    const turn = event.data.turn
    const step = event.data.step
    const buckets = bucketsFromUsage(usage)
    const route = routeOfMessage(event) ?? currentRoute ?? UNKNOWN_ROUTE
    const previous = last !== null && last.turn === turn && last.step === step ? last : null
    if (previous !== null && sameBuckets(previous.buckets, buckets) && previous.route === route) continue

    if (previous !== null) {
      byRoute.set(previous.route, subtractBuckets(routeBuckets(previous.route), previous.buckets))
      totals = subtractBuckets(totals, previous.buckets)
    }
    byRoute.set(route, addBuckets(routeBuckets(route), buckets))
    totals = addBuckets(totals, buckets)
    last = { turn, step, buckets, route }
  }

  const routes = [...byRoute.entries()]
    .map(([route, buckets]) => ({ route, ...buckets, totalTokens: bucketTotal(buckets) }))
    .filter((entry) => entry.totalTokens !== 0)
    .sort((left, right) => right.totalTokens - left.totalTokens || left.route.localeCompare(right.route))

  return { totals, byRoute: routes }
}

/**
 * Bucket totals alone — the shape the `tokenUsage` projection publishes.
 *
 * @param events - a session's full event log.
 * @param fromSeq - first sequence to fold.
 * @returns the four bucket totals for the folded range.
 */
export function foldUsage(events, fromSeq) {
  return foldUsageDetailed(events, fromSeq).totals
}

/** Release one observation lease; an undisposed lease pins a whole parsed log. */
function disposeObservation(observation) {
  try {
    observation?.[Symbol.dispose]?.()
  } catch {
    /* a lease that refuses to release is still better than an abandoned sweep */
  }
}

/** Human-readable failure text for one session's diagnostic entry. */
export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Project display name: the last path segment of a session's `cwd`. */
function projectName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '(no project directory)'
  const parts = cwd.split(/[\\/]+/u).filter((part) => part.length > 0)
  return parts.at(-1) ?? cwd
}

/**
 * Observe one session and derive its ledger row.
 *
 * @param ctx - context carrying `sessionQuery`.
 * @param header - the session's immutable header.
 * @param signal - cancellation for this read.
 * @returns the row, with `problem` set instead of usage when the read failed.
 */
async function observeRow(ctx, header, signal) {
  let observation
  try {
    observation = await ctx.sessionQuery.observeSession(header.id, {
      projectionMode: 'all',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    return { problem: errorText(error) }
  }

  try {
    const events = Array.isArray(observation.events) ? observation.events : undefined
    const inheritedEventCount = typeof observation.inheritedEventCount === 'number'
      ? observation.inheritedEventCount
      : 0
    const whole = events === undefined ? undefined : foldUsageDetailed(events, 0)
    const reported = bucketsFromWire(observation.projections?.values?.tokenUsage) ?? whole?.totals
    const own = inheritedEventCount > 0
      ? (events === undefined ? { totals: reported, byRoute: [] } : foldUsageDetailed(events, inheritedEventCount))
      : whole
    return {
      inheritedEventCount,
      reported,
      own: own?.totals,
      byRoute: own?.byRoute ?? [],
      foldMismatch: whole !== undefined
        && reported !== undefined
        && !sameBuckets(whole.totals, reported),
    }
  } catch (error) {
    return { problem: errorText(error) }
  } finally {
    disposeObservation(observation)
  }
}

/** Index the persistence service's snapshots by session id, or an empty map. */
async function revisionIndex(ctx, signal) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.list !== 'function') return undefined
  try {
    const snapshots = await persistence.list(signal === undefined ? undefined : { signal })
    const index = new Map()
    for (const snapshot of snapshots) index.set(snapshot.header.id, snapshot.revision)
    return index
  } catch {
    return undefined
  }
}

/**
 * Accurate sweep. A session whose log revision is unchanged since the previous
 * sweep is served from the per-session cache; everything else is observed one at
 * a time, and every lease is released immediately.
 *
 * @param ctx - context carrying `sessionQuery` and optionally `sessionPersistence`.
 * @param cache - per-session memo keyed by session id.
 * @param refresh - discard the memo and re-read every log.
 * @param signal - cancellation for the whole sweep.
 * @returns per-session rows plus reuse counters.
 */
async function sweep(ctx, cache, refresh, signal) {
  if (refresh) cache.clear()
  const index = await revisionIndex(ctx, signal)
  const records = await ctx.sessionQuery.listSessions(signal)
  const rows = []
  let reused = 0
  let recomputed = 0
  const present = new Set()

  for (const record of records) {
    if (signal?.aborted === true) break
    const header = record.header
    present.add(header.id)
    const revision = index?.get(header.id)
    const cached = cache.get(header.id)

    // An unchanged revision means an unchanged log, so the derived row stands.
    // A session the persistence service does not know (live, not yet durable)
    // has no revision and is always re-read.
    if (revision !== undefined && cached !== undefined && cached.revision === revision) {
      rows.push({ header, ...cached.row })
      reused += 1
      continue
    }

    const derived = await observeRow(ctx, header, signal)
    const row = {
      isSeeded: header.isSeeded === true,
      inheritedEventCount: 0,
      reported: undefined,
      own: undefined,
      byRoute: [],
      ...derived,
    }
    // A failed read is never memoized: a finished session's log never moves, so
    // caching its failure would drop that session from every later sweep until
    // the process restarts. Retrying it is the only way it can recover.
    if (row.own !== undefined) cache.set(header.id, { revision, row })
    rows.push({ header, ...row })
    recomputed += 1
  }

  // The memo is bounded by the corpus, not by every session the process has ever
  // seen: entries for sessions that are gone would otherwise accumulate forever.
  if (cache.size > present.size) {
    for (const id of [...cache.keys()]) if (!present.has(id)) cache.delete(id)
  }

  return { rows, reused, recomputed }
}

/**
 * Fast sweep: the zero-I/O listing read of the durable projection cache. Serves
 * the same numbers the session list shows, without reading a single log, but it
 * cannot separate a session's own usage from its inherited prefix nor attribute
 * usage to a route.
 *
 * @param ctx - context carrying `sessionQuery` and `sessionProjectionCache`.
 * @param signal - cancellation for the listing.
 * @returns per-session rows whose `own` is unavailable.
 */
async function sweepFast(ctx, signal) {
  const projectionCache = ctx.get('sessionProjectionCache')
  const records = await ctx.sessionQuery.listSessions(signal)
  const rows = records.map((record) => {
    let reported
    try {
      reported = bucketsFromWire(projectionCache?.cachedSnapshot(record.header, ['tokenUsage'])?.values?.tokenUsage)
    } catch {
      reported = undefined
    }
    return {
      header: record.header,
      isSeeded: record.header.isSeeded === true,
      inheritedEventCount: 0,
      reported,
      own: undefined,
      byRoute: [],
    }
  })
  return { rows, reused: 0, recomputed: rows.length }
}

/**
 * Fold per-session rows into per-project rows, a per-route table, and the corpus
 * totals. Route attribution exists only on the accurate path, so `byRoute` is
 * `null` when `deduped` is false.
 *
 * @param rows - per-session rows from a sweep.
 * @param deduped - whether `own` figures are available.
 * @returns the aggregate payload body.
 */
export function aggregate(rows, deduped) {
  const byProject = new Map()
  const byRoute = new Map()
  const totals = { own: deduped ? zeroBuckets() : null, reported: zeroBuckets() }
  let sessionCount = 0
  let forkCount = 0
  let subagentCount = 0
  let foldMismatches = 0
  const sessions = []

  for (const row of rows) {
    const header = row.header
    const cwd = typeof header.cwd === 'string' ? header.cwd : ''
    let project = byProject.get(cwd)
    if (project === undefined) {
      project = {
        cwd: cwd === '' ? null : cwd,
        name: projectName(cwd),
        sessions: 0,
        forks: 0,
        subagentSessions: 0,
        own: deduped ? zeroBuckets() : null,
        reported: zeroBuckets(),
      }
      byProject.set(cwd, project)
    }
    project.sessions += 1
    sessionCount += 1
    if (row.isSeeded === true) {
      project.forks += 1
      forkCount += 1
    }
    if (header.origin === 'subagent') {
      project.subagentSessions += 1
      subagentCount += 1
    }

    if (row.reported !== undefined) {
      project.reported = addBuckets(project.reported, row.reported)
      totals.reported = addBuckets(totals.reported, row.reported)
    }
    if (deduped && row.own !== undefined) {
      project.own = addBuckets(project.own, row.own)
      totals.own = addBuckets(totals.own, row.own)
    }
    if (row.foldMismatch === true) foldMismatches += 1

    for (const entry of row.byRoute ?? []) {
      const buckets = byRoute.get(entry.route) ?? zeroBuckets()
      byRoute.set(entry.route, addBuckets(buckets, entry))
    }

    sessions.push({
      id: header.id,
      cwd: cwd === '' ? null : cwd,
      name: project.name,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
      parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
      origin: header.origin === 'subagent' ? 'subagent' : 'user',
      isSeeded: row.isSeeded === true,
      inheritedEventCount: row.inheritedEventCount ?? 0,
      reported: row.reported ?? null,
      own: row.own ?? null,
      byRoute: deduped ? (row.byRoute ?? []) : null,
      problem: row.problem ?? null,
    })
  }

  const projects = [...byProject.values()]
    .map((project) => {
      const own = project.own
      const reported = project.reported
      return {
        cwd: project.cwd,
        name: project.name,
        sessions: project.sessions,
        forks: project.forks,
        subagentSessions: project.subagentSessions,
        own,
        reported,
        ownTotalTokens: own === null ? null : bucketTotal(own),
        reportedTotalTokens: bucketTotal(reported),
        overlapTokens: own === null ? null : bucketTotal(reported) - bucketTotal(own),
      }
    })
    .sort((left, right) => {
      const leftKey = left.ownTotalTokens ?? left.reportedTotalTokens
      const rightKey = right.ownTotalTokens ?? right.reportedTotalTokens
      return rightKey - leftKey || left.name.localeCompare(right.name)
    })

  const routes = [...byRoute.entries()]
    .map(([route, buckets]) => ({ route, ...buckets, totalTokens: bucketTotal(buckets) }))
    .sort((left, right) => right.totalTokens - left.totalTokens || left.route.localeCompare(right.route))

  sessions.sort((left, right) => (right.own === null ? -1 : bucketTotal(right.own)) - (left.own === null ? -1 : bucketTotal(left.own))
    || (right.createdAt ?? 0) - (left.createdAt ?? 0))

  return {
    projects,
    routes: deduped ? routes : null,
    sessions,
    totals: {
      own: totals.own,
      reported: totals.reported,
      ownTotalTokens: totals.own === null ? null : bucketTotal(totals.own),
      reportedTotalTokens: bucketTotal(totals.reported),
      overlapTokens: totals.own === null ? null : bucketTotal(totals.reported) - bucketTotal(totals.own),
    },
    sessionCount,
    projectCount: projects.length,
    forkCount,
    subagentCount,
    foldMismatches,
  }
}

/**
 * Run one sweep and assemble the payload the route serves.
 *
 * Exported so the cache behaviour (which sessions are re-read) and the lease
 * discipline can be driven by a fake context in tests: an observation that is
 * never disposed pins a whole parsed session log in the query service's cache.
 *
 * @param ctx - context carrying `sessionQuery`, and optionally `sessionPersistence`
 *   and `sessionProjectionCache`.
 * @param cache - per-session memo keyed by session id, owned by the caller.
 * @param mode - `accurate` reads logs; `fast` reads the durable projection cache.
 * @param refresh - discard the memo and re-read every log.
 * @param signal - cancellation for the whole sweep.
 * @returns the payload body.
 */
export async function computeLedger(ctx, cache, mode, refresh, signal) {
  const startedAt = Date.now()
  const swept = mode === 'fast' ? await sweepFast(ctx, signal) : await sweep(ctx, cache, refresh, signal)
  const deduped = mode !== 'fast'
  const aggregated = aggregate(swept.rows, deduped)
  const problems = swept.rows
    .filter((row) => row.problem !== undefined)
    .map((row) => ({ sessionId: row.header.id, problem: row.problem }))

  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    mode,
    deduped,
    generatedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    sessionsReused: swept.reused,
    sessionsRead: swept.recomputed,
    problems,
    source: mode === 'fast'
      ? 'ctx.sessionProjectionCache.cachedSnapshot (durable rows, no log read)'
      : 'ctx.sessionQuery.observeSession (own-events fold, per-session revision cache)',
    ...aggregated,
  }
}

/**
 * The request-handling layer around `computeLedger`: one shared per-session memo,
 * one in-flight sweep per mode, and a throttle on the forced full re-read.
 *
 * A forced sweep costs a full corpus read, so a caller that hammers the refresh
 * parameter — a stuck button, a second panel, another local process — cannot make
 * the host re-read every log over and over. A throttled request is still served
 * from the memo and says so in its payload.
 *
 * @param ctx - context carrying the session corpus.
 * @param options - `refreshCooldownMs` and an injectable `now` for tests.
 * @returns the runner, exposing `run(mode, refresh, signal)` and its memo.
 */
export function createLedgerRunner(ctx, options = {}) {
  const cache = new Map()
  const cooldownMs = options.refreshCooldownMs ?? 5_000
  const now = options.now ?? (() => Date.now())
  let inflight = null
  let lastForcedAt = Number.NEGATIVE_INFINITY

  return {
    cache,
    run(mode, refresh, signal) {
      if (inflight !== null && inflight.mode === mode) return inflight.promise

      let forced = refresh === true
      let throttled = false
      if (forced && now() - lastForcedAt < cooldownMs) {
        forced = false
        throttled = true
      }
      if (forced) lastForcedAt = now()

      const promise = computeLedger(ctx, cache, mode, forced, signal)
        .then((payload) => (throttled ? { ...payload, refreshThrottled: true } : payload))
        .finally(() => {
          inflight = null
        })
      inflight = { mode, promise }
      return promise
    },
  }
}

/**
 * Register the ledger's summary route.
 *
 * @param ctx - context carrying the web server and the session corpus.
 */
export function apply(ctx) {
  const runner = createLedgerRunner(ctx)

  const ledger = (mode, refresh, signal) => runner.run(mode, refresh, signal)

  const respond = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  const handler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const url = new URL(req.url ?? SUMMARY_PATH, 'http://127.0.0.1')
    const mode = url.searchParams.get('mode') === 'fast' ? 'fast' : 'accurate'
    const refresh = url.searchParams.get('refresh') === '1'
    ledger(mode, refresh, undefined).then(
      (payload) => respond(res, 200, payload),
      (error) => respond(res, 500, { ok: false, error: errorText(error), mode }),
    )
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: SUMMARY_PATH, handler }),
    'token-ledger: summary route',
  )
  ctx.logger?.info?.('token-ledger: serving %s', SUMMARY_PATH)
}
