// tools/apk/line.mjs — the R2 namespace, in ONE place.
//
// 2026-10-08 统一：两条产品线并成一条（旧 apk 线退役），R2 路径**不带 re 后缀**：
//   · apk/latest.json        — in-app APK updater pointer（客户端更新检查读它）
//   · apk/stronghold-v*.apk  — APK 对象
//   · site/manifest.json     — production content pointer（发布控制器写、设备读）
//   · site/servers.json      — signed server list（Ed25519）
//   · site/verified.json     — subtract-only advisor snapshot
//   · assets/                — browser CDN tree
//   · apk-test/              — test channel
//
// 历史：合并前两条线共用一个桶（stronghold-assets），共享指针一律加 `-re` 后缀，免得一条线的发布
// 改写另一条的指针（line.test.mjs 的守卫就是钉这件事）。旧线退役后后缀去掉，`-re` 的那些对象是
// 过渡期遗留、由 R2 清理任务回收。
//
// 本文件仍是唯一真源：工具必须从这里取名字，不要自己拼字符串——命名空间要可 grep、可一处修改。
export const CDN = 'https://weishucdn.jiangjiangze.icu';
/** Kept as a named constant (now empty): 合并后所有共享指针都不再带后缀。 */
export const SUFFIX = '';

/** Directory (and CDN prefix) the browser asset tree lives under. */
export const ASSETS_DIR = `assets${SUFFIX}`;
export const ASSETS_BASE = `${CDN}/${ASSETS_DIR}/`;

/** Signed server list + the subtract-only advisor snapshot. */
export const SERVERS_KEY = `site/servers${SUFFIX}.json`;
export const SERVERS_URL = `${CDN}/${SERVERS_KEY}`;
export const VERIFIED_KEY = `site/verified${SUFFIX}.json`;
export const VERIFIED_URL = `${CDN}/${VERIFIED_KEY}`;

/** Production content manifest pointer (the release controller writes it, the device updater reads it). */
export const MANIFEST_KEY = `site/manifest${SUFFIX}.json`;
export const MANIFEST_URL = `${CDN}/${MANIFEST_KEY}`;

/** APK objects + the in-app updater pointer (apk/stronghold-v0.2.1.apk). */
export const APK_NAME_PREFIX = '';
export const APK_KEY_PREFIX = `apk/${APK_NAME_PREFIX}`;
export const APK_LATEST_KEY = `apk/latest${SUFFIX}.json`;
export const APK_LATEST_URL = `${CDN}/${APK_LATEST_KEY}`;

/** Test channel (forensics + acceptance release). */
export const TEST_MANIFEST_KEY = `site/manifest-test${SUFFIX}.json`;
export const TEST_LAST_ID_KEY = `site/last-tested${SUFFIX}.json`;
export const TEST_SLIM_PREFIX = `apk-test${SUFFIX}/`;

/** R2 bucket every key above lives in (kept here so a tool never builds the string by hand). */
export const BUCKET = 'stronghold-assets';
export const r2 = (key) => `r2:${BUCKET}/${key}`;
