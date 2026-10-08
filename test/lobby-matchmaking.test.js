// test/lobby-matchmaking.test.js — 快速匹配 through the real server: four clients queue, everyone confirms, and the
// lobby hands them one ordinary room (server/matchmaking.js + the lobby's allocateMatch). The point of the wiring test
// is that a matchmade room is a normal room: it has a code, the first player hosts it, and everyone is seated.
// Run: node --test test/lobby-matchmaking.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { MAX_SEATS } from '../shared/constants.js';

async function fourPlayers(t) {
  const srv = await startServer({ port: 0, quiet: true, matchmaking: { acceptMs: 1200, waitMs: 20_000 } });
  t.after(() => srv.close());
  const clients = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    const w = await c.hello(`P${i}`);
    c.id = w.playerId;
    clients.push(c);
  }
  t.after(() => Promise.all(clients.map((c) => c.terminate().catch(() => {}))));
  return { srv, clients };
}

test('four solo players queue, confirm, and land in one room together', async (t) => {
  const { clients } = await fourPlayers(t);
  for (const c of clients) {
    const reply = await c.request({ t: 'queue.join', difficulty: 'NORMAL' });
    assert.equal(reply.t, 'ok', JSON.stringify(reply));
  }
  // the queue offers once it is exactly full; every member sees the same offer
  const offers = await Promise.all(clients.map((c) => c.waitFor('queue.state', (s) => s.state === 'offered')));
  const offerIds = new Set(offers.map((s) => s.offerId));
  assert.equal(offerIds.size, 1, 'one offer for the four of them');
  const offerId = [...offerIds][0];
  assert.equal(offers[0].required, MAX_SEATS);
  assert.equal(offers[0].waiting, MAX_SEATS);

  for (const c of clients) assert.equal((await c.request({ t: 'queue.accept', offerId })).t, 'ok');
  const matched = await Promise.all(clients.map((c) => c.waitFor('queue.state', (s) => s.state === 'matched')));
  const codes = new Set(matched.map((s) => s.code));
  assert.equal(codes.size, 1, 'one room code for all of them');
  const code = [...codes][0];
  assert.match(code, /^[0-9A-Z]{4}$/);

  // …and it is an ordinary room: the state names all four seats, the first queued player hosts it
  const states = await Promise.all(clients.map((c) => c.waitFor('room.state', (s) => s.code === code)));
  for (const st of states) {
    assert.equal(st.mode, 'coop');
    assert.equal(st.difficulty, 'NORMAL');
    assert.equal(st.seats.filter(Boolean).length, MAX_SEATS, 'every seat is a human');
    assert.equal(st.hostId, clients[0].id, 'the first in the queue hosts');
  }
});

test('a silent player does not cost the others their place: the queue puts the rest back', async (t) => {
  const { clients } = await fourPlayers(t);
  for (const c of clients) await c.request({ t: 'queue.join', difficulty: 'HARD' });
  const offer = await clients[0].waitFor('queue.state', (s) => s.state === 'offered');
  // three confirm; the fourth says nothing
  for (const c of clients.slice(0, MAX_SEATS - 1)) assert.equal((await c.request({ t: 'queue.accept', offerId: offer.offerId })).t, 'ok');
  // the queue's own timer breaks the offer: the three who confirmed keep their place, the silent one is out
  const requeued = await clients[0].waitFor('queue.state', (s) => s.requeued === true, 40_000);
  assert.equal(requeued.state, 'queued', 'back in the queue');
  assert.equal(requeued.joinedAt, offer.joinedAt, 'with their original wait age');
  const dropped = await clients[MAX_SEATS - 1].waitFor('queue.state', (s) => s.state === 'idle', 40_000);
  assert.equal(dropped.reason, 'unconfirmed');
  // and no second offer forms: only three are left, and a room needs exactly MAX_SEATS
  assert.equal(clients[1].inbox.some((m) => m.t === 'queue.state' && m.state === 'offered' && m.offerId !== offer.offerId), false);
});
