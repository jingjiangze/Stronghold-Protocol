// check-webroot-boot.mjs — 组装后的 webroot 必须真的能 boot（CI 步骤，build-webroot 之后立刻跑）。
//
//   node tools/apk/check-webroot-boot.mjs
//
// WHY（2026-10-18 实测）：0.3.1 起服务端运行期 import '../../public/js/…'（fxAssets/contentData/
// fxRecords/operatorTraits/studio 全家），扁平 webroot 顶层循环把 public/* 摊平到根，但这两个
// 相对路径解析到 <webroot>/public/js —— 顶层循环顶不到。vc2046/vc2047 的 CI 包就缺这份嵌套子树：
// 从包内 webroot 删掉 public/ 后实测 `import('server/index.js')` 直接
// ERR_MODULE_NOT_FOUND，手机上表现为「离线服务 60 秒没起来」。当时没有任何门禁能红 ——
// 素材门/覆盖门/补丁门都不看服务端模块图。这个脚本补的就是这条能力：
//   ① 静态：扫出厂源码里所有 `'(\.\./)+public/…'` 字面引用，逐个解析到 webroot 上断言存在
//      （指名道姓，报错直接说缺哪个文件、哪个 import 引的）；
//   ② 动态：真的 import() 一遍 server/index.js（上游有 isMain 门，不会监听端口），
//      把整条模块图走通 —— 上游再加 ../../public 引用时①可能漏词表，②一定漏不掉。
// 两道都过才绿；任何一道红都禁止继续打 APK。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const webroot = path.join(repo, 'android', 'app', 'src', 'main', 'assets', 'webroot');

function fail(msg) {
  console.error(`check-webroot-boot: FAIL — ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(webroot, 'index.html'))) fail(`no assembled webroot at ${webroot} (run build-webroot first)`);

// ---- ① 静态引用扫描 ---------------------------------------------------------------
// server/ 里所有指向 public/ 的相对路径字面量（import / new URL / readFileSync 都算）：
// 素材引用（../public/assets/…）是 fs.readFileSync + try/catch 的**可选**路径（本地解包文件，
// 上游注释明写 optional），所以只钉**模块解析**级的：出现在 import/from/new URL 里的才算硬依赖。
// 多行 import（`import {\n a,\n b } from '…'`）也要抓住：[^;] 可以跨行，语句以分号/文件边界断开。
const HARD = /(?:import|export)[^;]*?from\s+['"]((?:\.\.\/)+public\/[^'"]+)['"]|await\s+import\(\s*['"]((?:\.\.\/)+public\/[^'"]+)['"]|new URL\(\s*['"]((?:\.\.\/)+public\/[^'"]+)['"]/g;

const serverDir = path.join(webroot, 'server');
if (!fs.existsSync(serverDir)) fail('webroot has no server/ — nothing was assembled');
const refs = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!name.endsWith('.js')) continue;
    const text = fs.readFileSync(p, 'utf8');
    let m;
    HARD.lastIndex = 0;
    while ((m = HARD.exec(text))) {
      const rel = m[1] || m[2] || m[3];
      refs.push({ from: path.relative(webroot, p), rel });
    }
  }
})(serverDir);

const missing = [];
for (const r of refs) {
  // 相对路径按**引用所在文件的目录**解析（ESM 语义）：server/plugins/x.js 的 '../../public/js'
  // 落在 webroot 根的 public/js；server/studio/templates/y.js 用的是 '../../../public/…'。
  const abs = path.resolve(path.dirname(path.join(webroot, r.from)), r.rel);
  if (!fs.existsSync(abs)) missing.push(`${r.from} → ${r.rel}`);
}
if (missing.length) {
  fail(`${missing.length} hard public/ import(s) unresolvable in the webroot:\n  ${missing.join('\n  ')}`
    + '\n→ build-webroot 的嵌套 public/ 拷贝清单缺项（对照 refs 词表加目录）。');
}
console.log(`check-webroot-boot: static gate — ${refs.length} public/ imports resolve`);

// ---- ② 裸包依赖（静态）：所有非 node:/相对/绝对 的 from+import() 说明符必须装在 webroot 里 ------
// 设备上的 webroot 活在 filesDir 下，Node 向上找不到任何父 node_modules；本机/仓库里却会解析到
// 仓库根的 node_modules（acorn 事故就是这么躲过本地验证的，CI run 39116125757 才红）。
// 所以这一遍完全不信解析结果，逐字面量对照 webroot/node_modules。
// 只认真语法：行首的 import/export ... from 'pkg'、import 'pkg'（副作用）、import('pkg')。
// （CI run 39126216756 的教训：宽正则把 Buffer.from('IHDR') 与注释里的 "comes from ('none'"
//  当成了 import —— 门禁必须只吃语法上真的是模块说明符的位置。）
const BARE_FORMS = [
  /^[ \t]*(?:import|export)\b[^;\n]*?\bfrom[ \t]+['"]([^'"]+)['"]/gm, // import x from 'pkg' / export {a} from 'pkg'
  /^[ \t]*import[ \t]+['"]([^'"]+)['"]/gm, // 副作用 import 'pkg'
  /\bimport[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/g, // 动态 import('pkg')
];
const installed = new Set(fs.existsSync(path.join(webroot, 'node_modules')) ? fs.readdirSync(path.join(webroot, 'node_modules')) : []);
const bareRefs = new Map(); // pkg -> Set(from files)
(function walk2(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk2(p); continue; }
    if (!name.endsWith('.js')) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const re of BARE_FORMS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const spec = m[1];
        if (spec.startsWith('node:') || spec.startsWith('file:') || spec.startsWith('data:')
          || spec.startsWith('/') || /^\.{1,2}\//.test(spec)) continue;
        if (path.isAbsolute(spec)) continue;
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!bareRefs.has(pkg)) bareRefs.set(pkg, new Set());
        bareRefs.get(pkg).add(path.relative(webroot, p));
      }
    }
  }
})(serverDir);
const notInstalled = [...bareRefs.keys()].filter((pkg) => !installed.has(pkg) && pkg !== 'ses');
if (notInstalled.length) {
  fail(`bare package import(s) not installed under webroot/node_modules — on-device boot dies before /healthz:\n  `
    + notInstalled.map((p) => `${p} ← ${[...bareRefs.get(p)].join(', ')}`).join('\n')
    + '\n→ 加进 build-webroot 的宿主临时 manifest（ses 例外：惰性沙箱探测，允许缺）。');
}
console.log(`check-webroot-boot: bare-dep gate — ${[...bareRefs.keys()].join(', ')} all installed (ses exempt: lazy)`);

// ---- ③ 动态 boot（整条模块图） ------------------------------------------------------
// startServer 不跑（isMain 门），但所有静态 import + registry 构建链都会执行；
// 缺 ../../public/js 时这一步抛 ERR_MODULE_NOT_FOUND —— 正是 vc2046/vc2047 包的死法。
const entry = pathToFileURL(path.join(webroot, 'server', 'index.js')).href;
try {
  const mod = await import(entry);
  if (typeof mod.startServer !== 'function') fail('server/index.js imported but has no startServer export');
} catch (e) {
  fail(`import(server/index.js) threw: ${String(e && e.message || e).slice(0, 400)}`);
}
console.log('check-webroot-boot: boot gate — server/index.js module graph imports clean');
