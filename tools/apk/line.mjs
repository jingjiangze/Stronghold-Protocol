// tools/apk/line.mjs — the re-apk line's R2 namespace, in ONE place.
//
// The apk line and the re-apk line are independent products that share one R2 bucket
// (stronghold-assets). Every pointer either line WRITES must be namespaced, or one line's publish
// silently rewrites the other's:
//   · apk/latest.json      — the in-app APK updater pointer (a re-apk device would be offered a
//                            differently-signed APK it cannot install, and vice versa)
//   · site/manifest.json   — the production content pointer (promote.yml owns it); a re-apk
//                            device reading it would fetch content slims built from the apk line's
//                            tree, i.e. a different product
//   · assets/              — the browser CDN tree (the re line ships WebP, the apk line PNG)
//   · site/servers.json    — the signed server list both lines read
//
// The apk branch's copies of these tools keep the un-suffixed names. This file exists only on the
// re-apk line; tools must import the names from here instead of typing them, so the namespace is
// greppable and a future change is one line.
export const LINE = 're';
export const SUFFIX = '-re';
export const CDN = 'https://weishucdn.jiangjiangze.icu';

/** Directory (and CDN prefix) the browser asset tree lives under. */
export const ASSETS_DIR = `assets${SUFFIX}`;
export const ASSETS_BASE = `${CDN}/${ASSETS_DIR}/`;

/** Signed server list + the subtract-only advisor snapshot. */
export const SERVERS_KEY = `site/servers${SUFFIX}.json`;
export const SERVERS_URL = `${CDN}/${SERVERS_KEY}`;
export const VERIFIED_KEY = `site/verified${SUFFIX}.json`;
export const VERIFIED_URL = `${CDN}/${VERIFIED_KEY}`;

/** Production content manifest pointer (promote writes it, the device updater reads it). */
export const MANIFEST_KEY = `site/manifest${SUFFIX}.json`;
export const MANIFEST_URL = `${CDN}/${MANIFEST_KEY}`;

/** APK objects + the in-app updater pointer (apk/re-stronghold-v0.1.4.apk). */
export const APK_NAME_PREFIX = `${LINE}-`;
export const APK_KEY_PREFIX = `apk/${APK_NAME_PREFIX}`;
export const APK_LATEST_KEY = `apk/latest${SUFFIX}.json`;
export const APK_LATEST_URL = `${CDN}/${APK_LATEST_KEY}`;

/** Test channel (forensics + acceptance release) — namespaced the same way. */
export const TEST_MANIFEST_KEY = `site/manifest-test${SUFFIX}.json`;
export const TEST_LAST_ID_KEY = `site/last-tested${SUFFIX}.json`;
export const TEST_SLIM_PREFIX = `apk-test${SUFFIX}/`;

/** R2 bucket every key above lives in (kept here so a tool never builds the string by hand). */
export const BUCKET = 'stronghold-assets';
export const r2 = (key) => `r2:${BUCKET}/${key}`;
