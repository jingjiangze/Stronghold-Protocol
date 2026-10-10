// 冷启动默认线路（业主口径 2026-10-10：「开屏进入后默认首页为单人服务器」）的接线测试。
//
// 纯决策在 StartupOriginPolicy，由 JVM 门禁逐条覆盖（tools/apk/jvm/run-startup-origin-check.sh）：
//   ① 无显式选择 → 默认 local；② 有显式选择（含 auto）→ 尊重；③ 老装机（只有旧 origin 值、
//   没有来源标记）→ 视为「已选择过」。这里钉 Java 侧的**接线形状**：nullable 判据、默认分支、
//   失败兜底与一次性持久化模式 —— 任何一半缺失，失败都是静默的（退化成旧行为 / 带死端口 / 死页）。
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

test('判据：origin 键必须 nullable 读（默认值 "auto" 会把「没选过」和「选了 auto」混成同一件事）', () => {
  assert.ok(JAVA.includes('StartupOriginPolicy.resolveStartupOrigin(prefs.getString("origin", null))'),
    '开屏判据必须走纯决策表 StartupOriginPolicy，且 origin 读法必须是 getString("origin", null)');
  assert.ok(!JAVA.includes('getString("origin", "auto")'),
    '旧读法（默认 "auto"）不许回来：它让「从未选择」与「显式选 auto」不可区分，新默认永远不触发');
});

test('默认分支：从未选择 → 单人服务器（本机服务），成功持久化符号值 "local"', () => {
  // 开屏分支：从未选择走单人服务器；已选择的一条路保持逐字旧行为（loadBase(origin)）。
  assert.match(JAVA, /if \(singlePlayerBoot\)\s*\{\s*bootSinglePlayerDefault\(\);\s*\} else \{\s*loadBase\(origin\);/,
    '开屏必须按 singlePlayerBoot 分流：默认坐本机服务，已选择走 loadBase(origin)');
  const body = methodBody(JAVA, 'private void bootSinglePlayerDefault()');
  assert.ok(body.includes('applyOrigin("http://127.0.0.1:" + HostService.PORT'),
    '单人服务器落地必须切到本机服务 origin（127.0.0.1:真实端口）');
  assert.match(body, /applyOrigin\("http:\/\/127\.0\.0\.1:" \+ HostService\.PORT,\s*StartupOriginPolicy\.PERSIST_LOCAL\)/,
    '成功落地必须持久化符号值 "local"（不固化 127.0.0.1:PORT —— 端口是 OS 随机分配的临时目标）');
  // 写盘值统一经过纯函数（失败兜底 "auto"、单人默认 "local"、显式切服具体地址）。
  assert.ok(JAVA.includes('StartupOriginPolicy.persistedValue(persistMode, baseOnly)'),
    'loadBase 的 origin 写盘必须走 StartupOriginPolicy.persistedValue');
});

test('失败兜底：本机服务起不来 → 内置自动线路（持久化 "auto"），不是死页、不是 local', () => {
  const body = methodBody(JAVA, 'private void bootSinglePlayerDefault()');
  assert.match(body, /applyOrigin\(BuildConfig\.DEFAULT_ORIGIN, StartupOriginPolicy\.PERSIST_AUTO\)/,
    '起不来必须退回内置线路并持久化 "auto"（下次冷启动不再等一个起不来的服务）');
  assert.ok(!body.includes('showHostStartupDiagnostic'),
    '默认路径不许只弹「启动慢」诊断对话框（那是显式入口的 UX）——必须自己兜到远端');
  assert.ok(!/applyOrigin\("http:\/\/127\.0\.0\.1:" \+ HostService\.PORT,\s*StartupOriginPolicy\.PERSIST_AUTO\)/.test(body),
    '失败兜底不许把结果固化成任何本地服务状态（127.0.0.1 只配 PERSIST_LOCAL 的符号写盘）');
  assert.ok(GRADLE.includes("buildConfigField 'String', 'DEFAULT_ORIGIN', '\"https://stronghold.jiangjiangze.icu\"'"),
    'BuildConfig.DEFAULT_ORIGIN 必须仍是内置国际线路（auto 兜底/auto 冷启动的目标，不许漂移）');
});

test('已选择 / 老装机：auto 的既有语义不变（内置线路直达，不探测），其余值逐字使用', () => {
  assert.match(JAVA, /StartupOriginPolicy\.AUTO\.equals\(bootLine\) \? BuildConfig\.DEFAULT_ORIGIN : bootLine/,
    'auto → BuildConfig.DEFAULT_ORIGIN（开屏不探测，业主 2026-10-09），其余值逐字加载');
  // 决策本体（① ② ③）在纯函数里；这里钉住符号值域防止 MainActivity 另写一份字符串比较。
  assert.ok(POLICY.includes('public static final String LOCAL = "local"')
    && POLICY.includes('public static final String AUTO = "auto"'),
    '符号值必须来自 StartupOriginPolicy（单一真源）');
  assert.ok(POLICY.includes('public static String resolveStartupOrigin(String savedOrigin)'),
    'resolveStartupOrigin 缺失（判据被搬进 Android 层就不可 JVM 测了）');
});
