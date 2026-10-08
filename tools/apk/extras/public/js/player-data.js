/* global window, document */ // browser globals: overlay scripts live in the tools tree (the ESLint node preset covers it), so the DOM globals are declared here
// player-data.js — 玩家数据 v1（本地真源 + 跨站共享 + 导出导入）。
//
// 数据只属于玩家，和 origin 无关。三层自愈后端：
//   1) App：window.spData（Java 桥，get/put 同步字符串）— filesDir/player-v1.json 是真源；
//   2) 网页：手写最小 IndexedDB 封装（库 'sp-player' → objectStore 'kv' → 键 'doc'）；
//   3) 兜底：localStorage 镜像 'sp.player.v1'（另一个浏览器回退 / 灾后恢复）。
// 任何一层失败都静默降级（例如无痕模式 / 私密浏览），调用方永不因本文件抛错而中断游戏。
// 本文件不做任何网络请求；导出/导入只在本文件内处理字符串，保存/分享 UI 由上层负责。
//
// 文档 v1（真源为单个 JSON 文本）：
//   { v:1, deviceId:"<random>", profile:{name,ts},
//     loadouts:{ [baseChessId]:{skill?:number, module?:string, ts} },  // skill = 索引，module = uniEquipId | 'none'
//     battles:[ {id,ts,serverId,roomCode,mode,result?,duration?,difficulty?,round?,status?,
//                hidden?,stats?,operators?,title?} ],   // append-only；id 天然去重（v4.10 起带战绩明细）
//     rooms:{ [code]:{serverId,firstSeen,lastSeen,count} },           // count = 见过的最大人类玩家数
//     servers:{ [id]:{name,firstSeen,lastSeen,battles} },
//     settings:{bgm,sfx,muted,damageNumbers,quality,fontScale,sidePad,ts} | null,  // blob 级 LWW（v4.6）
//     pendingMatch:{ts,difficulty,venueId} | null }  // v5.1 一次性匹配待办（跨 origin，落地钩子消费）
//
// 合并规则（导入旧档 / IndexedDB 载入与内存合并，工具单测见 tools/apk/player-merge.test.mjs）：
//   profile = 字段 LWW：比较 (ts, deviceId)，ts 大者胜；ts 相同 deviceId 字符串大者胜；
//   loadouts = 键级 LWW（同一比较）；battles = 按 id 并集（去重、ts 升序）；
//   settings = 整块 LWW：比较 (ts, deviceId)，缺 ts 视为 0（同一比较惯例）；
//   rooms / servers = 并集：firstSeen 取 min、lastSeen / count / battles 取 max，
//   serverId / name 取 lastSeen 新的一侧（平局保留本地）；deviceId 永远保留本机身份。
//
// 采集钩子（tools/apk/patches/settings-v3.4.json）：
//   js/main.js onRoomState → recordRoom；js/main.js m.result → recordResult；
//   js/net.js 昵称读写 → recordProfile；js/ui/loadoutSync.js → recordLoadout；
//   服务器由本文件初始化时自记（window.shell.currentServerId() 优先，location.host 兜底）。
//
// 写入节流 2s（flush() 可强制落盘）；页面隐藏 / 卸载时立即 flush。
//
// v3.7 种子：换服务器 = 新 origin，`sp.pref.loadout` 与 `sp.name` 都随 origin 重置——
// 代号会由 title.js 从玩家数据预填，干员配置却悄悄回默认。init() 的同步段（doc 就绪之后、异步
// IndexedDB 之前）用 doc 补齐这两个键。干员配置仍是「只补缺、绝不覆盖」；代号以 doc.profile.name
// 为真源对齐（`sp.name` + 时间戳镜像 `sp.name.ts`），仅当 doc 时间戳**严格大于**本地镜像时覆盖
// （doc 无 ts / ts 相等一律保留本地），避免用陈旧镜像盖掉本 origin 刚改的值。全程 try/catch 静默。
// index.html 以经典脚本提前加载本文件（settings-v3.7.json），种子落在 deferred 游戏模块
// （ui/loadoutSync.js、net.js、ui/settings.js）读取 pref 之前。

