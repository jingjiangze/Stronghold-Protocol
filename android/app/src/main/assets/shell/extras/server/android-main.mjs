// android-main.mjs — the dedicated Node entry for the Android shell (v2.7.5, P0 fix).
//
// WHY THIS EXISTS: upstream server/index.js gates its startup behind isMain(), which compares
// process.argv[1] against the module URL. Under the shell's launcher (libnode.so -e <bootstrap>
// → dynamic import) argv[1] is undefined, so isMain() is ALWAYS false and main() never ran —
// the Node process started, imported, and exited immediately. The offline host has therefore
// never actually served (verified locally: node -e import → isMain=false).
//
// This entry bypasses that gate by calling the EXPORTED startServer() directly — the same
// programmatic API the upstream tests use (server/index.js:25). Upstream source stays untouched.
//
// Flow: read launch.json (written by NodeRunner) → startServer(port=0, host) → poll /healthz →
// write handshake.json (real port + pid) → graceful SIGTERM. All variable config comes from the
// launch file, so the Java-side argv stays fully literal (shell security-scanner compliant).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadOverlays } from './overlay-loader.mjs';

const LAUNCH_PATH = '/data/user/0/icu.jiangjiangze.stronghold/files/run/launch.json';

async function main() {
  const launch = JSON.parse(fs.readFileSync(LAUNCH_PATH, 'utf8'));
  const env = launch.env || {};
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

  // launch.upstreamEntry = server/index.js (the upstream module, untouched); launch.entry is THIS
  // file — the bootstrap imports us, we import the upstream startServer() export directly.
  const upstream = launch.upstreamEntry || launch.entry;
  const { startServer } = await import('file://' + upstream);

  // port 0 → the OS picks a free port: no EADDRINUSE failure mode, no stale-port guessing.
  // HOST comes from HostParams ('::' dual-stack by default so LAN/ZeroTier/IPv6 direct still work).
  const preferred = Number(env.PORT || 0) || 0;
  const srv = await startServer({
    port: 0,
    host: env.HOST || '::',
    quiet: true,
  });

  // health evidence before declaring READY
  const health = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/healthz', timeout: 4000 }, (r) => {
      r.resume();
      resolve(r.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  // room presence (v2.7.2 hook lived inside upstream main(), which never ran under `-e`;
  // the Android entry mounts it explicitly so phone-host rooms join the discovery plane)
  if (env.SP_DIR_URL && env.SP_SERVER_ID) {
    import('file://' + path.join(path.dirname(upstream), 'room-discovery.mjs'))
      .then((m) => m.startPresence({ lobby: srv.lobby }))
      .catch((e) => console.error('[presence] init failed', e));
  }

  // overlay loading point (v2.8.0): server/overlay/*.mjs — additive modules that ride the L1
  // slim (no APK rebuild). Broken/mismatched overlays are logged and skipped, never fatal.
  const overlays = await loadOverlays({
    server: srv,
    port: srv.port,
    host: srv.host,
    url: srv.url,
    upstreamDir: path.dirname(upstream),
    log: (m) => console.log(m),
  });

  const handshake = {
    ok: health,
    port: srv.port,
    url: srv.url,
    host: srv.host,
    health: health ? 200 : 0,
    pid: process.pid,
    overlays: overlays.loaded,
    ts: Date.now(),
  };
  const handshakePath = launch.handshake || path.join(path.dirname(LAUNCH_PATH), 'handshake.json');
  const tmp = handshakePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(handshake));
  fs.renameSync(tmp, handshakePath); // atomic: Java polls for a complete file

  console.log(`[android-main] server ready on ${srv.url} (healthz ${handshake.health})`);

  let stopping = false;
  const stop = () => {
    if (stopping) { process.exit(1); }
    stopping = true;
    console.log('[android-main] shutting down');
    setTimeout(() => process.exit(0), 4000).unref();
    srv.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('[android-main] failed:', e && e.message || e);
  // write a failed handshake so Java fails fast instead of polling the full window
  try {
    const launch = JSON.parse(fs.readFileSync(LAUNCH_PATH, 'utf8'));
    const p = launch.handshake || '/data/user/0/icu.jiangjiangze.stronghold/files/run/handshake.json';
    fs.writeFileSync(p + '.tmp', JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 200), ts: Date.now() }));
    fs.renameSync(p + '.tmp', p);
  } catch { /* best effort */ }
  process.exit(1);
});
