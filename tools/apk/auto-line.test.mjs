// 自动线路「优先取网页清单第一个服务器」的口径测试（业主 2026-10-08 规则二）。
//
// 数据面（2026-10-08 实测核验）：
//   • 网页 dl.jiangjiangze.icu/servers 的脚本 js/servers.js 读的是
//     https://weishucdn.jiangjiangze.icu/site/servers.json（热副本）→ ./data/servers.json（回退），
//     都是 JSON（fetch + accept:application/json），不是 HTML 抓取；
//   • 根路径 https://dl.jiangjiangze.icu/servers.json 与两者逐字节相同（cmp 验证，updated
//     2026-10-07T10:38:47Z，servers[0] = { id:'xiaolubao', url:'https://game.xiaolubao.com',
//     probe:'/healthz', enabled:true }）→ 第一来源用根路径这个稳定别名，R2 副本作第二来源。
// 自动线路真正在 Java 侧解析（冷启动 + 面板点「自动线路」的 setServer("auto") 都汇到
// MainActivity.probeBestLine），所以本测试锁 Java 源码的**决策顺序与回退** + extras 侧的话术。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const MAIN = read('android/app/src/main/java/icu/jiangjiangze/stronghold/MainActivity.java');
const PANELS = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'ui', 'shellPanels.js'), 'utf8');

/** 取方法体（从签名行到下一个同级方法注释/声明前）——只看代码，注释里的旧名/说明不算。 */
function methodBody(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, '找不到方法：' + signature);
  const rest = src.slice(at + signature.length);
  // 方法体结束：行首 4 空格 + } （类内方法层级）
  const end = rest.indexOf('\n    }');
  assert.ok(end > 0, '找不到方法体结尾：' + signature);
  return rest.slice(0, end);
}

test('Java：自动线路先试网页清单第一个服务器，缺席/不可达才回落延迟排名', () => {
  const probe = methodBody(MAIN, 'private String probeBestLine()');
  const webCall = probe.indexOf('probeWebListFirst()');
  const ranking = probe.indexOf('lineOrigins().toArray');
  assert.ok(webCall >= 0, 'probeBestLine 必须调用 probeWebListFirst()');
  assert.ok(ranking > webCall, '清单首选必须在「版本+延迟」排名之前');
  assert.ok(/if \(webFirst != null\) return webFirst;/.test(probe), '命中即刻返回（优先于排名）；null → 继续排名 = 回退');

  const web = methodBody(MAIN, 'private String probeWebListFirst()');
  assert.ok(web.includes('firstServerOf(fetchAutoListJson(src))'), '按 AUTO_LIST_SOURCES 顺序取第一个可解析来源');
  assert.ok(web.includes('probeLine(url, probe).rttMs > 0'), '必定实测可达才采用（不可达 → null → 回退）');
  assert.ok(web.includes('AUTO_LIST_TTL_MS'), '清单本体有短缓存（不打风暴）');

  const first = methodBody(MAIN, 'private static WebPick firstServerOf(String json)');
  assert.ok(first.includes('optJSONObject(0)'), '只认 servers[0]（清单顺序就是业主口径）');
  assert.ok(first.includes("optBoolean(\"enabled\", true)"), 'enabled=false 视为缺席（回退，而不是用停用服务器）');
  assert.ok(first.includes('isAutoTargetUrl(url)'), 'servers[0].url 必须过 https+公网主机校验');

  // 第一来源 = 实测核验过的网页清单数据（根路径别名）；第二来源 = 页面脚本读的 R2 热副本。
  const sources = /AUTO_LIST_SOURCES = \{([\s\S]*?)\};/.exec(MAIN);
  assert.ok(sources, 'AUTO_LIST_SOURCES 必须存在');
  const urls = [...sources[1].matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(urls, [
    'https://dl.jiangjiangze.icu/servers.json',
    'https://weishucdn.jiangjiangze.icu/site/servers.json',
  ]);
});

test('Java：新拉取的安全约束（https、主机白名单、不跟重定向、超时、体积上限、拒私网）', () => {
  const fetch = methodBody(MAIN, 'private static String fetchAutoListJson(String url)');
  assert.ok(fetch.includes('"https".equalsIgnoreCase(u.getProtocol())'), 'https only');
  assert.ok(fetch.includes('AUTO_LIST_HOSTS.contains(host)'), '主机白名单（不接受清单里的任意 URL）');
  assert.ok(fetch.includes('setInstanceFollowRedirects(false)'), '不跟随重定向（含跨主机）');
  assert.ok(fetch.includes('AUTO_LIST_TIMEOUT_MS'), '短超时');
  assert.ok(fetch.includes('AUTO_LIST_MAX_BYTES'), '体积上限');
  const target = methodBody(MAIN, 'private static boolean isAutoTargetUrl(String url)');
  assert.ok(target.includes('startsWith("https://")'), '目标必须 https');
  assert.ok(target.includes('ServerList.isPublicHttpUrl(url)'), '目标必须公网主机（回环/私有/保留全表拒斥）');
});

test('extras：自动线路的话术与切服接线（App 内交给 Java；网页=当前页）', () => {
  assert.ok(PANELS.includes("{ key: 'auto', id: 'auto', name: '自动线路', note: '清单首选'"),
    'QuickModes 的自动线路格子要标明「清单首选」口径');
  assert.ok(PANELS.includes('优先取网页服务器清单（dl.jiangjiangze.icu/servers）的第一个服务器'),
    '服务器面板说明必须写明优先取网页清单第一个服务器');
  assert.ok(PANELS.includes('不可达时按实测延迟选最优'), '回退口径必须写明');
  // 切服仍然只有一条路：native → window.shell.setServer(row.id)（'auto' 由 Java 解析）
  assert.ok(PANELS.includes('window.shell.setServer(row.id)'), 'QuickModes/服务器面板共用的 switchTo 必须转交原生');
});
