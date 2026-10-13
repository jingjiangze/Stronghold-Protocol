// 两处 Java 侧接线的回归钉（业主 2026-10-13）：
//
//   ① 局域网扫描必须覆盖**虚拟组网**（蒲公英 / ZeroTier / Tailscale 这类异地组网）：它们在本机
//      是一条 VpnService 的 TUN 虚拟网卡，Android 上标准名 `tun0`。原实现把 `tun0`/`tap0` 列进
//      IGNORED_IFACES，等于把「同一虚拟局域网里的房主」整条排除在发现之外（IP 段闸门
//      LanNet.isPrivateIpv4 本来就放行 100.64/10 与 10/8，卡点只在网卡名）。安全边界不变：
//      地址仍须过 isPrivateIpv4，加入端仍只认 DISCOVERED 里真实探测到的端点。
//
//   ② 本机服务「要进入两次」的两个成因，各有对应的接线断言：
//      · 等待期没有可见反馈 —— awaitHostService 只写一个已被 hideLoading() 关掉的 TextView，
//        玩家侧看不到任何东西 → 再点一次（此时服务已热）→ 表现为「两次」。修法是等待期把覆盖层
//        显回来（showLoading()），与 hideLoading() 对称。
//      · 冷启动预热被 bootLine 是远端服的设备整条跳过 —— 那类设备点「本机服务」是彻底冷启动。
//        业主口径「默认启动就启动 node 服务器」⇒ 无条件预热。
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

test('本机服务等待期有可见反馈：awaitHostService 先把覆盖层显回来（否则「点了没反应」）', () => {
  const body = methodBody(MAIN, 'private void awaitHostService(String startText');
  assert.ok(/showLoading\(\);/.test(body), 'awaitHostService 必须调 showLoading()');
  assert.ok(body.indexOf('showLoading();') < body.indexOf('setLoadingText(startText)'),
    '先显覆盖层再写文案（顺序反了会先写进不可见控件）');
  // 对称收口：就绪 / 超时两路都要 hideLoading
  assert.ok(/hideLoading\(\);\s*\n\s*if \(ready\) onReady\.run\(\); else onTimeout\.run\(\);/.test(body),
    '就绪/超时两路都 hideLoading（覆盖层不能留在屏上）');
  // showLoading 本身存在且只改可见性
  const show = methodBody(MAIN, 'private void showLoading()');
  assert.ok(/loading\.setVisibility\(View\.VISIBLE\)/.test(show), 'showLoading 真的把覆盖层设为 VISIBLE');
});

test('冷启动无条件预热 Node（业主「默认启动就启动 node 服务器」），且不抢首帧', () => {
  // 预热调用必须存在
  assert.ok(/main\.postDelayed\(\(\) -> startHostWarm\(\), 2500\);/.test(MAIN),
    '首帧后无条件预热（推迟 2.5s，不抢首帧）');
  // 旧的 remoteLine 跳过分支必须已删除（否则「上次玩过线上」的设备又是冷启动 → 进入两次）
  const bootAt = MAIN.indexOf('main.postDelayed(() -> startHostWarm(), 2500);');
  const seg = MAIN.slice(Math.max(0, bootAt - 1600), bootAt);
  assert.ok(!/if \(!remoteLine\) startHostWarm\(\);/.test(seg), 'remoteLine 跳过预热的分支必须已移除');
  assert.ok(!/final boolean remoteLine =/.test(seg), 'remoteLine 变量不该再出现在这段接线里');
  // 与「不抢首帧」不冲突：预热排在导航（applyOrigin/loadBase）之后
  const navAt = Math.max(seg.lastIndexOf('applyOrigin('), seg.lastIndexOf('loadBase('));
  assert.ok(navAt > 0 && navAt < seg.length, '导航先发生，预热在其后（不抢首帧）');
});