(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__SP_DATA && typeof window.__SP_DATA.flush === 'function') return; // already installed

  var VERSION = 1;
  var IDB_NAME = 'sp-player';
  var IDB_STORE = 'kv';
  var IDB_KEY = 'doc';
  var LS_KEY = 'sp.player.v1';
  var PREF_LOADOUT_KEY = 'sp.pref.loadout'; // store.js loadPref('loadout') — read by ui/loadoutSync.js
  var PREF_NAME_KEY = 'sp.name';            // net.js identity.loadName/saveName (raw, no prefix)
  var PREF_NAME_TS_KEY = 'sp.name.ts';      // 该镜像的写入时间戳（ms），用于与 doc.profile.ts 做 LWW 守卫
  var PREF_SETTINGS_KEY = 'sp.pref.settings';     // ui/settings.js settingsStore 的落盘键（store.js loadPref/savePref）
  var PREF_SETTINGS_TS_KEY = 'sp.pref.settings.ts'; // settings blob 级 LWW 的本地镜像戳（上游 sanitizeSettings 会剥 blob 内的 ts，戳只存这里）
  var FLUSH_MS = 2000;
  var MAX_BATTLES = 5000;   // the append-only log stays bounded so stringify()/merge stay cheap
  var MAX_ROOMS = 2000;
  var MAX_SERVERS = 500;
  var MAX_LOADOUTS = 1000;

  // v4.10 battle enrichment — the stats whitelist is the server-side canonical set (BBleae
  // shared/history.js: the 12 keys its aggregateStats totals) plus display-only extras, so the
  // local records panel aggregates with the very same field names and stays comparable.
  var STAT_TOTAL_KEYS = ['dmgDealt', 'healing', 'kills', 'leaks', 'bossDamage', 'perfectRounds',
    'gold', 'refreshes', 'merges', 'lpLost', 'buys', 'sells'];
  var STAT_EXTRA_KEYS = ['itemsEquipped', 'activatedLayers', 'fundsGained'];
  var BATTLE_STATUS = { completed: 1, left: 1, interrupted: 1 };
  var MAX_OP_IDS = 12;

  // ---- small helpers -------------------------------------------------------

  function now() { return Date.now(); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function int(v, d) { return typeof v === 'number' && isFinite(v) ? Math.round(v) : d; }
  function ts(v) { return isObj(v) ? int(v.ts, 0) : 0; }
  function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; } }

  var ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function newDeviceId() {
    var s = 'dev-';
    for (var i = 0; i < 16; i++) s += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
    return s;
  }

  function battleId(t, serverId, roomCode, mode) {
    return String(t) + '-' + serverId + '-' + roomCode + '-' + mode;
  }

  /** LWW: does the other side's item (ts/deviceId) beat the local side's? */
  function otherWins(localTs, otherTs, localDev, otherDev) {
    if (otherTs !== localTs) return otherTs > localTs;
    return String(otherDev) > String(localDev);
  }

  function emptyDoc(deviceId) {
    return {
      v: VERSION,
      deviceId: deviceId,
      profile: { name: '', ts: 0 },
      loadouts: {},
      battles: [],
    rooms: {},
    servers: {},
    settings: null,
    // v5.1: 匹配的一次性待办（面板写、任意页面加载时的落地钩子消费；随玩家数据跨 origin ——
    // localStorage 按 origin 隔离，切服重载后拿不到，所以必须走本文件）
    pendingMatch: null,
  };
  }

  // ---- sanitise (junk in → shaped v1 doc out, never throws) ----------------

  // The live model stores a loadout skill as a numeric index (ui/loadoutModel.js: `{ skill?: number,
  // module?: uniEquipId | 'none' }`; ui/loadoutSync.js passes these entries in), so `skill` must survive as a
  // number. The model's real cap is LOADOUT_LIMITS.skillIndex (shared/protocol.js) — this file never imports
  // game modules, so integers are clamped into a safe 0..99 guard band instead. Non-empty strings are still
  // tolerated for docs written by older builds. `module` keeps any non-empty string, including 'none' — the
  // explicit "no module" sentinel (MODULE_NONE) that the import side (loadoutModel.parseStored /
  // sanitizeEntries) recognises.
  var SKILL_MAX = 99;

  function normLoadoutEntry(e, t) {
    var out = { ts: t };
    if (Number.isInteger(e.skill)) out.skill = Math.max(0, Math.min(SKILL_MAX, e.skill));
    else if (typeof e.skill === 'string' && e.skill) out.skill = e.skill;
    if (typeof e.module === 'string' && e.module) out.module = e.module;
    return out;
  }

  function sanitizeStats(raw) {
    if (!isObj(raw)) return null;
    var out = null;
    var keys = STAT_TOTAL_KEYS.concat(STAT_EXTRA_KEYS);
    for (var i = 0; i < keys.length; i++) {
      var v = raw[keys[i]];
      if (typeof v === 'number' && isFinite(v) && v >= 0) {
        if (!out) out = {};
        out[keys[i]] = Math.round(v);
      }
    }
    return out;
  }

  function sanitizeOps(raw) {
    var out = [];
    if (!Array.isArray(raw)) return out;
    var seen = {};
    for (var i = 0; i < raw.length && out.length < MAX_OP_IDS; i++) {
      var id = str(raw[i]);
      if (!id || seen[id]) continue;
      seen[id] = 1;
      out.push(id);
    }
    return out;
  }

  function sanitizeBattle(raw) {
    if (!isObj(raw)) return null;
    var t = int(raw.ts, 0);
    if (!t) return null; // a battle without a timestamp cannot take part in id / ordering
    var serverId = str(raw.serverId);
    var roomCode = str(raw.roomCode);
    var mode = str(raw.mode);
    var b = { id: str(raw.id) || battleId(t, serverId, roomCode, mode), ts: t, serverId: serverId, roomCode: roomCode, mode: mode };
    if (raw.result === 'win' || raw.result === 'lose') b.result = raw.result;
    if (typeof raw.duration === 'number' && isFinite(raw.duration) && raw.duration >= 0) b.duration = Math.round(raw.duration);
    // v4.10 records enrichment (all optional — older docs stay valid)
    if (raw.difficulty) b.difficulty = str(raw.difficulty).toUpperCase().slice(0, 12);
    var round = int(raw.round, 0);
    if (round > 0) b.round = round;
    if (BATTLE_STATUS[str(raw.status)]) b.status = str(raw.status);
    if (raw.hidden === true) b.hidden = true;
    var stats = sanitizeStats(raw.stats);
    if (stats) b.stats = stats;
    var ops = sanitizeOps(raw.operators);
    if (ops.length) b.operators = ops;
    if (raw.title) b.title = str(raw.title).slice(0, 60);
    return b;
  }

  function sortBattles(list) {
    list.sort(function (a, b) { return (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return list;
  }

  function dedupeBattles(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !b.id || seen[b.id]) continue;
      seen[b.id] = 1;
      out.push(b);
    }
    return sortBattles(out);
  }

  function sanitizeRoom(raw) {
    if (!isObj(raw)) return null;
    var lastSeen = int(raw.lastSeen, 0);
    var firstSeen = int(raw.firstSeen, lastSeen);
    if (!lastSeen && !firstSeen) return null;
    return {
      serverId: str(raw.serverId),
      firstSeen: Math.min(firstSeen, lastSeen),
      lastSeen: Math.max(firstSeen, lastSeen),
      count: Math.max(0, int(raw.count, 0)),
    };
  }

  function sanitizeServer(raw) {
    if (!isObj(raw)) return null;
    var lastSeen = int(raw.lastSeen, 0);
    var firstSeen = int(raw.firstSeen, lastSeen);
    if (!lastSeen && !firstSeen) return null;
    return {
      name: str(raw.name),
      firstSeen: Math.min(firstSeen, lastSeen),
      lastSeen: Math.max(firstSeen, lastSeen),
      battles: Math.max(0, int(raw.battles, 0)),
    };
  }

  // ---- settings blob (v4.6) ---------------------------------------------------------------
  // 复刻上游 ui/gameLogic.js sanitizeSettings（本文件是 classic script，不能 import 游戏模块）。
  // 字段与默认值对齐 gameLogic.js:1529-1550：bgm/sfx ∈ 0..1（两位小数）、muted/damageNumbers 布尔、
  // quality ∈ high/medium/low、fontScale ∈ 五档 [0.85,0.95,1.05,1.15,1.25]（越界先 clamp 再就近吸附、
  // 缺省 1）、sidePad ∈ 0..40（缺省 0）。形状不符（非对象）整块置 null。ts 由本文件追加，不参与上游清洗。
  var SETTINGS_QUALITIES = ['high', 'medium', 'low'];
  var SETTINGS_FONT_STEPS = [0.85, 0.95, 1.05, 1.15, 1.25];

  function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // v2.8 上游语义：legacy 滑杆值先夹进 0.85..1.5，再吸附到最近的档位。
  function nearestStep(target) {
    var best = SETTINGS_FONT_STEPS[0];
    for (var i = 1; i < SETTINGS_FONT_STEPS.length; i++) {
      if (Math.abs(SETTINGS_FONT_STEPS[i] - target) < Math.abs(best - target)) best = SETTINGS_FONT_STEPS[i];
    }
    return best;
  }

  /** v5.1: 匹配待办（一次性）。形状不合法整体丢弃；difficulty 白名单外按「自动」处理（空串）。 */
  function sanitizePendingMatch(raw) {
    if (!isObj(raw)) return null;
    var t = int(raw.ts, 0);
    if (!t) return null;
    var d = str(raw.difficulty).toUpperCase();
    if (['FUNNY', 'NORMAL', 'HARD', 'ABYSS'].indexOf(d) < 0) d = '';
    return { ts: t, difficulty: d, venueId: str(raw.venueId).slice(0, 64) };
  }

  /** Sanitize one settings blob; `null` when raw is not an object (whole block dropped). */
  function sanitizeSettingsBlob(raw) {
    if (!isObj(raw)) return null;
    var vol = function (v, d) { return typeof v === 'number' && isFinite(v) ? clampNum(Math.round(v * 100) / 100, 0, 1) : d; };
    return {
      bgm: vol(raw.bgm, 0.6),
      sfx: vol(raw.sfx, 0.8),
      muted: typeof raw.muted === 'boolean' ? raw.muted : false,
      damageNumbers: typeof raw.damageNumbers === 'boolean' ? raw.damageNumbers : true,
      quality: SETTINGS_QUALITIES.indexOf(raw.quality) >= 0 ? raw.quality : 'high',
      fontScale: typeof raw.fontScale === 'number' && isFinite(raw.fontScale) ? nearestStep(clampNum(raw.fontScale, 0.85, 1.5)) : 1,
      sidePad: typeof raw.sidePad === 'number' && isFinite(raw.sidePad) ? clampNum(raw.sidePad, 0, 40) : 0,
      ts: int(raw.ts, 0),
    };
  }

  function sanitizeDoc(raw) {
    var d = emptyDoc(isObj(raw) && str(raw.deviceId) ? str(raw.deviceId) : newDeviceId());
    if (!isObj(raw)) return d;
    if (isObj(raw.profile) && typeof raw.profile.name === 'string') {
      d.profile = { name: raw.profile.name.slice(0, 64), ts: int(raw.profile.ts, 0) };
    }
    if (isObj(raw.loadouts)) {
      for (var id in raw.loadouts) {
        if (!Object.prototype.hasOwnProperty.call(raw.loadouts, id)) continue;
        var e = raw.loadouts[id];
        if (!isObj(e)) continue;
        d.loadouts[id] = normLoadoutEntry(e, int(e.ts, 0));
      }
    }
    if (Array.isArray(raw.battles)) {
      for (var i = 0; i < raw.battles.length; i++) {
        var b = sanitizeBattle(raw.battles[i]);
        if (b) d.battles.push(b);
      }
      d.battles = dedupeBattles(d.battles);
    }
    if (isObj(raw.rooms)) {
      for (var code in raw.rooms) {
        if (!Object.prototype.hasOwnProperty.call(raw.rooms, code)) continue;
        var r = sanitizeRoom(raw.rooms[code]);
        if (r) d.rooms[code] = r;
      }
    }
    if (isObj(raw.servers)) {
      for (var sid in raw.servers) {
        if (!Object.prototype.hasOwnProperty.call(raw.servers, sid)) continue;
        var s = sanitizeServer(raw.servers[sid]);
        if (s) d.servers[sid] = s;
      }
    }
    // v4.6：设置块只在形状合法时保留（清洗内部逐字段钳制；非对象整块为 null —— trim 后原样带出）。
    if (isObj(raw.settings)) d.settings = sanitizeSettingsBlob(raw.settings);
    // v5.1: 匹配待办（同款：非对象整体丢弃）
    if (isObj(raw.pendingMatch)) d.pendingMatch = sanitizePendingMatch(raw.pendingMatch);
    return trim(d);
  }

  function trimMap(map, cap, field) {
    var keys = Object.keys(map);
    if (keys.length <= cap) return map;
    keys.sort(function (x, y) { return int(map[y] && map[y][field], 0) - int(map[x] && map[x][field], 0); });
    var out = {};
    for (var i = 0; i < cap; i++) out[keys[i]] = map[keys[i]];
    return out;
  }

  function trim(d) {
    if (d.battles.length > MAX_BATTLES) d.battles = d.battles.slice(d.battles.length - MAX_BATTLES);
    d.rooms = trimMap(d.rooms, MAX_ROOMS, 'lastSeen');
    d.servers = trimMap(d.servers, MAX_SERVERS, 'lastSeen');
    d.loadouts = trimMap(d.loadouts, MAX_LOADOUTS, 'ts');
    return d;
  }

  // ---- merge (pure; unit-tested) -------------------------------------------

  /**
   * Merge `other` into `local` (other = an imported archive or the pre-load in-memory doc) using the
   * v1 rules. Returns a new doc; `local.deviceId` is always kept (an import never renames the device).
   */
  function mergeDocs(local, other) {
    var a = sanitizeDoc(local);
    var b = sanitizeDoc(other);
    var out = clone(a) || emptyDoc(a.deviceId);
    out.v = VERSION;
    out.deviceId = a.deviceId;

    if (b.profile.name && otherWins(ts(a.profile), ts(b.profile), a.deviceId, b.deviceId)) {
      out.profile = { name: b.profile.name, ts: b.profile.ts };
    }

    out.loadouts = clone(a.loadouts) || {};
    for (var id in b.loadouts) {
      if (!Object.prototype.hasOwnProperty.call(b.loadouts, id)) continue;
      var cur = out.loadouts[id];
      if (!cur || otherWins(ts(cur), ts(b.loadouts[id]), a.deviceId, b.deviceId)) out.loadouts[id] = clone(b.loadouts[id]);
    }

    out.battles = dedupeBattles((out.battles || []).concat(b.battles || []));

    out.rooms = clone(a.rooms) || {};
    for (var code in b.rooms) {
      if (!Object.prototype.hasOwnProperty.call(b.rooms, code)) continue;
      var o = b.rooms[code];
      var m = out.rooms[code];
      if (!m) { out.rooms[code] = clone(o); continue; }
      var rm = {
        serverId: m.serverId || o.serverId || '',
        firstSeen: Math.min(int(m.firstSeen, 0), int(o.firstSeen, 0)),
        lastSeen: Math.max(int(m.lastSeen, 0), int(o.lastSeen, 0)),
        count: Math.max(int(m.count, 0), int(o.count, 0)),
      };
      if (o.serverId && int(o.lastSeen, 0) > int(m.lastSeen, 0)) rm.serverId = o.serverId;
      out.rooms[code] = rm;
    }

    out.servers = clone(a.servers) || {};
    for (var sid in b.servers) {
      if (!Object.prototype.hasOwnProperty.call(b.servers, sid)) continue;
      var os = b.servers[sid];
      var ms = out.servers[sid];
      if (!ms) { out.servers[sid] = clone(os); continue; }
      var sm = {
        name: ms.name || os.name || '',
        firstSeen: Math.min(int(ms.firstSeen, 0), int(os.firstSeen, 0)),
        lastSeen: Math.max(int(ms.lastSeen, 0), int(os.lastSeen, 0)),
        battles: Math.max(int(ms.battles, 0), int(os.battles, 0)),
      };
      if (os.name && (!ms.name || int(os.lastSeen, 0) > int(ms.lastSeen, 0))) sm.name = os.name;
      out.servers[sid] = sm;
    }

    // v4.6：settings 整块 LWW —— 与 profile 同一 (ts, deviceId) 比较惯例（otherWins），缺 ts 视为 0；
    // 平局（ts 相等且 deviceId 相等）保留本地块。任一侧为 null 时取非 null 的一块。
    if (b.settings) {
      if (!out.settings || otherWins(out.settings.ts, b.settings.ts, a.deviceId, b.deviceId)) {
        out.settings = clone(b.settings);
      }
    }

    // v5.1：匹配待办同款整块 LWW（一次性记录：ts 新者胜；平局保留本地）
    if (b.pendingMatch) {
      if (!out.pendingMatch || otherWins(out.pendingMatch.ts, b.pendingMatch.ts, a.deviceId, b.deviceId)) {
        out.pendingMatch = clone(b.pendingMatch);
      }
    }

    return trim(out);
  }

  // ---- state + backends ----------------------------------------------------

  var doc = emptyDoc(newDeviceId());
  var bridge = null;     // window.spData (App shell) — synchronous get/put of the doc string
  var db = null;         // IndexedDB handle (null: not open / unavailable)
  var timer = null;      // flush throttle (null = idle)

  function serverId() {
    try {
      if (window.shell && typeof window.shell.currentServerId === 'function') {
        var s = window.shell.currentServerId();
        if (s) return String(s);
      }
    } catch (e) { /* no shell bridge */ }
    try {
      if (window.location && window.location.host) return String(window.location.host);
    } catch (e) { /* no location */ }
    return 'local';
  }

  function lsGet() {
    try { return window.localStorage ? window.localStorage.getItem(LS_KEY) : null; } catch (e) { return null; }
  }

  function lsSet(text) {
    try { if (window.localStorage) window.localStorage.setItem(LS_KEY, text); } catch (e) { /* quota / private mode */ }
  }

  // ---- v3.7 seed: per-origin preference fill-in (loadout gaps + callsign realignment) -------------
  // The loadout lives in localStorage `sp.pref.loadout` (store.js loadPref, read by ui/loadoutSync.js)
  // and the callsign in `sp.name` (net.js identity) — both per-origin, while the doc follows the
  // player across origins (App: filesDir via window.spData). These seeds run from init()'s synchronous
  // section. The loadout is still gap-only (an existing value is never overwritten) and is written in
  // loadoutModel.toStored shape `{ v:1, entries }` without per-entry ts; the explicit no-module
  // sentinel 'none' is kept as-is. The callsign, by contrast, realigns to the doc (the cross-origin
  // truth): `sp.name` is overwritten whenever doc.profile.name differs AND doc.profile.ts is not older
  // than the local mirror stamp `sp.name.ts` — a locally-newer edit (this origin renamed, the doc has
  // not caught up yet) is preserved.

  function seedLoadoutPref() {
    var loadouts = doc.loadouts;
    if (!isObj(loadouts)) return;
    var ids = Object.keys(loadouts);
    if (!ids.length) return;
    var raw = null;
    try { raw = window.localStorage ? window.localStorage.getItem(PREF_LOADOUT_KEY) : null; } catch (e) { return; }
    if (raw != null) {
      try {
        var prev = JSON.parse(raw);
        var entries = isObj(prev) ? (isObj(prev.entries) ? prev.entries : (prev.v == null ? prev : null)) : null;
        if (entries && Object.keys(entries).length) return; // 已有值：绝不覆盖
      } catch (e) { /* 坏值按缺失处理 */ }
    }
    var out = {};
    for (var i = 0; i < ids.length; i++) {
      var e = loadouts[ids[i]];
      if (!isObj(e)) continue;
      var one = {};
      if (Number.isInteger(e.skill)) one.skill = e.skill;
      else if (typeof e.skill === 'string' && e.skill) one.skill = e.skill; // legacy docs
      if (typeof e.module === 'string' && e.module) one.module = e.module;
      if (one.skill !== undefined || one.module !== undefined) out[ids[i]] = one;
    }
    if (!Object.keys(out).length) return;
    try {
      window.localStorage.setItem(PREF_LOADOUT_KEY, JSON.stringify({ v: VERSION, entries: out }));
    } catch (e) { /* private mode / quota: silent */ }
  }

  // 写回本 origin 的代号镜像：`sp.name` + 时间戳 `sp.name.ts`（两者同一时刻写入）。
  function writeNamePref(name, t) {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(PREF_NAME_KEY, str(name).slice(0, 64));
      window.localStorage.setItem(PREF_NAME_TS_KEY, String(int(t, 0)));
    } catch (e) { /* private mode / quota: silent */ }
  }

  function seedNamePref() {
    // 真源：doc.profile.name（字符串、非空）。
    var docName = isObj(doc.profile) && typeof doc.profile.name === 'string' ? doc.profile.name : '';
    if (!docName) return;
    var docTs = isObj(doc.profile) ? int(doc.profile.ts, 0) : 0;
    var ls = null, rawName = null, rawTs = null;
    try {
      ls = window.localStorage;
      if (!ls) return; // 无 storage（隐私模式 / 非浏览器）：静默跳过
      rawName = ls.getItem(PREF_NAME_KEY);
      rawTs = ls.getItem(PREF_NAME_TS_KEY);
    } catch (e) { return; }
    if (rawName === docName) return; // 已一致
    var hasLocal = rawName != null && rawName !== '';
    var localTs = rawTs == null || rawTs === '' ? 0 : int(Number(rawTs), 0);
    // 严格更新：仅当 doc 时间戳**严格大于**本地镜像时才覆盖。
    // - 本地无值（换站首进）直接补齐；
    // - doc 无 ts（docTs=0，旧版写入不产生镜像戳）而本地有值 → 绝不覆盖（旧镜像 ts=0，
    //   旧版 `docTs >= localTs` 判真会让下发档顶掉本 origin 已有代号 —— 止血点）；
    // - ts 相等视为「非更新」，保留本地（与 loadout 的只进语义一致）。
    if (hasLocal && !(docTs > 0 && docTs > localTs)) return;
    writeNamePref(docName, docTs);
  }

  // v4.6 设置持久化：读取端。本 origin 的 `sp.pref.settings`（settingsStore 落盘键）与 doc.settings
  // 以镜像戳 `sp.pref.settings.ts` 做 blob 级 LWW：doc 新 → 覆盖本地（A 站改的音量在 B 站生效）；
  // 本地新（本站刚改过、doc 未跟上）→ 保留本地并回写 doc；doc 无块 → 不动本地。镜像戳缺失视为 0
  // （旧版不产生该键）——此时本地 blob 已存在即视为「本地有值」，doc 无更晚 ts 就绝不覆盖。
  // localStorage 不可用时整段静默（与其它 seed 一致）。
  function seedSettingsPref() {
    var ls = null, raw = null, rawTs = null;
    try {
      ls = window.localStorage;
      if (!ls) return; // 无 storage（隐私模式 / 非浏览器）：静默跳过
      raw = ls.getItem(PREF_SETTINGS_KEY);
      rawTs = ls.getItem(PREF_SETTINGS_TS_KEY);
    } catch (e) { return; }
    var docSettings = isObj(doc.settings) ? doc.settings : null;
    var localTs = rawTs == null || rawTs === '' ? 0 : int(Number(rawTs), 0);
    var hasLocal = raw != null && raw !== '';
    if (!docSettings) return; // doc 无块：不动本地
    if (hasLocal && !(docSettings.ts > localTs)) {
      // 本地有值且 doc 不是严格更新 → 保留本地，并把本地 blob 回写进 doc（补上 ts 成为跨站真源）。
      try { recordSettings(JSON.parse(raw)); } catch (e) { /* 坏 blob 按缺失处理 */ }
      return;
    }
    // 本地无值（换站首进）或 doc 严格更新：用 doc 块（去 ts —— 上游键里不能带未知字段）种入 + 写戳。
    var blob = sanitizeSettingsBlob(docSettings);
    if (!blob) return;
    var t = blob.ts;
    delete blob.ts;
    try {
      ls.setItem(PREF_SETTINGS_KEY, JSON.stringify(blob));
      ls.setItem(PREF_SETTINGS_TS_KEY, String(int(t, 0)));
    } catch (e) { /* private mode / quota: silent */ }
  }

  function seedLocalPrefs() {
    try { seedLoadoutPref(); } catch (e) { /* silent */ }
    try { seedNamePref(); } catch (e) { /* silent */ }
    try { seedSettingsPref(); } catch (e) { /* silent */ }
  }

  function idbOpen(cb) {
    if (db) { cb(db); return; }
    var req, done = false;
    function finish(handle) { if (done) return; done = true; cb(handle); }
    try { req = window.indexedDB.open(IDB_NAME, 1); } catch (e) { req = null; }
    if (!req) { finish(null); return; }
    req.onupgradeneeded = function () { try { req.result.createObjectStore(IDB_STORE); } catch (e) { /* store exists */ } };
    req.onsuccess = function () { db = req.result; finish(db); };
    req.onerror = function () { finish(null); };
    req.onblocked = function () { finish(null); }; // another tab holds an old version open
  }

  function idbGet(cb) {
    idbOpen(function (handle) {
      if (!handle) { cb(undefined); return; }
      try {
        var rq = handle.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
        rq.onsuccess = function () { cb(rq.result); };
        rq.onerror = function () { cb(undefined); };
      } catch (e) { cb(undefined); }
    });
  }

  function idbPut(text) {
    idbOpen(function (handle) {
      if (!handle) return;
      try {
        handle.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(text, IDB_KEY);
      } catch (e) { /* the localStorage mirror below still carries the write */ }
    });
  }

  function persist() {
    var text;
    try { text = JSON.stringify(doc); } catch (e) { return; }
    if (bridge) {
      try { bridge.put(text); } catch (e) { bridge = null; } // bridge died → fall through to the web layers
    }
    if (!bridge) idbPut(text);
    lsSet(text); // always keep the cheap mirror in sync
  }

  function scheduleFlush() {
    if (timer != null) return;
    try {
      timer = setTimeout(function () { timer = null; persist(); }, FLUSH_MS);
    } catch (e) {
      timer = null;
      persist();
    }
  }

  function flush() {
    if (timer != null) {
      try { clearTimeout(timer); } catch (e) { /* no timer API */ }
      timer = null;
    }
    persist();
  }

  function bindLifecycle() {
    try {
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', flush);
        window.addEventListener('beforeunload', flush);
      }
    } catch (e) { /* never break the game */ }
    try {
      if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
      }
    } catch (e) { /* never break the game */ }
  }

  function touchServer(id, name, t) {
    if (!id) return;
    var s = doc.servers[id];
    if (!s) {
      doc.servers[id] = { name: name || id, firstSeen: t, lastSeen: t, battles: 0 };
      return;
    }
    if (name && !s.name) s.name = name;
    s.firstSeen = Math.min(int(s.firstSeen, t), t);
    s.lastSeen = Math.max(int(s.lastSeen, 0), t);
    s.battles = int(s.battles, 0);
  }

  function init() {
    // 1) synchronous layer: the App bridge (truth) or the web localStorage mirror
    try {
      if (window.spData && typeof window.spData.get === 'function' && typeof window.spData.put === 'function') {
        bridge = window.spData;
      }
    } catch (e) { bridge = null; }
    var initial = null;
    if (bridge) {
      try { initial = bridge.get(); } catch (e) { bridge = null; }
    }
    if (!initial) initial = lsGet();
    try {
      var parsed = initial ? JSON.parse(initial) : null;
      if (isObj(parsed)) doc = sanitizeDoc(parsed);
    } catch (e) { /* corrupt mirror → keep the fresh empty doc */ }

    // 1.5) v3.7 seed: the synchronous layers above are loaded, so fill this origin's empty
    // loadout/callsign prefs from the doc (gaps only — never overwritten). index.html loads this file
    // as a classic script before the deferred game modules, so the seeds land before ui/loadoutSync.js
    // and net.js read their keys.
    seedLocalPrefs();

    // 2) asynchronous layer: IndexedDB (browser truth) merges in once it opens. The stored doc is
    // the base and anything recorded before the load (same-day edits) merges over it by LWW.
    if (!bridge) {
      idbGet(function (text) {
        var stored = null;
        try { stored = typeof text === 'string' ? JSON.parse(text) : null; } catch (e) { stored = null; }
        if (isObj(stored)) {
          doc = mergeDocs(sanitizeDoc(stored), doc);
          scheduleFlush(); // converge IDB + the localStorage mirror
        }
      });
    }

    // 3) remember which server this installation has touched
    var sid = serverId();
    touchServer(sid, sid, now());
    scheduleFlush();
    bindLifecycle();
  }

  // ---- public API (called from the game hooks / shell UI) ------------------

  /** Derive a room sighting from a room.state payload: firstSeen/lastSeen + max humans seen. */
  function recordRoom(roomState) {
    try {
      if (!isObj(roomState)) return;
      var code = str(roomState.code);
      if (!code) return;
      var t = now();
      var sid = serverId();
      var humans = 0;
      if (Array.isArray(roomState.seats)) {
        for (var i = 0; i < roomState.seats.length; i++) {
          var seat = roomState.seats[i];
          if (seat && seat.playerId && !seat.isBot && seat.connected !== false) humans++;
        }
      }
      var r = doc.rooms[code];
      if (!r) doc.rooms[code] = { serverId: sid, firstSeen: t, lastSeen: t, count: humans };
      else {
        if (!r.serverId) r.serverId = sid;
        r.firstSeen = Math.min(int(r.firstSeen, t), t);
        r.lastSeen = Math.max(int(r.lastSeen, 0), t);
        r.count = Math.max(int(r.count, 0), humans);
      }
      touchServer(sid, sid, t);
      scheduleFlush();
    } catch (e) { /* never break the game */ }
  }

  /** Record a finished battle — result only (win/lose, duration, mode, room), keyed by a natural id. */
  function recordResult(result, ctx) {
    try {
      var r = isObj(result) ? result : {};
      var c = isObj(ctx) ? ctx : {};
      var t = now();
      var sid = str(c.serverId) || serverId();
      var roomCode = str(c.roomCode);
      var mode = str(c.mode) || str(r.modeId);
      var id = battleId(t, sid, roomCode, mode);
      for (var i = doc.battles.length - 1; i >= 0; i--) {
        if (doc.battles[i].id === id) return; // the same event replayed in the same ms collapses
      }
      var b = { id: id, ts: t, serverId: sid, roomCode: roomCode, mode: mode, result: r.victory ? 'win' : 'lose' };
      if (typeof r.durationMs === 'number' && isFinite(r.durationMs) && r.durationMs >= 0) b.duration = Math.round(r.durationMs);
      // v4.10: the settlement summary carries the full per-match record (the server-side canonical
      // field set, field for field) — keep the local viewer's own row only. `meId` comes from the
      // m.result hook (store.me.playerId); without it the battle is still recorded, just briefer.
      if (r.difficulty) b.difficulty = str(r.difficulty).toUpperCase().slice(0, 12);
      var players = Array.isArray(r.players) ? r.players : [];
      var meId = c.meId == null ? '' : String(c.meId);
      var me = null;
      for (var k = 0; k < players.length; k++) {
        if (meId && players[k] && String(players[k].playerId) === meId) { me = players[k]; break; }
      }
      var round = int(me && me.roundsPassed, 0) || int(r.roundsPassed, 0);
      if (round > 0) b.round = round;
      if (me && me.left === true) b.status = 'left';
      else if (r.reason === 'error' || r.reason === 'abandoned') b.status = 'interrupted';
      else b.status = 'completed';
      if (r.hiddenCleared === true) b.hidden = true;
      if (me) {
        var st = sanitizeStats(me.stats);
        if (st) b.stats = st;
        var ops = sanitizeOps((Array.isArray(me.lineup) ? me.lineup : []).map(function (l) { return l && l.id; }));
        if (ops.length) b.operators = ops;
        if (me.title && me.title.text) b.title = str(me.title.text).slice(0, 60);
      }
      doc.battles.push(b);
      sortBattles(doc.battles);
      if (doc.battles.length > MAX_BATTLES) doc.battles = doc.battles.slice(doc.battles.length - MAX_BATTLES);
      touchServer(sid, str(c.serverName) || sid, t);
      var s = doc.servers[sid];
      s.battles = int(s.battles, 0) + 1;
      s.lastSeen = Math.max(int(s.lastSeen, 0), t);
      s.firstSeen = Math.min(int(s.firstSeen, t), t);
      if (roomCode && doc.rooms[roomCode]) doc.rooms[roomCode].lastSeen = Math.max(int(doc.rooms[roomCode].lastSeen, 0), t);
      scheduleFlush();
    } catch (e) { /* never break the game */ }
  }

  // ---- 匹配待办（v5.1）：跨 origin 的一次性传递通道 --------------------------------------------
  // 面板「开始匹配」写下 {difficulty, venueId} → 切服重载后任意页面加载时的落地钩子消费。
  // 走 doc（App: filesDir 文件 / 网页: IndexedDB+localStorage）——localStorage 本身按 origin 隔离，
  // 切服就丢了，不能当载体。

  /** 记录待办（覆盖式；解析到白名单外的难度按「自动」存空串）。 */
  function recordMatchPending(input) {
    try {
      var raw = isObj(input) ? input : {};
      var d = str(raw.difficulty).toUpperCase();
      if (['FUNNY', 'NORMAL', 'HARD', 'ABYSS'].indexOf(d) < 0) d = '';
      doc.pendingMatch = { ts: now(), difficulty: d, venueId: str(raw.venueId).slice(0, 64) };
      flush(); // 一次性待办：立刻落盘，重载即见
      return true;
    } catch (e) { return false; }
  }

  /** 只看不消费（钩子先校验新鲜度/联网状态，再决定 take）。 */
  function peekMatchPending() {
    try { return isObj(doc.pendingMatch) ? clone(doc.pendingMatch) : null; } catch (e) { return null; }
  }

  /** 取走并清除（返回上一次记录或 null）。 */
  function takeMatchPending() {
    try {
      var v = isObj(doc.pendingMatch) ? clone(doc.pendingMatch) : null;
      if (doc.pendingMatch) { doc.pendingMatch = null; flush(); }
      return v;
    } catch (e) { return null; }
  }

  /** 只清除。 */
  function clearMatchPending() {
    try {
      if (doc.pendingMatch) { doc.pendingMatch = null; flush(); }
      return true;
    } catch (e) { return false; }
  }

  // ---- battle statistics (v4.10) -------------------------------------------
  // Same semantics as the server-side canonical aggregator (BBleae shared/history.js) so the
  // numbers match the Workers-based servers — computed entirely locally, no network. `filter`
  // = { mode?, difficulty? } (empty string / absent = all). Pure function → unit-tested.
  function battleStats(list, filter) {
    var f = isObj(filter) ? filter : {};
    var fMode = str(f.mode);
    var fDiff = str(f.difficulty);
    var out = { total: 0, completed: 0, wins: 0, loses: 0, left: 0, interrupted: 0,
      winRate: null, highestRound: 0, hidden: 0, totals: {}, operators: [] };
    var opCount = {};
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (!isObj(b)) continue;
      if (fMode && str(b.mode) !== fMode) continue;
      if (fDiff && str(b.difficulty) !== fDiff) continue;
      out.total++;
      var status = str(b.status) || 'completed';
      if (status === 'left') out.left++;
      else if (status === 'interrupted') out.interrupted++;
      else out.completed++;
      if (b.result === 'win') out.wins++;
      else if (b.result === 'lose') out.loses++;
      if (b.hidden === true && status !== 'left') out.hidden++;
      var round = int(b.round, 0);
      if (round > out.highestRound) out.highestRound = round;
      if (isObj(b.stats)) {
        for (var j = 0; j < STAT_TOTAL_KEYS.length; j++) {
          var v = b.stats[STAT_TOTAL_KEYS[j]];
          if (typeof v === 'number' && isFinite(v)) out.totals[STAT_TOTAL_KEYS[j]] = (out.totals[STAT_TOTAL_KEYS[j]] || 0) + v;
        }
      }
      if (Array.isArray(b.operators)) {
        for (var m = 0; m < b.operators.length; m++) {
          var id = str(b.operators[m]);
          if (id) opCount[id] = (opCount[id] || 0) + 1;
        }
      }
    }
    out.winRate = out.completed > 0 ? out.wins / out.completed : null;
    var ops = [];
    for (var opId in opCount) {
      if (Object.prototype.hasOwnProperty.call(opCount, opId)) ops.push({ id: opId, matches: opCount[opId] });
    }
    ops.sort(function (a, b2) { return (b2.matches - a.matches) || (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0); });
    out.operators = ops.slice(0, 8);
    return out;
  }

  /**
   * Record this device's complete loadout snapshot (the caller passes the full entries map of the live model:
   * `{ [baseChessId]: { skill?: number, module?: uniEquipId | 'none' } }` — ui/loadoutModel.js). `skill` is a
   * numeric index (kept, clamped into 0..99); `module` is any non-empty string, including `'none'` — the
   * explicit "no module" sentinel (MODULE_NONE) — the import side (loadoutModel.parseStored / sanitizeEntries)
   * validates it. Entries without a usable field still store just `{ ts }`, as before.
   */
  function recordLoadout(entries) {
    try {
      if (!isObj(entries)) return;
      var t = now();
      var next = {};
      for (var id in entries) {
        if (!Object.prototype.hasOwnProperty.call(entries, id)) continue;
        var e = entries[id];
        if (!isObj(e)) continue;
        next[id] = normLoadoutEntry(e, t);
      }
      doc.loadouts = next;
      scheduleFlush();
    } catch (e) { /* never break the game */ }
  }

  /** Record the player name (empty names are ignored). */
  function recordProfile(name) {
    try {
      var n = str(name).slice(0, 64);
      if (!n) return;
      var t = now();
      doc.profile = { name: n, ts: t };
      writeNamePref(n, t); // 顺带回写本 origin，使「本站改名」立刻成为跨站真源
      scheduleFlush();
    } catch (e) { /* never break the game */ }
  }

  // v4.6 设置持久化：写入端。上游 settings.js 的 savePref 会把 blob 原样写进 `sp.pref.settings`，
  // 但上游 sanitizeSettings 会剥掉 blob 里的未知字段（ts 进不了那个键）——所以 blob 级 LWW 的
  // 时间戳只记录在本文件的镜像戳键 `sp.pref.settings.ts`，doc.settings 里才带 ts。
  /** Record this device's full settings snapshot (the live settingsStore state; clamped like the upstream model). */
  function recordSettings(s) {
    try {
      var clean = sanitizeSettingsBlob(s);
      if (!clean) return;
      var t = now();
      clean.ts = t;
      doc.settings = clean;
      try {
        if (window.localStorage) window.localStorage.setItem(PREF_SETTINGS_TS_KEY, String(t));
      } catch (e2) { /* private mode / quota: silent */ }
      scheduleFlush();
    } catch (e) { /* never break the game */ }
  }

  /** Record/refresh a server entry ({id, name}); firstSeen stays, lastSeen moves. */
  function recordServer(info) {
    try {
      if (!isObj(info)) return;
      var id = str(info.id);
      if (!id) return;
      touchServer(id, str(info.name) || id, now());
      scheduleFlush();
    } catch (e) { /* never break the game */ }
  }

  /** The whole doc as text (download/save UI is the caller's job — this never fetches a URL). */
  function exportJSON() {
    try { return JSON.stringify(doc); } catch (e) { return '{"v":1}'; }
  }

  /**
   * Validate a user-supplied doc (JSON object, integer v ∈ [1, VERSION]) and merge it in (LWW).
   * An older archive can never overwrite newer values; malformed input is refused untouched.
   * @returns {boolean} accepted
   */
  function importJSON(text) {
    try {
      if (typeof text !== 'string' || !text) return false;
      var raw = JSON.parse(text);
      if (!isObj(raw)) return false;
      var v = raw.v;
      if (typeof v !== 'number' || !isFinite(v) || v !== Math.floor(v) || v < 1 || v > VERSION) return false;
      doc = mergeDocs(doc, raw);
      flush(); // a user-driven import is durable at once
      return true;
    } catch (e) {
      return false;
    }
  }

  window.__SP_DATA = {
    version: VERSION,
    deviceId: function () { return doc.deviceId; },
    recordRoom: recordRoom,
    recordResult: recordResult,
    recordLoadout: recordLoadout,
    recordProfile: recordProfile,
    recordServer: recordServer,
    recordSettings: recordSettings,
    exportJSON: exportJSON,
    importJSON: importJSON,
    flush: flush,
    battleStats: battleStats,      // v4.10 pure local aggregator (same 口径 as the server side)
    recordMatchPending: recordMatchPending, // v5.1 一次性跨 origin 匹配待办
    peekMatchPending: peekMatchPending,
    takeMatchPending: takeMatchPending,
    clearMatchPending: clearMatchPending,
    statKeys: STAT_TOTAL_KEYS.slice(),
    _mergeDocs: mergeDocs, // pure merge, exercised by tools/apk/player-merge.test.mjs
  };

  init();
})();
