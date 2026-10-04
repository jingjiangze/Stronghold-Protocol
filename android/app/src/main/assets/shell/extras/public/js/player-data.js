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
//     battles:[ {id,ts,serverId,roomCode,mode,result?,duration?} ],   // append-only；id 天然去重
//     rooms:{ [code]:{serverId,firstSeen,lastSeen,count} },           // count = 见过的最大人类玩家数
//     servers:{ [id]:{name,firstSeen,lastSeen,battles} } }
//
// 合并规则（导入旧档 / IndexedDB 载入与内存合并，工具单测见 tools/apk/player-merge.test.mjs）：
//   profile = 字段 LWW：比较 (ts, deviceId)，ts 大者胜；ts 相同 deviceId 字符串大者胜；
//   loadouts = 键级 LWW（同一比较）；battles = 按 id 并集（去重、ts 升序）；
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
// v3.7 种子（只补缺）：换服务器 = 新 origin，`sp.pref.loadout` 与 `sp.name` 都随 origin 重置——
// 代号会由 title.js 从玩家数据预填，干员配置却悄悄回默认。init() 的同步段（doc 就绪之后、异步
// IndexedDB 之前）用 doc 里已有的 loadouts / profile.name 补齐这两个键；已有值绝不覆盖，全程
// try/catch 静默。index.html 以经典脚本提前加载本文件（settings-v3.7.json），种子落在 deferred
// 游戏模块（ui/loadoutSync.js、net.js）读取 pref 之前。

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
  var FLUSH_MS = 2000;
  var MAX_BATTLES = 5000;   // the append-only log stays bounded so stringify()/merge stay cheap
  var MAX_ROOMS = 2000;
  var MAX_SERVERS = 500;
  var MAX_LOADOUTS = 1000;

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

  // ---- v3.7 seed: per-origin preference fill-in (loadout + callsign, gaps only) -------------------
  // The loadout lives in localStorage `sp.pref.loadout` (store.js loadPref, read by ui/loadoutSync.js)
  // and the callsign in `sp.name` (net.js identity) — both per-origin, while the doc follows the
  // player across origins (App: filesDir via window.spData). These seeds run from init()'s synchronous
  // section when the keys are still empty; an existing value is never overwritten. The loadout is
  // written in loadoutModel.toStored shape `{ v:1, entries }` without per-entry ts, and the explicit
  // no-module sentinel 'none' is kept as-is.

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

  function seedNamePref() {
    var name = isObj(doc.profile) && typeof doc.profile.name === 'string' ? doc.profile.name : '';
    if (!name) return;
    var raw = null;
    try { raw = window.localStorage ? window.localStorage.getItem(PREF_NAME_KEY) : null; } catch (e) { return; }
    if (raw != null && raw !== '') return; // 已有值：绝不覆盖
    try { window.localStorage.setItem(PREF_NAME_KEY, name.slice(0, 64)); } catch (e) { /* silent */ }
  }

  function seedLocalPrefs() {
    try { seedLoadoutPref(); } catch (e) { /* silent */ }
    try { seedNamePref(); } catch (e) { /* silent */ }
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
      doc.profile = { name: n, ts: now() };
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
    exportJSON: exportJSON,
    importJSON: importJSON,
    flush: flush,
    _mergeDocs: mergeDocs, // pure merge, exercised by tools/apk/player-merge.test.mjs
  };

  init();
})();
