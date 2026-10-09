// server/net.js — the link probe behind the adaptive snapshot rate (server/match/snapRate.js): the ws ping/pong
// RTT ring, and which sockets are worth probing at all.
//
// The probe is the only new thing this feature puts on the wire, so its gating is worth pinning: it must run for
// a socket being streamed to and for one sitting in a room (probing during prep means the first combat frame
// already has a verdict), and it must not run for an idle lobby connection.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Network, SessionRegistry, linkQualityOf, recordLinkPong, sendRaw } from '../server/net.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** The narrow slice of a ws socket server/net.js touches, with the ping payloads and pongs we can drive. */
function fakeWs() {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  return {
    readyState: 1,
    bufferedAmount: 0,
    pings: [],
    sent: [],
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
      return this;
    },
    emit(ev, ...args) {
      for (const fn of handlers.get(ev) || []) fn(...args);
    },
    ping(data) { this.pings.push(data); },
    send(data, _opts, cb) { this.sent.push(data); if (typeof cb === 'function') cb(); },
    close() {},
    terminate() {},
  };
}

/** A Network whose timers never fire on their own: every probe in these tests is called by hand. */
function makeNet(now = () => 1_000_000) {
  const registry = new SessionRegistry({ reconnectWindowMs: 60_000 });
  return new Network({
    registry,
    handler: { onMessage() {} },
    log: noopLog,
    now,
    options: { heartbeatMs: 2_147_483_647, reconnectWindowMs: 60_000, linkProbeMs: 1000, linkWarmMs: 5000 },
  });
}

describe('recordLinkPong: what counts as a link sample', () => {
  const ws = fakeWs();
  const ring = () => linkQualityOf(ws).rtts;

  test('linkQualityOf is null until the socket is adopted, then reports the ring and the queue', () => {
    const fresh = fakeWs();
    assert.equal(linkQualityOf(fresh), null, 'a socket the server never saw has no link state');
    const net = makeNet();
    net.handleConnection(ws);
    assert.deepEqual(linkQualityOf(ws).rtts, []);
    assert.equal(linkQualityOf(ws).buffered, 0);
    net.close();
  });

  test('a payload-less pong is the liveness heartbeat and carries no timing', () => {
    recordLinkPong(ws, Buffer.alloc(0), 1_000_000);
    assert.deepEqual(ring(), [], 'the heartbeat must not be mistaken for a zero-ms round trip');
  });

  test('a junk payload is ignored, not turned into a sample', () => {
    for (const bad of [Buffer.from('nope'), Buffer.from(''), Buffer.from('-')]) recordLinkPong(ws, bad, 1_000_000);
    assert.deepEqual(ring(), []);
  });

  test('a plausible round trip is recorded, an implausible one is not', () => {
    recordLinkPong(ws, Buffer.from('1000000'), 1_000_050);          // 50 ms
    recordLinkPong(ws, Buffer.from('1000000'), 1_000_000 + 120);    // 120 ms
    assert.deepEqual(ring(), [50, 120]);
    recordLinkPong(ws, Buffer.from('1000000'), 999_000);            // negative
    recordLinkPong(ws, Buffer.from('1000000'), 1_000_000 + 60_001); // past the plausibility cap
    assert.deepEqual(ring(), [50, 120], 'a clock step or a stalled socket must not become a jitter sample');
  });

  test('the ring is bounded: only the most recent samples are kept', () => {
    for (let i = 0; i < 20; i++) recordLinkPong(ws, Buffer.from('1000000'), 1_000_000 + i * 10);
    assert.equal(ring().length, 8);
    assert.equal(ring()[7], 190, 'newest last');
  });
});

describe('probeLinks: who is worth probing', () => {
  const at = (now) => { let t = now; return { now: () => t, set: (v) => { t = v; } }; };

  test('a socket sitting in a room is probed, an idle lobby socket is not', () => {
    const clock = at(1_000_000);
    const net = makeNet(clock.now);
    const idle = fakeWs();
    const roomed = fakeWs();
    net.handleConnection(idle);
    net.handleConnection(roomed);
    net.conns.get(roomed).session = { roomCode: 'ABCD' };

    net.probeLinks();
    assert.equal(idle.pings.length, 0, "an idle connection's link decides nothing and must not cost uplink");
    assert.equal(roomed.pings.length, 1);
    assert.equal(roomed.pings[0], '1000000', 'the payload is the send time, so the pong yields the round trip');
    net.close();
  });

  test('a socket being streamed to is probed even before it is in a room', () => {
    const clock = at(1_000_000);
    const net = makeNet(clock.now);
    const ws = fakeWs();
    net.handleConnection(ws);
    sendRaw(ws, '{"t":"b.snap"}', { droppable: true });   // a battle frame marks it warm

    net.probeLinks();
    assert.equal(ws.pings.length, 1);
    net.close();
  });

  test('the probe respects its own interval per socket', () => {
    const clock = at(1_000_000);
    const net = makeNet(clock.now);
    const ws = fakeWs();
    net.handleConnection(ws);
    net.conns.get(ws).session = { roomCode: 'ABCD' };

    net.probeLinks();
    clock.set(1_000_500);           // half the probe interval
    net.probeLinks();
    assert.equal(ws.pings.length, 1, 'no second probe inside linkProbeMs');
    clock.set(1_001_000);
    net.probeLinks();
    assert.equal(ws.pings.length, 2);
    net.close();
  });

  test('a pong with the probe payload becomes a sample, and the heartbeat pong does not', () => {
    const clock = at(1_000_000);
    const net = makeNet(clock.now);
    const ws = fakeWs();
    net.handleConnection(ws);
    net.conns.get(ws).session = { roomCode: 'ABCD' };

    net.probeLinks();
    clock.set(1_000_070);
    ws.emit('pong', Buffer.from('1000000'));   // the probe's payload
    ws.emit('pong', Buffer.alloc(0));          // the heartbeat's
    assert.deepEqual(linkQualityOf(ws).rtts, [70]);
    net.close();
  });

  test('a closed socket is never probed', () => {
    const clock = at(1_000_000);
    const net = makeNet(clock.now);
    const ws = fakeWs();
    net.handleConnection(ws);
    net.conns.get(ws).session = { roomCode: 'ABCD' };
    ws.readyState = 3;   // CLOSED
    net.probeLinks();
    assert.equal(ws.pings.length, 0);
    net.close();
  });
});
