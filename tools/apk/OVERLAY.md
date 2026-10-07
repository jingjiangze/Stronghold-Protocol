# Zero-conflict overlay — how this fork stays mergeable with upstream

**The rule: upstream game code is never edited in-tree.** Everything of ours lives in paths upstream does not
own, or in *new* files upstream never had. That is the whole trick — `git merge upstream/master` only conflicts
on files **both** sides changed, so a tree where our side touched none of theirs merges cleanly forever.

Verified in practice: `re-apk` went from 35 anchor patches to 0 and merged upstream 0.2.0 and 0.2.1 with zero
conflicts (834 files, +128955 −34984); this branch adds the combat worker pool the same way.

## Where a change goes

| What you want to change | Where it goes | Hot-updatable |
|---|---|---|
| Browser UI / client behaviour | `android/.../shell/extras/public/js/**` (DOM hooks, `__SP__`, `localStorage` mirrors) | yes (slim) |
| Server behaviour | `android/.../shell/extras/server/overlay/*.mjs` — `install(ctx)` wraps upstream at runtime | yes (slim) |
| Build, CI, packaging, tests of our own | `tools/**`, `.github/**` | no (repo) |
| Something genuinely belongs upstream | an upstream PR (community PRs are merged regularly) | — |

Nothing else. In particular: no edits under `server/`, `public/`, `shared/`, `data/`, `test/`, `docs/`.

## How the server overlay works

On device the shell materialises `assets/shell/extras/**` **into** the webroot, so
`extras/server/overlay/foo.mjs` runs from `<webroot>/server/overlay/foo.mjs` — next to upstream `server/`,
which is why overlay modules can use plain relative imports (`../match/Match.js`, `../sim/spec.js`).
`overlay-loader.mjs` imports every `server/overlay/*.mjs` after `startServer()` and calls

```js
export const overlayApi = 1;
export async function install(ctx) {} // ctx = { api, id, server, port, host, url, upstreamDir, log }
```

`ctx.server` is the object `startServer()` returned (lobby, network, registry, close). A broken or
version-mismatched overlay is logged and skipped, never fatal. `tools/apk/overlay-harness.mjs` reproduces the
materialised layout for tests.

## Two kinds of overlay change

1. **Additive (preferred).** New routes, new modules, hooks onto `ctx.server.lobby` — nothing upstream is
   referenced by name, so nothing can drift. Example: `room-presence.mjs`.
2. **Wrapper (when upstream behaviour must change).** Copy the upstream method into the overlay and replace it
   on the prototype at install time (`Match.prototype.startCombat = …`). This is the only place drift can
   appear, so it is guarded — see below.

## Guards (the rule is enforced, not trusted)

- **`tools/apk/check-upstream-pristine.mjs`** — CI `GATE D` in `mirror-master.yml`. Modified/deleted/renamed
  upstream files fail the sync; added files are listed and allowed.
- **`assertUpstreamShape()`** in the overlay — pins the upstream source lines each wrapper depends on. If
  upstream moves them, `install()` throws, the loader logs and skips the overlay, and the server boots on the
  inline path instead of running a stale copy. Silent drift is the one failure mode worth engineering against.
- **`GATE E`** — `node --test tools/apk/combat-pool-overlay.test.mjs` proves the overlay still installs and the
  pool still runs a real battle after every upstream move.
- **Workflows** — `mirror-master.yml` restores `.github/workflows/` to our side inside the merge commit:
  `GITHUB_TOKEN` may not push workflow changes, which is what failed the 2026-10-07 sync after a clean merge
  and green gates.

## Cost, stated plainly

A wrapper is a **copy** of upstream code. Upstream improving that method does not reach us automatically; the
shape assertion tells us to re-sync the copy (a named, actionable failure — not silence). Keep wrappers small,
keep them opt-in, and prefer additive overlays. If a wrapper ever grows into a rewrite of a whole subsystem,
that subsystem is a candidate for an upstream PR instead.
