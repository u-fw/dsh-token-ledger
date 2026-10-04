/**
 * Guard against publishing identifying detail.
 *
 * Two layers:
 *
 * 1. **Generic rules** that always run — a home-directory path anywhere, an
 *    email address, an API-key shape, a raw session id. These catch the mistakes
 *    anyone makes.
 * 2. **A local denylist** in `.leak-denylist` (gitignored, one term per line,
 *    `#` starts a comment) holding the terms that are private to *your* machine:
 *    provider aliases, model ids, project names, hostnames. The repository ships
 *    no such terms and never will — that is the point of keeping the list out.
 *
 * Usage: `node tools/lint-leaks.mjs [--quiet]`
 * Exits 1 when anything matched.
 *
 * @module dsh-token-ledger/tools/lint-leaks
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const quiet = process.argv.includes('--quiet')

/** Directories never scanned. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh-scratch', 'coverage'])

/**
 * Files never scanned: the denylist itself and its template necessarily name the
 * private terms, so scanning them would only ever produce self-matches.
 */
const SKIP_FILES = new Set(['.leak-denylist', '.leak-denylist.example'])

/** Generic rules: label, pattern, and whether a match is expected in test fixtures. */
const GENERIC_RULES = [
  // A user home directory, on any platform, in any quoting style.
  { label: 'home directory path', pattern: /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`),]+|\/(?:home|Users)\/[A-Za-z][^/\s"'`),]*)/g },
  { label: 'email address', pattern: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { label: 'API key shape', pattern: /\b(?:sk|ak|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g },
  { label: 'session id', pattern: /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g },
  { label: 'bare UUID', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g },
]

/** Read the optional local denylist. */
function readDenylist() {
  const file = path.join(root, '.leak-denylist')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** Every tracked file, skipping the ignored directories. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

const denylist = readDenylist()
const files = walk(root)
const findings = []

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')

  for (const rule of GENERIC_RULES) {
    lines.forEach((line, index) => {
      const matches = line.match(rule.pattern)
      if (matches === null) return
      findings.push({ rel, line: index + 1, label: rule.label, samples: [...new Set(matches)] })
    })
  }

  for (const term of denylist) {
    // Case-insensitive substring match, so a renamed casing cannot slip through.
    const needle = term.toLowerCase()
    lines.forEach((line, index) => {
      if (!line.toLowerCase().includes(needle)) return
      findings.push({ rel, line: index + 1, label: `denylist: ${term}`, samples: [term] })
    })
  }
}

if (findings.length === 0) {
  if (!quiet) {
    console.log(`✓ no identifying detail found in ${files.length} files`)
    if (denylist.length === 0) {
      console.log('  note: .leak-denylist is absent or empty, so only the generic rules ran.')
      console.log('  copy .leak-denylist.example to .leak-denylist and add your own private terms')
      console.log('  (provider aliases, model ids, project names) for a meaningful check.')
    } else {
      console.log(`  checked ${denylist.length} local denylist term(s)`)
    }
  }
  process.exit(0)
}

console.log(`✖ ${findings.length} suspect line(s) in ${new Set(findings.map((f) => f.rel)).size} file(s):\n`)
for (const finding of findings) {
  console.log(`  ${finding.rel}:${finding.line}  [${finding.label}]  ${finding.samples.join(' | ').slice(0, 160)}`)
}
console.log('\nReview each one: either replace it with a neutral placeholder, or — when the term is')
console.log('genuinely yours and must stay (a license holder, a repository URL) — leave it deliberately.')
process.exit(1)
