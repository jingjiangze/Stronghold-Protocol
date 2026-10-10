// 冷启动默认线路的接线测试。业主口径（2026-10-10 审计修正后）：「默认打开必须是本地服务，
// 老值不得被当成用户选择」——升级机（有旧 origin、没有来源标记）的首次冷启动必须进单人服务器。
//
// 纯决策在 StartupOriginPolicy，由 JVM 门禁逐条覆盖（tools/apk/jvm/run-startup-origin-check.sh）：
//   ① 没有「用户选择」标记（origin null/空、老装机遗留值、失败兜底写的 auto）→ 默认 local；
//   ② 标记 originSource=user → 逐字尊重；③ 失败兜底写 auto 但不标记 → 下次仍优先本机服务；
//   ④ 显式切服 → 写标记。这里钉 Java 侧的**接线形状**：两键读法（origin + originSource）、
//   默认分支、失败兜底、一次性持久化模式与标记写/删 —— 任何一半缺失，失败都是静默的
//   （退化成旧行为 / 老值被当作用户选择 / 带死端口 / 死页 / 一次失败把设备钉在远端）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const JAVA = read('android/app/src/main/java/icu/jiangjiangze/stronghold/MainActivity.java');
const POLICY = read('android/app/src/main/java/icu/jiangjiangze/stronghold/StartupOriginPolicy.java');
const GRADLE = read('android/app/build.gradle');

/** 取方法体（从签名行到下一个同名缩进的 `}` 前）——只看代码，注释里的旧名不算。 */
function methodBody(src, signature) {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, '找不到方法：' + signature);
  const end = src.indexOf('\n    }', at);
  assert.ok(end > at, '找不到方法体结尾：' + signature);
  return src.slice(at, end);
}

