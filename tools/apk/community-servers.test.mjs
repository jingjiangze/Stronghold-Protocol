// community-servers.test.mjs — 社区服务器清单（玩家上传 / 众包探测）的 Java 侧守卫。
//
//   node --test tools/apk/community-servers.test.mjs
//
// 业主 2026-10-17 的口径（原话）：「玩家上传的服务器直接到清单，然后探测是否有效也是交给玩家，然后
// 再回报给服务器」「服务器清单里的最后一项加入上传服务器，需域名和备注（备注不填默认社区服然后代号
// 命名）」「未探测到版本号的服务器不在清单里列出」。
//
// 这份清单**未签名**，所以整条链的安全边界只有三条，这里逐条钉死：
//   ① 只追加：排在签名条目之后，id/主机撞车的一律丢弃（签名清单永远优先）；
//   ② 只认自己的 API 主机：COMMUNITY_BASES 之外一律不发请求；
//   ③ 只回报自己的探测结果：一个进程一批，失败静默（回报绝不能影响进游戏）。
//
// Java 不能在这里执行（设备侧），所以门禁是**对出厂源码的静态断言** —— 与
// android-main-publicdir.test.mjs / shell-panels.test.mjs 同一套做法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMUNITY_BASES } from './line.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

const LINE = read('android/app/src/main/java/icu/jiangjiangze/stronghold/Line.java');
const LIST = read('android/app/src/main/java/icu/jiangjiangze/stronghold/ServerList.java');
const MAIN = read('android/app/src/main/java/icu/jiangjiangze/stronghold/MainActivity.java');

test('COMMUNITY_BASES：Line.java 与 line.mjs 逐字一致（含顺序）', () => {
  const m = LINE.match(/static final String\[\] COMMUNITY_BASES = \{([\s\S]*?)\};/);
  assert.ok(m, 'Line.java 必须有 COMMUNITY_BASES');
  const java = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(java, COMMUNITY_BASES, 'Java 与 JS 的社区 API 根必须一致，顺序也一样（主源优先）');
  // 顺序有意义：生产站还没部署这份 Functions 时 /api/community/list 会落到 SPA 外壳返回 HTML，
  // 所以生产必须在前、Pages 分支预览兜底在后 —— 反了就等于永远拿 HTML 当清单。
  assert.match(java[0], /^https:\/\/dl\.jiangjiangze\.icu\//, '主源 = 下载站');
  assert.match(java[1], /\.pages\.dev\//, '兜底 = Pages 分支预览');
});

test('只追加：社区清单排在签名条目之后，且 id/主机撞车一律丢弃', () => {
  assert.ok(/e\.tier = -1;/.test(LIST), '社区条目 tier 必须为 -1（rank 按 tier 降序 ⇒ 签名条目永远在前）');
  assert.ok(/if \(ids\.contains\(e\.id\) \|\| hosts\.contains\(e\.host\(\)\)\) continue;/.test(LIST),
    'id 或主机与签名条目撞车的社区条目必须丢弃（未签名清单不许覆盖签名条目）');
  assert.ok(/mergeCommunity\(remote\.entries\);[\s\S]{0,200}annotate\(ctx, remote\.entries\);/.test(LIST),
    '社区清单必须在 annotate 之前并入（好让它吃到同一套 sticky-hide / 成功率标注）');
  // 只增不减：合并路径里不许出现任何写回既有条目状态的语句
  const merge = LIST.match(/private static void mergeCommunity[\s\S]*?\n    \}/);
  assert.ok(merge, 'mergeCommunity 必须存在');
  for (const banned of ['e.status =', 'e.enabled =', 'e.stickyHidden =', 'e.community = false']) {
    assert.ok(!merge[0].includes(banned), `mergeCommunity 只许 append，不许 ${banned}`);
  }
  assert.ok(merge[0].includes('list.add(e);'), '合并的唯一动作就是追加');
});

test('社区清单是网络段独有：缓存段（零网络）不碰它', () => {
  const cached = LIST.match(/public static Snapshot loadCached[\s\S]*?\n    \}/);
  assert.ok(cached, 'loadCached 必须存在');
  assert.ok(!cached[0].includes('mergeCommunity'), '缓存段必须保持零网络（冷启动秒出清单）');
  assert.ok(!cached[0].includes('fetchCommunity'), '缓存段不许发社区清单请求');
});

