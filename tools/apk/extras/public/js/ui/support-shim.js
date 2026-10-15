// js/ui/support-shim.js — `shared/support.js` 的本 APK 落地版（overlay 层，零上游冲突）
//
// WHY THIS FILE EXISTS (2026-10-15 合并审计, Forge 0.18.6 → 本 APK)
// ----------------------------------------------------------------------------
// Forge 的 `js/ui/supportModel.js` 第 9 行：
//     import { checkSupport, SUPPORT_LIMITS } from '../../../shared/support.js';
// 而本 APK 的 webroot **没有 `shared/support.js`**（`webroot/shared/` 15 个 .js 全列无此文件）。
// ES module 在**链接期**就会抛 `does not provide an export named ...`——那不是运行期报错，
// 是**整个 supportModel.js / supportSync.js 加载失败**。所以必须补这一个文件。
//
// 为什么不直接铺一份 `shared/support.js` 到 overlay：overlay 是「同名整份替换」语义，而 `shared/`
// 目前不在 overlay 树里，铺进去会让**所有** `shared/*` 的相对解析发生层级变化；更要紧的是上游
// `shared/support.js` 有 12 个导出、其中 10 个（normalizeSupportConfig / supportPriceOf / supportPrices /
// supportTiers / supportCapacity / supportPicker / isSupportChess / supportTierOf / isSupportTier /
// isSupportEntries）在本 APK 一个消费者都没有 —— 照抄 221 行只会得到一份没人调用的死代码面。
//
// 所以这里只复刻**本 APK 真实用到的最小集合**（见下方 USED BY），逐字保留 Forge 的判定语义
// （同一个函数、同一条 fail-closed 规则），删掉未消费的导出与对 Forge `i18n.js` 的依赖。
//
// USED BY (全部引用点已逐个核实行号):
//   · `SUPPORT_LIMITS` — supportModel.js:50 (`.idLen`)、:53 (`.entries`)
//   · `checkSupport`   — supportModel.js:133 `return checkSupport(entries, cfg, getChess);`
//   Forge 权威源：`shared/support.js`（221 行），本文件与它的差异只有「删了未消费导出」+「去掉 t() 依赖」。
//
// 契约保持不变：**没有 fallback**。池子外的干员、重复的 id、超过该阶级名额 —— 一律整条消息拒绝
// （ERR.BAD_TARGET），因为 fallback 会把一个被禁用的干员静默变成发下去的干员。

/** `room.support` 选择的结构上限（与 Forge `shared/support.js:30` 逐字相同）。 */
export const SUPPORT_LIMITS = Object.freeze({ entries: 16, idLen: 64 });

const isTier = (t) => Number.isInteger(t) && t >= 1 && t <= 6;
const isChessId = (v) => typeof v === 'string' && v.length > 0 && v.length <= SUPPORT_LIMITS.idLen && /^[A-Za-z0-9_\-.:]+$/.test(v);

/**
 * 服务端卡池是否允许这个干员作为助战。对「不是普通可见非精英的基础棋」一律 fail closed：
 * 卡池必须在**它自己的阶级**下列出这个 id（一个 6 阶 id 列在 "5" 下面是不允许的），
 * 所以一份写错的配置是「禁用」而不是「提升」。
 * @param {any} cfg normalizeSupportConfig(…) 的输出
 * @param {unknown} id 基础棋 id
 * @param {(id: string) => any} getChess 棋记录查表（由调用方注入）
 */
function isSupportChess(cfg, id, getChess) {
  if (!cfg || !cfg.enabled || typeof id !== 'string' || !id) return false;
  const rec = typeof getChess === 'function' ? getChess(id) : null;
  if (!rec || rec.isGolden || rec.visible === false || rec.isHidden || rec.isDiy) return false;
  if (!Number.isInteger(rec.tier)) return false;
  const list = cfg.pool[rec.tier];
  return Array.isArray(list) && list.includes(id);
}

/** 这个干员计入哪个阶级（卡池允许时是它自己的阶级），不允许时是 null。 */
function supportTierOf(cfg, id, getChess) {
  if (!isSupportChess(cfg, id, getChess)) return null;
  const rec = getChess(id);
  return rec && Number.isInteger(rec.tier) ? rec.tier : null;
}

/** 一名玩家能带几个该阶级的助战（阶级关闭或助战整体关闭时为 0）。 */
function supportSlotsFor(cfg, tier) {
  if (!cfg || !cfg.enabled || !isTier(tier)) return 0;
  return cfg.slots[tier] || 0;
}

/** 原始 `room.support.entries` 的结构检查：id 数组、有上限、去重后仍不超限。 */
function isSupportEntries(v) {
  if (!Array.isArray(v) || v.length > SUPPORT_LIMITS.entries) return false;
  const seen = new Set();
  for (const id of v) {
    if (!isChessId(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * 对服务端卡池做语义检查 + 归一化。严格，且**刻意没有 fallback**：点名了池外干员、重复、
 * 或超过该阶级名额的选择，**整条消息拒绝**（ERR.BAD_TARGET）。空选择永远可接受，意为「不带助战」
 * —— 包括助战整体关闭时，那是关闭的服务器唯一接受的选择。
 *
 * @param {unknown} entries `room.support.entries`
 * @param {any} cfg normalizeSupportConfig(…) 的输出
 * @param {(id: string) => any} getChess 棋记录查表（由调用方注入）
 * @returns {{ ok: true, entries: string[], byTier: Record<number, string[]> } | { error: 'BAD_MSG'|'BAD_TARGET', detail: string }}
 */
export function checkSupport(entries, cfg, getChess) {
  if (!isSupportEntries(entries)) return { error: 'BAD_MSG', detail: 'bad support entries' };
  if (!cfg || !cfg.enabled) {
    return entries.length === 0
      ? { ok: true, entries: [], byTier: {} }
      : { error: 'BAD_TARGET', detail: 'support is disabled on this server' };
  }
  /** @type {Record<number, string[]>} */
  const byTier = {};
  const out = [];
  for (const id of entries) {
    const tier = supportTierOf(cfg, id, getChess);
    if (tier === null) return { error: 'BAD_TARGET', detail: `support ${id} is not in the server pool` };
    const list = (byTier[tier] ||= []);
    const max = supportSlotsFor(cfg, tier);
    if (list.length >= max) return { error: 'BAD_TARGET', detail: `at most ${max} tier-${tier} support(s)` };
    list.push(id);
    out.push(id);
  }
  return { ok: true, entries: out, byTier };
}
