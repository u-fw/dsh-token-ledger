# Contributing

The maintainer- and contributor-facing companion to [README.md](README.md) / [README.zh.md](README.zh.md). It covers the two things a *user* of the plugin does not need: how a code change reaches a running DSH, and how to keep identifying detail out of the repository. What the tests are and how to run them is documented once, in the README's test section.

## Development loop

The two halves reload differently, and that difference is worth internalising before the first edit:

| What changed | How it takes effect |
|---|---|
| `lib/client.js` (client half) | **a page refresh is enough**. client-modules re-reads the file, hands out a new rev, and the browser reloads that bundle |
| `lib/index.js` (host half) | **DSH must be restarted**. Node caches ESM modules by URL, so reinstalling or reloading never re-evaluates a module at the same path |

DSH's HMR is itself capable of hot-reloading host modules (it clears Node's internal `loadCache` and re-imports), but **a profile whose `hmr` config is `root: []`** watches no module files at all, only configuration such as `cordis.patch.yml` / `package.json`. Such a profile therefore applies configuration changes immediately, and code changes not at all.

So the habitual loop is: client change → refresh; host change → restart. Disabling and re-enabling the plugin in **Settings → Plugins** is *not* a substitute for a restart — it re-runs `apply` on the already-loaded module generation.

The corpus-dependent tests (projection parity, client/host agreement) need a real session corpus, so they skip on CI and only run on a machine that has one. That is deliberate: they are the strongest checks available, and they cannot be made hermetic.

## Keeping identifying detail out of the repository

The repository ships a `npm run lint:leaks` guard that scans every tracked file with two layers of rules:

- **Generic rules** that apply to any repository: home-directory paths, email addresses, API-key shapes, session ids and UUIDs.
- **A local denylist** in `.leak-denylist`, which is **gitignored**: your own provider aliases, model ids, project names, internal hostnames. Only the template `.leak-denylist.example` is committed.

CI therefore runs the generic layer only — a runner has no access to your local denylist. Run `npm run lint:leaks` locally, where the denylist is present, before pushing anything that touches prose, examples, or fixtures.

Two habits that keep it effective:

- **Fixtures and sample output use neutral placeholders** (`provider-a/model-x`, `C:/work/alpha`, round figures). A real name that reaches a test fixture is as public as one in the README.
- **Aggregate figures are rounded to obviously-synthetic values** rather than pasted from a real corpus. A real total plus a real route name fingerprints an installation even without a username.

## Commit style

One-line imperative subject, blank line, then a body explaining what changed and why; the initial commit on `main` is the reference for the expected level of detail.

While the repository is young enough that nobody has forked it, the maintainer has amended the initial commit and force-pushed, to keep the published history to a single clean commit. Stop doing that as soon as there are forks or external contributions: rewriting published history breaks anyone who has fetched.