test('只认自己的 API 主机：URL 必须在 COMMUNITY_BASES 前缀内', () => {
  assert.ok(/for \(String base : Line\.COMMUNITY_BASES\) \{\s*if \(url != null && url\.startsWith\(base\)\) return true;/.test(LIST),
    'isCommunityUrl 只允许 COMMUNITY_BASES 前缀（清单是未签名的，不能变成任意域名的跳板）');
  // 所有出网调用都必须先过 isCommunityUrl
  const posts = [...LIST.matchAll(/String url = base \+ path;[\s\S]{0,120}?if \(!isCommunityUrl\(url\)\) continue;/g)];
  assert.equal(posts.length, 1, 'postCommunity 必须先过 isCommunityUrl');
  assert.ok(/if \(!isCommunityUrl\(url\)\) continue;\s*String body = httpGet/.test(LIST),
    'fetchCommunity 必须先过 isCommunityUrl');
});

test('上传：https + 公网 + 备注默认「社区服」+ 代号命名', () => {
  assert.ok(/"只接受 https 地址"/.test(LIST), '上传只接受 https');
  assert.ok(/if \(!isPublicHttpUrl\(v\)\) return new String\[\]\{"0", "这不是一个公网地址"\}/.test(LIST),
    '私网/回环地址必须拒收（清单会渲染在每个玩家的浏览器里）');
  assert.ok(/if \(note\.isEmpty\(\)\) note = "社区服";/.test(LIST), '备注不填默认「社区服」');
  assert.ok(/String name = codeName\(host\);/.test(LIST), '名称由主机名确定性派生（代号命名，界面不出现域名）');
  assert.ok(/return "社区服-" \+ sb;/.test(LIST), '代号格式 = 社区服-XXXX');
  // 代号必须确定性：同一个 host 在任何客户端算出同一串（否则同一台服务器在两人界面上是两个名字）
  assert.ok(/long v = \(\(long\) \(host == null \? 0 : host\.hashCode\(\)\)\) & 0xffffffffL;/.test(LIST),
    'codeName 必须只依赖 host（确定性）');
});

test('回报：一个进程一批、只在有社区条目时发、失败静默', () => {
  assert.ok(/communityReported\s*=\s*new java\.util\.concurrent\.atomic\.AtomicBoolean\(false\)/.test(LIST),
    '回报必须有「一个进程一次」的闸');
  assert.ok(/if \(!communityReported\.compareAndSet\(false, true\)\) return;/.test(LIST),
    'CAS 而不是 check-then-act（两次刷新竞争时只发一批）');
  assert.ok(/if \(!anyCommunity\) return;/.test(LIST), '没有社区条目就不发（省一次出网）');
  assert.ok(/body\.put\("client", communityClientId\(app\)\)/.test(LIST), '批次必须带 client id');
  assert.ok(/r\.put\("id", e\.id\)/.test(LIST) && /r\.put\("ok", e\.reachable\)/.test(LIST),
    '每条结果 = {id, ok, rttMs?, version?}（与 functions/api/community/report.js 的契约一致）');
  // 触发点：远端段探测完之后（不是缓存段，缓存段没有社区条目）
  assert.ok(/ServerList\.probeAll\(app, remote\.entries\);[\s\S]{0,400}ServerList\.reportCommunityAsync\(app, remote\.entries\);/.test(MAIN),
    '回报必须在远端段 probeAll 之后触发');
});

test('顾问（subtract-only）绝不动社区条目：签名名单不知道它们，否则刚上传就判死', () => {
  const apply = LIST.match(/private static void applyAdvisor\(Advisor adv, List<Entry> list\) \{[\s\S]*?\n    \}/);
  assert.ok(apply, 'applyAdvisor 必须存在');
  assert.ok(/if \(e\.community\) continue;/.test(apply[0]),
    'applyAdvisor 必须跳过社区条目（valid 集只描述签名清单；社区有效性 = 服务端 deadByCrowd + 本机 sticky-hide）');
});

test('上传桥：后台线程 + 结果回推页面（不许阻塞 JS 桥线程）', () => {
  const bridge = MAIN.match(/public void uploadCommunityServer\(String url, String note\) \{[\s\S]*?\n        \}/);
  assert.ok(bridge, 'ShellBridge.uploadCommunityServer 必须存在');
  assert.ok(/new Thread\(\(\) -> \{/.test(bridge[0]), '网络必须在后台线程（同步等待会卡住整个 JS 桥）');
  assert.ok(/ServerList\.uploadCommunity\(MainActivity\.this, u, n\)/.test(bridge[0]), '必须复用 ServerList 的校验/上传实现');
  assert.ok(/window\.__SP_SHELL&&window\.__SP_SHELL\.onCommunityUpload&&/.test(bridge[0]),
    '结果必须回推 __SP_SHELL.onCommunityUpload（页面用事件接）');
  assert.ok(/if \("1"\.equals\(r\[0\]\)\) reloadServerList\(false, false\);/.test(bridge[0]),
    '上传成功后自动刷新清单（玩家不用手点）');
  // @JavascriptInterface 必须在方法上（Android 只暴露带注解的方法）
  const at = MAIN.indexOf('public void uploadCommunityServer');
  const before = MAIN.slice(Math.max(0, at - 260), at);
  assert.ok(/@JavascriptInterface\s*$/.test(before.trimEnd()), 'uploadCommunityServer 必须带 @JavascriptInterface');
});