test('判据：启动必须读 origin + originSource 两键，来源标记缺失 = 未选择（老值不得被当成用户选择）', () => {
  // 2026-10-10 审计：上一版把「origin 键写过」当成「用户选择过」，升级机（旧版本冷启动写过
  // auto/URL）因此被判成显式选择 → 默认进远端。修正：只认 originSource=user 标记。
  assert.match(JAVA, /final String savedOrigin = prefs\.getString\(StartupOriginPolicy\.PREF_ORIGIN, null\);/,
    '开屏必须 nullable 读 origin（getString(PREF_ORIGIN, null)：无默认值）');
  assert.match(JAVA, /final String savedSource = prefs\.getString\(StartupOriginPolicy\.PREF_SOURCE, null\);/,
    '开屏必须 nullable 读 originSource（来源标记：缺失 = 未选择）');
  assert.match(JAVA, /String bootLine = StartupOriginPolicy\.resolveStartupOrigin\(savedOrigin, savedSource\);/,
    '开屏判据必须把 origin 与 originSource 一起交给纯决策表 StartupOriginPolicy');
  const calls = JAVA.match(/resolveStartupOrigin\(/g) || [];
  assert.equal(calls.length, 1, '启动判据只许有一处调用点（两参、带来源标记那条）');
  assert.ok(!JAVA.includes('resolveStartupOrigin(prefs.getString("origin", null))'),
    '一参旧判据不许回来：它没有来源标记，任何老装机遗留值都会被当成用户选择（业主的设备就是这种）');
  assert.ok(!JAVA.includes('getString("origin", "auto")'),
    '旧读法（默认 "auto"）不许回来：它让「从未选择」与「显式选 auto」不可区分');
  // 判据本体在纯函数里：第一道门就是来源标记（不是 origin 值有没有被写过）。
  assert.match(POLICY, /if \(!SOURCE_USER\.equals\(savedSource\)\) return LOCAL;/,
    '纯决策表必须只信 SOURCE_USER 标记：没有标记一律 LOCAL（本机服务）');
});

test('默认分支：未选择 → 单人服务器（本机服务），成功持久化符号值 "local" 且不写用户标记', () => {
  // 开屏分支：未选择走单人服务器；有用户标记的一条路保持逐字旧行为（loadBase(origin)）。
  assert.match(JAVA, /if \(singlePlayerBoot\)\s*\{\s*bootSinglePlayerDefault\(\);\s*\} else \{\s*loadBase\(origin\);/,
    '开屏必须按 singlePlayerBoot 分流：默认坐本机服务，有用户选择标记的走 loadBase(origin)');
  const body = methodBody(JAVA, 'private void bootSinglePlayerDefault()');
  assert.ok(body.includes('applyOrigin("http://127.0.0.1:" + HostService.PORT'),
    '单人服务器落地必须切到本机服务 origin（127.0.0.1:真实端口）');
  assert.match(body, /applyOrigin\("http:\/\/127\.0\.0\.1:" \+ HostService\.PORT,\s*StartupOriginPolicy\.PERSIST_BOOT_LOCAL\)/,
    '成功落地必须用 PERSIST_BOOT_LOCAL：写符号值 "local"（不固化 127.0.0.1:PORT）且**不带**用户标记'
    + '（系统的默认行为不伪装成用户的选择；下次冷启动仍按未选择判据 → 仍进本机服务）');
  // 写盘值统一经过纯函数（失败兜底/用户 auto、本机服务、显式切服）。
  assert.ok(JAVA.includes('StartupOriginPolicy.persistedValue(persistMode, baseOnly)'),
    'loadBase 的 origin 写盘必须走 StartupOriginPolicy.persistedValue');
});

test('失败兜底：本机服务起不来 → 内置自动线路（持久化 "auto"、清除标记），不是死页、不钉远端', () => {
  const body = methodBody(JAVA, 'private void bootSinglePlayerDefault()');
  assert.match(body, /applyOrigin\(BuildConfig\.DEFAULT_ORIGIN, StartupOriginPolicy\.PERSIST_AUTO\)/,
    '起不来必须退回内置线路并持久化 "auto"（不写用户标记：下次冷启动仍优先尝试本机服务）');
  assert.ok(!body.includes('showHostStartupDiagnostic'),
    '默认路径不许只弹「启动慢」诊断对话框（那是显式入口的 UX）——必须自己兜到远端');
  // 「下次冷启动仍优先本机服务」的铁律：失败兜底写下的 "auto" 不带标记（纯决策表：PERSIST_AUTO
  // 不在写 SOURCE_USER 的那一支；JVM 门禁再做行为级验证）。
  const sourceBody = methodBody(POLICY, 'public static String persistedSource(String persistMode)');
  const flat = sourceBody.replace(/\s+/g, ' ');
  assert.ok(flat.includes('if (PERSIST_CONCRETE.equals(persistMode) || PERSIST_LOCAL.equals(persistMode) || PERSIST_AUTO_USER.equals(persistMode)) return SOURCE_USER;'),
    'persistedSource 只许对显式切服/显式本机服务/显式 auto 三个模式写 SOURCE_USER（其余一律 null=删标记）');
  assert.ok(flat.includes('return null;'),
    'persistedSource 必须对失败兜底（PERSIST_AUTO）与冷启动默认（PERSIST_BOOT_LOCAL）返回 null');
  assert.ok(GRADLE.includes("buildConfigField 'String', 'DEFAULT_ORIGIN', '\"https://stronghold.jiangjiangze.icu\"'"),
    'BuildConfig.DEFAULT_ORIGIN 必须仍是内置国际线路（auto 兜底/auto 冷启动的目标，不许漂移）');
});

test('显式选择 / 去标记：用户标记只有显式切服写，冷启动默认与失败兜底都删', () => {
  // 标记的删除发生在 loadBase 的写盘：persistedSource 为 null（非用户选择）→ remove。
  const loadBody = methodBody(JAVA, 'private void loadBase(String base)');
  assert.ok(loadBody.includes('StartupOriginPolicy.persistedValue(persistMode, baseOnly)'),
    'loadBase 的写盘值必须走 persistedValue');
  assert.ok(loadBody.includes('StartupOriginPolicy.persistedSource(persistMode)'),
    'loadBase 的来源标记必须走 persistedSource');
  assert.match(loadBody, /if \(source == null\) ed\.remove\(StartupOriginPolicy\.PREF_SOURCE\);/,
    '非用户选择（冷启动默认/失败兜底/KEEP）必须**删除**来源标记，否则下次冷启动会被自己的兜底值骗到远端');
  // 显式路径的标记来源（纯决策表）：CONCRETE / LOCAL / AUTO_USER 写 user，其余 null（见上一测）。
  assert.ok(POLICY.includes('PERSIST_BOOT_LOCAL = "boot-local"'),
    '冷启动默认必须有独立的持久化模式（PERSIST_BOOT_LOCAL ≠ PERSIST_LOCAL：默认不写用户标记）');
  // 显式进本机服务不固化随机端口：ensureHostAndSwitch 的显式分支必须是 PERSIST_LOCAL。
  const persistForBody = methodBody(JAVA, 'private static String persistFor(boolean fallback)');
  assert.match(persistForBody, /fallback \? StartupOriginPolicy\.PERSIST_AUTO : StartupOriginPolicy\.PERSIST_LOCAL/,
    '显式进本机服务必须写符号值 "local"+用户标记（PERSIST_LOCAL），失败兜底写 "auto" 且不标记（PERSIST_AUTO）');
  // 面板「自动线路」是一条用户显式选择：立刻把 auto + 用户标记落盘（探测完成前被杀也不丢选择）。
  assert.ok(!JAVA.includes('prefs.edit().putString("origin", "auto").apply()'),
    '裸写 origin="auto"（无标记）不许回来：那会把用户显式选的自动线路降级成「未选择」');
  assert.match(JAVA,
    /putString\(StartupOriginPolicy\.PREF_ORIGIN, StartupOriginPolicy\.AUTO\)\s*\.putString\(StartupOriginPolicy\.PREF_SOURCE, StartupOriginPolicy\.SOURCE_USER\)/,
    'setServer("auto") 必须同时落盘 auto 与用户标记（StartupOriginPolicy.SOURCE_USER）');
  // 重启房主服务后的 reload 不是选择：不写盘、不动标记。
  assert.match(JAVA, /persistMode = StartupOriginPolicy\.PERSIST_KEEP;[\s\S]{0,160}?loadBase\(origin\);/,
    'restartHostService 的重载必须走 PERSIST_KEEP（不写盘、不动标记、不固化随机端口）');
});

test('纯决策表符号与目标：auto 的既有语义不变（内置线路直达，不探测）', () => {
  assert.match(JAVA, /StartupOriginPolicy\.AUTO\.equals\(bootLine\) \? BuildConfig\.DEFAULT_ORIGIN : bootLine/,
    'auto → BuildConfig.DEFAULT_ORIGIN（开屏不探测，业主 2026-10-09），其余值逐字加载');
  // 决策本体（① ② ③ ④）在纯函数里；这里钉住符号值域防止 MainActivity 另写一份字符串比较。
  assert.ok(POLICY.includes('public static final String LOCAL = "local"')
    && POLICY.includes('public static final String AUTO = "auto"')
    && POLICY.includes('public static final String SOURCE_USER = "user"'),
    '符号值（local/auto/user）必须来自 StartupOriginPolicy（单一真源）');
  assert.ok(POLICY.includes('public static String resolveStartupOrigin(String savedOrigin, String savedSource)'),
    '两参 resolveStartupOrigin 缺失（判据被搬进 Android 层或退回「写过即选择」就不可 JVM 测了）');
  assert.ok(POLICY.includes('public static final String PREF_ORIGIN = "origin"')
    && POLICY.includes('public static final String PREF_SOURCE = "originSource"'),
    '两键（origin + originSource）必须是单一真源（键名漂移 = 老装机被误判成用户选择）');
});
