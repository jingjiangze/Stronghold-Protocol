// 两处 Java 侧接线的回归钉（业主 2026-10-13）：
//
//   ① 局域网扫描必须覆盖**虚拟组网**（蒲公英 / ZeroTier / Tailscale 这类异地组网）：它们在本机
//      是一条 VpnService 的 TUN 虚拟网卡，Android 上标准名 `tun0`。原实现把 `tun0`/`tap0` 列进
//      IGNORED_IFACES，等于把「同一虚拟局域网里的房主」整条排除在发现之外（IP 段闸门
//      LanNet.isPrivateIpv4 本来就放行 100.64/10 与 10/8，卡点只在网卡名）。安全边界不变：
//      地址仍须过 isPrivateIpv4，加入端仍只认 DISCOVERED 里真实探测到的端点。
//
//   ② 本机服务「要进入两次」的两个成因，各有对应的接线断言：
//      · 等待期没有可见反馈 —— awaitHostService 原来只写一个已被 hideLoading() 关掉的 TextView，
//        玩家侧看不到任何东西 → 再点一次（此时服务已热）→ 表现为「两次」。
//        2026-10-17 起改成**底部非阻塞进度条 + 真实数值**（见下面的新契约）。
//      · 冷启动预热：2026-10-13 的口径是「默认启动就启动 node 服务器」，2026-10-17 业主改回
//        **「node 服务可以进去后再启动」** —— 冷启动不得自动拉起 HostService（45 MB 解包 +
//        Node 三变体与首屏抢 IO）。下面的断言钉的是新契约：冷启动零预热、进入时才起。
//
// 纯源码级断言（不跑 Gradle / 模拟器）：这些是接线形状，形状断了就是静默回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const LAN_SCAN = read('android/app/src/main/java/icu/jiangjiangze/stronghold/LanScan.java');
const MAIN = read('android/app/src/main/java/icu/jiangjiangze/stronghold/MainActivity.java');

/** 取方法体（从签名行到下一个 4 空格缩进的 `}` 前）——只看代码。 */
function methodBody(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, '找不到方法：' + signature);
  const end = src.indexOf('\n    }', at);
  assert.ok(end > at, '找不到方法体结尾：' + signature);
  return src.slice(at, end);
}

/** IGNORED_IFACES 的构造实参（去掉注释后的字面量列表）。 */
function ignoredIfaces() {
  const at = LAN_SCAN.indexOf('IGNORED_IFACES = new HashSet<>(');
  assert.ok(at > 0, 'LanScan 里找不到 IGNORED_IFACES 构造');
  const seg = LAN_SCAN.slice(at, LAN_SCAN.indexOf('));', at));
  return (seg.match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
}

test('LanScan：虚拟组网网卡（tun0/tap0）不再被排除 —— 蒲公英这类异地组网必须能扫到', () => {
  const ignored = ignoredIfaces();
  assert.ok(!ignored.includes('tun0'), 'tun0 必须不在忽略表里（蒲公英/ZeroTier/Tailscale 的 TUN 网卡名）');
  assert.ok(!ignored.includes('tap0'), 'tap0 同上（TAP 形态的虚拟组网）');
  // 蜂窝仍按前缀排除（不是「局域网邻居」的所在网段）
  assert.ok(LAN_SCAN.includes('name.startsWith("rmnet")'), '蜂窝仍按前缀排除');
  // 回环必须继续排除
  assert.ok(ignored.includes('lo'), '回环仍在忽略表里');
  // 安全性未松：进入枚举的地址仍要过私网闸门
  assert.ok(LAN_SCAN.includes('if (!LanNet.isPrivateIpv4(a.getHostAddress())) continue;'),
    '地址仍须过 LanNet.isPrivateIpv4（公网地址一律拒绝）');
});

test('本机服务等待期不挡界面 + 有真实数值（业主 2026-10-17：「先让我进入界面」「加一个详细的数值」）', () => {
  const body = methodBody(MAIN, 'private void awaitHostService(String startText');
  // 全屏遮罩会把人锁在等待页上 —— 明确禁止
  assert.ok(!/showLoading\(\);/.test(body),
    'awaitHostService 不得再举全屏覆盖层（业主：本地资源释放在后台进行，不走这个页面）');
  assert.ok(/showHostBanner\(startText\);/.test(body), '等待期改用底部非阻塞进度条');
  // 对称收口：就绪 / 超时两路都要收掉进度条
  assert.ok(/hideHostBanner\(\);\s*\n\s*if \(ready\) onReady\.run\(\); else onTimeout\.run\(\);/.test(body),
    '就绪/超时两路都 hideHostBanner（进度条不能留在屏上）');
  // 文案必须是**实测数值**，不是按秒数编的阶段
  const text = methodBody(MAIN, 'private String hostProgressText(long elapsedSec)');
  assert.ok(/HostService\.materialiseProgress\(\)/.test(text), '解包进度取自 HostService.materialiseProgress()');
  assert.ok(/%/.test(text), '解包阶段给出百分比（玩家要能看出数字在动）');
  assert.ok(/elapsedSec/.test(text), 'Node 阶段给出已等秒数');
  // 进度条本身：只占一行、不吃触摸
  const build = methodBody(MAIN, 'private void buildHostBanner()');
  assert.ok(/setClickable\(false\)/.test(build), '进度条不拦截触摸');
  assert.ok(/setVisibility\(View\.GONE\)/.test(build), '默认隐藏（只在等待期出现）');
  // showLoading 仍存在（开场结束后的「页面还没加载完」那条路还在用它）
  const show = methodBody(MAIN, 'private void showLoading()');
  assert.ok(/loading\.setVisibility\(View\.VISIBLE\)/.test(show), 'showLoading 真的把覆盖层设为 VISIBLE');
});

test('冷启动不预热 Node（业主 2026-10-17：「node 服务可以进去后再启动」）', () => {
  // 冷启动路径里不能再有任何 startHostWarm 的自动触发：2.5 s 定时器与首界面 warmHost 都要删掉。
  assert.ok(!/main\.postDelayed\(\(\) -> startHostWarm\(\), 2500\);/.test(MAIN),
    '冷启动不得再无条件预热 Node（45 MB 解包 + Node 三变体与首屏抢 IO）');
  assert.ok(!/startHostWarm\(\)/.test(MAIN.split('private void startHostWarm')[0]),
    'startHostWarm 只能由玩家显式进入本机服务的路径调用，冷启动线程里不得出现');
  // 进入本机服务的入口仍然存在（node 由它按需启动）
  assert.ok(/private void ensureHostAndSwitch\(final boolean fallback\)/.test(MAIN),
    'ensureHostAndSwitch 仍在（玩家点「本机服务」→ awaitHostService → 起 Node）');
  assert.ok(/awaitHostService\("正在启动离线服务…"/.test(MAIN),
    'ensureHostAndSwitch 仍走 awaitHostService（自适应等待窗兜住冷启动解包）');
});

test('首界面不再调 warmHost（叠加层侧）', () => {
  const src = fs.readFileSync(path.join(here, 'extras', 'public', 'js', 'first-screen.js'), 'utf-8');
  assert.ok(!/shell\.warmHost\(\)/.test(src), 'first-screen 不得在首界面挂载时预热 Node');
});
