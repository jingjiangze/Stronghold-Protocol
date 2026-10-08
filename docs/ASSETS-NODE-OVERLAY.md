# `/assets/**` policy as a hot-updatable Node overlay (P1, shadow mode)

Status: **implemented, DEFAULT OFF** (2026-10-08). Implements P1 of
`审计-Java逻辑下沉到热更层-2026-10-08.md` §3/§7: the asset proxy / cache / verification **policy**
moves out of Java (`ArtCdn.java` + the `MainActivity` interceptor) into `server/overlay/sp-assets.mjs`,
which rides the L1 content slim and is loaded by `extras/server/overlay-loader.mjs` after
`startServer()`. **No Java file and no upstream file is edited** — this is an additive overlay.

The live path today is still the Java interceptor. The overlay exists so that a change to the
namespace rule, the slot priority or the placeholder **never needs a new APK again**.

| | |
|---|---|
| Implementation | `tools/apk/overlay/sp-assets.mjs` |
| Tests | `tools/apk/overlay-sp-assets.test.mjs` (`node --test tools/apk/overlay-sp-assets.test.mjs`) |
| Overlay contract | `tools/apk/overlay/README.md` + `tools/apk/extras/server/overlay-loader.mjs` |

## 1. The flag (default OFF)

The flag is read by **the overlay itself**, not by `overlay-loader.mjs`: the loader is baked into the
APK, so a flag read there could not be flipped by a content hot-update.

Precedence:

1. env `SP_ASSETS_OVERLAY` — `1`/`true`/`on`/`yes` = on, anything else = off (wins outright);
2. else the first readable JSON config with `{ "enabled": true }` among:
   - `$SP_ASSETS_CONFIG`,
   - `<overlayDir>/sp-assets.json` (next to the module; dev only),
   - `<webroot>/data/sp-assets.json` (the hot-updatable one — a content slim can ship it).

Nothing found → **off**. With the flag off, `install()` attaches nothing, the Java interceptor keeps
answering `/assets/**`, and behaviour is byte-identical to today (pinned by a test).

Optional env overrides: `SP_ASSETS_WEBROOT`, `SP_ASSETS_ART_ROOT` (defaults: webroot =
`dirname(upstreamDir)`, art root = `dirname(webroot)/art`, matching the Java `filesDir/art` tree).

## 2. Decision order

