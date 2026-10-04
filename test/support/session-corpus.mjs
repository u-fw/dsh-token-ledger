/**
 * Read access to this machine's DSH session corpus, for the parity tests.
 *
 * These tests compare this package's token fold against the projections DSH
 * itself persisted, so they need real session logs. When no corpus is present
 * they report that and skip, rather than failing.
 *
 * Override the corpus location with `DSH_HOME` (defaults to `~/.dsh`).
 *
 * @module dsh-token-ledger/test/support/session-corpus
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** Root of the DSH home directory holding sessions and storages. */
export const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** Directory of persisted projection-cache records, one JSON file per session. */
export const PROJECTION_CACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')

/** Directory of per-project session log directories. */
export const SESSIONS_DIR = path.join(DSH_HOME, 'sessions')

/** Zstandard frame magic; a session log is a concatenation of independent frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Session ids are stored with and without a `session-` prefix; compare without it. */
export const bareId = (id) => id.replace(/^session-/u, '')

/**
 * Decode a session log fully. Each appended batch is its own zstd frame, so a
 * single-frame decode would silently return only the header.
 *
 * @param file - absolute path of a `session.v4.jsonl.zstd` file.
 * @returns the decoded bytes.
 */
export function decodeSessionLog(file) {
  const buffer = fs.readFileSync(file)
  const chunks = []
  let offset = 0
  while (offset < buffer.length) {
    const next = buffer.indexOf(ZSTD_MAGIC, offset + 1)
    const end = next === -1 ? buffer.length : next
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(offset, end)))
    } catch {
      // A torn final frame is expected while a session is being written.
    }
    offset = end
  }
  return Buffer.concat(chunks)
}

/**
 * Parse one session log into its header and events.
 *
 * @param file - absolute path of a `session.v4.jsonl.zstd` file.
 * @returns the session header (or `null`) and the decoded event list.
 */
export function readSessionLog(file) {
  const text = decodeSessionLog(file).toString('utf8')
  let header = null
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.type === 'session') {
      header = parsed
      continue
    }
    events.push(parsed.event ?? parsed)
  }
  return { header, events }
}

/**
 * Map every readable session id (without its `session-` prefix) to its log path.
 *
 * @returns the id → path index.
 */
export function indexSessionLogs() {
  const index = new Map()
  if (!fs.existsSync(SESSIONS_DIR)) return index
  for (const slug of fs.readdirSync(SESSIONS_DIR)) {
    const projectDir = path.join(SESSIONS_DIR, slug)
    if (!fs.statSync(projectDir).isDirectory()) continue
    for (const entry of fs.readdirSync(projectDir)) {
      const file = path.join(projectDir, entry, 'session.v4.jsonl.zstd')
      if (fs.existsSync(file)) index.set(bareId(entry), file)
    }
  }
  return index
}

/**
 * Load every persisted projection-cache record.
 *
 * @returns one `{ id, record }` per stored record.
 */
export function loadProjectionRecords() {
  if (!fs.existsSync(PROJECTION_CACHE_DIR)) return []
  const records = []
  for (const file of fs.readdirSync(PROJECTION_CACHE_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(PROJECTION_CACHE_DIR, file), 'utf8'))
      records.push({ id: bareId(file.slice(0, -5)), record: parsed.record ?? {} })
    } catch {
      continue
    }
  }
  return records
}

/** Whether a corpus is available for the parity tests. */
export const corpusAvailable = () =>
  fs.existsSync(SESSIONS_DIR) && fs.existsSync(PROJECTION_CACHE_DIR)
