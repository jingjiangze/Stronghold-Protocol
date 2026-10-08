// test/net-latency.test.js — the client's latency probe (public/js/net.js).
// The rules under test: RTT is measured on an elapsed-time clock (a wall-clock correction mid-probe must not
// corrupt it), only a reply to a probe still on the books counts, a reply that overtook a newer probe is dropped,
// a reading older than the sample window stops being shown, and a hidden page heartbeats without producing one.
// Run: node --test test/net-latency.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net, PING_SAMPLE_MAX_AGE_MS, PING_TIMEOUT_MS } from '../public/js/net.js';

/** Just enough WebSocket: Net only sends frames and reads readyState. */
class FakeWS {
  constructor() { this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}

/** A Net on a fake socket with both clocks and the visibility flag under the test's control. */
function harness({ visible = true } = {}) {
  let epoch = 1_700_000_000_000;
  let mono = 1000;
  const ws = new FakeWS();
  const pings = [];
  const net = new Net({
    WebSocket: FakeWS,
    now: () => epoch,
    monotonicNow: () => mono,
    isVisible: () => visible,
    // No real timers: the test calls _heartbeat()/_sendPing() itself.
    timers: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
  });
  net.on('ping', (v) => pings.push(v));
  net.ws = ws;
  net.status = 'online';
  return {
    net,
    ws,
    pings,
    advance(ms) { epoch += ms; mono += ms; },
    /** Jump the wall clock without touching elapsed time — an NTP correction or a manual change. */
    jumpEpoch(ms) { epoch += ms; },
    reply(msg) { net._onMessage(JSON.stringify(msg)); },
    sentPings: () => ws.sent.filter((m) => m.t === 'ping'),
    pending: () => net._pings.size,
  };
}

test('a reply to the probe that is still on the books sets the RTT', () => {
  const h = harness();
  h.net._sendPing();
  const [probe] = h.sentPings();
  assert.ok(probe.rid, 'the probe carries a rid the server echoes');
  h.advance(40);
  h.reply({ t: 'pong', rid: probe.rid, c: probe.c });
  assert.equal(h.net.ping, 40);
  assert.equal(h.pending(), 0, 'the probe is consumed');
  assert.deepEqual(h.pings, [40], 'and the UI is told');
});

test('a wall-clock correction between send and reply does not corrupt the RTT', () => {
  const h = harness();
  h.net._sendPing();
  const [probe] = h.sentPings();
  h.advance(40);        // 40 ms of real elapsed time...
  h.jumpEpoch(3_600_000); // ...and an hour of wall clock, as a clock correction would do
  h.reply({ t: 'pong', rid: probe.rid, c: probe.c });
  assert.equal(h.net.ping, 40, 'measured on the monotonic clock, not the wall clock');
  assert.ok(!h.pings.includes(null), 'a bogus reading is never emitted');
});

test('a reply whose c does not match the probe, or an unknown rid, is ignored', () => {
  const h = harness();
  h.net._sendPing();
  const [probe] = h.sentPings();
  h.advance(30);
  h.reply({ t: 'pong', rid: probe.rid, c: probe.c - 1 }); // a stale echo of a different probe
  assert.equal(h.net.ping, null);
  h.reply({ t: 'pong', rid: 'no-such-probe', c: probe.c });
  assert.equal(h.net.ping, null);
  h.reply({ t: 'pong', rid: probe.rid, c: probe.c });
  assert.equal(h.net.ping, 30, 'the matching reply still lands');
});

test('a reply that overtook a newer probe does not overwrite the newer reading', () => {
  const h = harness();
  h.net._sendPing();
  const [first] = h.sentPings();
  h.advance(20);
  h.net._sendPing();
  const second = h.sentPings()[1];
  h.advance(20);
  h.reply({ t: 'pong', rid: second.rid, c: second.c });
  assert.equal(h.net.ping, 20, 'the newer probe answers');
  h.reply({ t: 'pong', rid: first.rid, c: first.c }); // arrives late, describes an older moment
  assert.equal(h.net.ping, 20, 'the late reply of the older probe is dropped');
});

test('a hidden page still heartbeats, but reports no latency', () => {
  const h = harness({ visible: false });
  h.net._sendPing();
  const [probe] = h.sentPings();
  assert.ok(probe, 'the heartbeat is sent');
  h.advance(25);
  h.reply({ t: 'pong', rid: probe.rid, c: probe.c });
  assert.equal(h.net.ping, null, 'nothing is measured while the page is hidden');
  assert.deepEqual(h.pings, []);
});

test('a reading older than the sample window stops being shown', () => {
  const h = harness();
  h.net._sendPing();
  const [probe] = h.sentPings();
  h.advance(30);
  h.reply({ t: 'pong', rid: probe.rid, c: probe.c });
  assert.equal(h.net.ping, 30);
  h.advance(PING_SAMPLE_MAX_AGE_MS);
  h.net._heartbeat();
  assert.equal(h.net.ping, null, 'a stale number is worse than none');
  assert.equal(h.pings.at(-1), null, 'the UI is told to clear it');
});

test('a probe unanswered past its deadline can no longer set a reading', () => {
  const h = harness();
  h.net._sendPing();
  const [probe] = h.sentPings();
  h.advance(PING_TIMEOUT_MS);
  h.reply({ t: 'pong', rid: probe.rid, c: probe.c });
  assert.equal(h.net.ping, null);
  assert.equal(h.pending(), 0, 'the expired probe is gone');
});

test('probes in flight are bounded, so a stalled socket cannot grow the map', () => {
  const h = harness();
  for (let i = 0; i < 30; i++) { h.net._sendPing(); h.advance(1); }
  assert.equal(h.sentPings().length, 30, 'every probe is sent');
  assert.ok(h.pending() <= 8, `at most 8 probes are tracked, saw ${h.pending()}`);
});

test('a dropped socket clears the reading and the clock sync', () => {
  const h = harness();
  h.net._sendPing();
  const [probe] = h.sentPings();
  h.advance(30);
  h.reply({ t: 'pong', rid: probe.rid, c: probe.c });
  assert.equal(h.net.ping, 30);
  h.net._teardownSocket();
  assert.equal(h.net.ping, null);
  assert.equal(h.pending(), 0);
  assert.equal(h.net.clockSynced, false);
});
