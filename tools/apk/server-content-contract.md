# Server content contract (`stronghold-client.json`)

How a **server** tells a client what it wants (announcement, matchmaking parameters, feature flags)
without shipping an APK, and what it is **not** allowed to do.

Status: implemented on the `re-apk` line. Everything here is additive — a server that publishes no
file behaves exactly as before.

## 1. Where the client looks

Same origin as the page, in this order:

| # | Path | Notes |
|---|---|---|
| 1 | `/.well-known/stronghold-client.json` | The standard location. Works behind a reverse proxy / CDN that maps it. |
| 2 | `/stronghold-client.json` | **Works on a stock upstream server with zero changes** (see below). |

The second path exists because upstream's own static server **404s every dot-segment** before it
looks at the disk (`server/http/static.js`: `if (segments.some((s) => s.startsWith('.'))) { 404 }`).
So `/.well-known/…` alone would silently never be served on a plain upstream deployment. Dropping a
file at `public/stronghold-client.json` needs no code change anywhere; publishing it under
`.well-known/` is for deployments that front the server with nginx/Caddy/Cloudflare.

The client remembers which path answered last and asks that one first next time.

## 2. What a server may declare

```jsonc
{
  "schema": 1,                    // required by convention; a HIGHER value is rejected outright
  "serverId": "example",          // optional label; used as metadata, never as a cache key
  "version": 12,                  // integer; the client only accepts >= what it already has
  "ttl": 300,                     // seconds the client may reuse this before re-checking (max 86400)

  "announce": {                   // optional; shown on the in-app notice board
    "enabled": true,
    "title": "服务器公告",
    "body": "今晚开放新模式\n维护 22:00-23:00",
    "level": "info"               // info | warn | error  (anything else -> info)
  },

  "matchmaking": {                // optional; the client only renders UI / drives requests
    "enabled": true,
    "endpoint": "/api/match",     // MUST be a site-relative path -- an absolute URL drops the block
    "modes": ["NORMAL", "HARD"],
    "partySize": 4,
    "queueTimeoutSec": 60
  },

  "features": {                   // optional; unknown ids are ignored safely by the client
    "newModeA": { "enabled": true, "mode": "config" },
    "eventB":   { "enabled": true, "mode": "config", "startAt": 1760000000000, "endAt": 1760100000000 }
  },

  "featurePacks": [               // optional; references only -- there is deliberately NO url field
    { "id": "match-v2", "version": 3 }
  ],

  "resources": {                  // optional; default false
    "serveAssets": false          // true = this server also serves /assets/** from its own origin
  },

  "client": { "minShellApi": 1 }  // optional; a client older than this should ignore the document
}
```

Times (`startAt` / `endAt`) are epoch **milliseconds**; either may be omitted. A feature with a
window is enabled only inside it.

## 3. What a server may **not** do

This is enforced by what the client parses, not by a blocklist — there is no field for these, so
there is no way to express them:

| Not allowed | Why / where it is refused |
|---|---|
| Any JavaScript, `eval`, `new Function` | No field exists. The client never evaluates config content. |
| An absolute or third-party URL | `endpoint` must be site-relative; `//host/x` and `https://…` are rejected and the whole block is dropped. |
| A download URL for new client code | `featurePacks[]` carries `{id, version}` only. Code always comes through the existing Ed25519-signed update chain. |
| APK install / Android permissions / WebView policy | Nothing in the protocol reaches those code paths. |
| Signing keys, CDN trust roots | The config is **not** a trust root. It cannot add a host, a key, or an origin. |
| Arbitrary file paths | No path field exists; the only path is a site-relative API route. |
| Cross-server influence | The cache slot is keyed by the **origin** the user connected to, not by `serverId`, so one server cannot read or overwrite another's cached config. |

The client fetches the document from **exactly one place**: `scheme://host[:port]` of the page the
user is already on, plus the fixed paths in §1. A config can never cause a request to a third party.

## 4. Failure behaviour (the server is never a startup dependency)

| Situation | Result |
|---|---|
| No file at either path (404) | No config. The page runs exactly as it did before this feature. |
| Network down / timeout | The last good copy is used (per origin, on disk). |
| Malformed JSON | The document is discarded; the last good copy stays. |
| `schema` higher than the client knows | Discarded (semantics might differ — guessing is worse than not knowing). |
| `version` lower than the cached one | Discarded (a rolled-back server must not downgrade a device). |
| Body larger than 256 KB | Discarded. |
| Server switches | The previous server's config is dropped immediately; the new server's own last-good is loaded. |

## 5. Announcement without an APK

An announcement is the cheapest case of "server changed something": edit `announce` on the server,
bump `version`, and the client shows it. No APK, no content release, no app-store step.

The client reads the shell-validated snapshot (no extra request) and only falls back to reading the
legacy `/dl/config.json` when the shell has no announcement to offer. A changed announcement flips
the notice back to unread, keyed by the config version.

## 6. What needs an APK, and what does not

| Change | Needs a new APK? |
|---|---|
| Announcement text, levels, timing | No |
| Matchmaking on/off, modes, party size, timeout | No |
| Feature flags that switch on **existing** client code (`"mode": "config"`) | No |
| Numeric/rule parameters, event windows, API routes | No |
| Server serving its own `/assets/**` (`resources.serveAssets`) | No |
| **New client code** (`"mode": "pack"`) | Only the loader: the feature must ship as a **signed** feature pack through the existing update chain. A server can *request* it (by id/version) but cannot deliver it. |
| New Android permission / runtime / protocol-breaking change | Yes — and `minShellApi` is how a server states the floor. |

## 7. For server operators: minimal setup

```bash
# stock upstream server, no code change:
printf '%s' '{"schema":1,"serverId":"my-server","version":1,
  "announce":{"enabled":true,"body":"Welcome!"}}' > public/stronghold-client.json
```

Bump `version` whenever the content changes. That is the whole contract.

## 8. For client developers: where the code lives

| Concern | File |
|---|---|
| Parse + validate the document (pure, JVM-testable) | `ServerConfig.java` |
| Fetch / cache / ETag / TTL / version rule (pure + injected network) | `ServerConfigStore.java` |
| Process-level snapshot + refresh triggers (Android) | `ServerConfigHub.java` |
| Resource routing decision table (pure, JVM-testable) | `ResourceResolver.java` |
| Page-side read-only view (`window.__SP_SERVER_CONFIG`) | `tools/apk/extras/public/js/server-config.js` |
| Tests | `tools/apk/jvm/ServerConfigCheck.java`, `tools/apk/jvm/ResourceResolverCheck.java`, `tools/apk/server-config.test.mjs` |

Run the JVM checks with:

```bash
bash tools/apk/jvm/run-server-config-check.sh
```