Served only for the **local Node origin** (the page's own origin). Everything else is forwarded to the
upstream handler unchanged.

| # | Layer | Source | Verified? |
|---|---|---|---|
| 1 | `local` | `<webroot>/assets/<rel>` (and `<webroot>/public/assets/<rel>`) | no |
| 2 | `pack` | `<artRoot>/packs/<id>/assets/<rel>`, id ascending, `.tmp` skipped (ArtStore's signed packs) | no (sha256 was checked at install) |
| 3 | `embedded` | extra configured roots (on device the APK tree is already materialised into layer 1) | no |
| 4 | `cache` | `<artRoot>/cache/<manifest hash>/assets/<rel>` | no |
| 5 | `cdn` | gated fetch of `<cdnBase><rel>` → written to layer 4, then served from it | **yes, at write time only** |
| 6 | `placeholder` | 1×1 PNG for `image/*`, empty body otherwise, `no-store` | — |

`cdnBase` mirrors `Line.ASSETS_CDN_PREFIX` (`https://weishucdn.jiangjiangze.icu/assets-re/`); a test
pins it against `tools/apk/line.mjs` so the runtime literal cannot drift.

## 3. Cache namespace + adoption (the "热补丁后强制全量重校验" fix)

The namespace is the manifest hash (`data/assets.json` top-level `hash`, sanitised to
`[A-Za-z0-9_-]{1,64}`, else `v0`). That hash is re-emitted from the referenced bytes on **every**
content release, so it changes while the referenced paths and bytes stay identical. Therefore, when
the hash changes:

1. if the new namespace directory exists and is **populated** → nothing (its bytes were fetched under
   this hash; never merged into);
2. if it exists and is **empty** → it is a failed fetch's leftover and is removed;
3. the most recently used non-empty valid namespace directory is **renamed** onto the new one — same
   inode, same relative paths, **no re-download**. Only when there is no predecessor are the bytes
   orphaned.

One adoption attempt per hash per process (same discipline as `MainActivity.adoptArtCacheNamespace`).

## 4. Verification policy (加速资源校验)

- **A hit is never verified** — embedded / local / cache bytes go out as-is. The ETag is cheap
  (`W/"<size hex>-<mtime hex>"`), never a content hash.
- **Verification happens only at write time, and streams**: sha256 is updated while the download is
  written (one pass, no second read of the file). If `expectedHashFor(path)` supplies a hash it is
  enforced; otherwise the streamed hash is recorded in the status surface only (upstream
  `data/assets.json` carries no per-file sha256 — this layer is explicitly the lower-trust best-effort
  cache; signed bytes only ever come through `ArtStore` packs).

## 5. LRU prune + concurrency

- **Prune** (size cap `maxCacheBytes`, default 512 MiB, attempted every 32 writes and on demand):
  foreign namespaces are evicted before the active one; inside a namespace the least recently used
  file goes first (last-access map, falling back to mtime). The cap can therefore never delete the
  art the page is using while dead bytes from an older release still hold the space.
- **Pool**: page fetches get `maxParallel` slots (4); prefetches additionally need one of
  `maxPrefetchParallel` slots (2). A page request waits up to `pageWaitMs` (12 s), a prefetch only
  `prefetchWaitMs` (300 ms). When a slot frees, **a waiting page request is granted before any waiting
  prefetch**, so a cold-cache prefetch can never starve a live screen into a placeholder. Same-path
  concurrent requests are single-flighted.
- **Prefetch hints** (any of them marks a request as prefetch): the `X-SP-Prefetch` header
  (`art-prefetch.js` already sends it), `?sp_prefetch=1`, or the path prefix `/__sp/pf/assets/**`.

## 6. URL rules (hard)

Only `http`/`https`; the host must be in the allow-list (`weishucdn.jiangjiangze.icu`,
`jingjiangze.github.io`, `dl.jiangjiangze.icu` — mirror of `ArtCdn.ALLOWED_HOSTS`); localhost,
loopback, private, CGNAT, link-local, documentation, multicast, reserved and IPv6 ULA/link-local are
rejected **before** any request (dotted/octal/hex/single-integer IPv4 and `[::1]` included); a refused
target is **never contacted** (asserted in the tests); no redirects are followed (a 3xx fails); body
ceiling 64 MiB; overall fetch deadline 20 s.

## 7. Status surface

`GET /__sp/assets/status.json` (loopback/private peers only) reports per-layer hit counts
(`local`/`pack`/`embedded`/`cache`/`cdn`/`placeholder`), the cache namespace + size, in-flight count,
`failed`/`blocked`/`poolRejected`, `writes`, write-time `verify` counters, adoption and prune records,
and the pool state. This is the shadow A/B surface.

## 8. Parity expectations and what a device A/B should measure

Shadow mode = the Node overlay is enabled and the page requests the **local Node origin** directly
(bypassing the WebView interceptor), while the Java path keeps serving the WebView. Compare:

| Metric | Node overlay | Java equivalent |
|---|---|---|
| per-layer hit counts | `status.json` `hits.*` | `art-miss` / `art-adopt` / `art-cdn` diag lines + `__SP_ART.state()` |
| namespace + adoption | `status.json` `namespace`, `adopted[]` | `appendDiagLog("art-adopt", …)` |
| no refetch after a hot update | `hits.cdn` unchanged, `adopted` non-empty | `__SP_ART.state().done` not reset to 0 |
| prefetch vs page | `pool.waiting`, `poolRejected` | the blank-icon report (970/7969) should disappear |
| blocked targets | `blocked` counter + log line | `art-cdn blocked host` diag |

Known parity gaps to watch before flipping the Java policy off:

1. **Same-origin server assets** (`ServerConfig.resources.serveAssets`, layer ⑤ in Java) are **not**
   ported yet — the Node overlay has no server-config layer.
2. **gzip / ETag / 304**: the upstream static handler gzips and answers 304 with a strong ETag; the
   overlay answers `no-cache` + a weak size/mtime ETag and streams raw bytes (no gzip).
3. **Placeholder gating**: Java only placeholder-answers when `manifestArtVersion > 0`; the overlay
   answers whenever the bytes are genuinely missing.
4. **Server-page origin**: when the page comes from a real server, the interceptor (not local Node)
   serves `/assets/**`; the two paths must share one decision before the Java policy is deleted.

## 9. Risks of flipping it on

- A policy bug now affects the live page with no APK rollback: keep the flag off until the A/B
  counters agree over a real session, and keep the Java interceptor as the last line until P1 收口.
- Two independent cache writers (Java interceptor and Node overlay) share `filesDir/art/cache/**`;
  their adoption/prune must agree (they do — same namespace rule), but concurrent adoption while both
  are enabled could race. Prefer enabling the overlay only when the interceptor no longer serves
  `/assets/**`.
- First-frame / offline boot must not depend on the overlay: it is attached after `startServer()` and
  a throwing `install()` is logged and skipped, so the host still boots.
