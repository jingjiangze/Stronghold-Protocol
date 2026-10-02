// dc-bridge.js — client-side WebRTC DataChannel transport shim (shell build).
// When the shell serves the page with window.__SP_DC_INPUT.enabled = true (join-by-code
// chose DC mode because a direct TCP probe to the host failed), this replaces
// globalThis.WebSocket with a DataChannel-backed implementation. net.js falls back to
// globalThis.WebSocket (net.js:218), so the game code is untouched. Signaling goes
// through the directory service on the box; the media path is direct P2P via STUN.
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') return;
  var cfg = window.__SP_DC || null;
  if (!cfg || !cfg.enabled || !cfg.room || !cfg.directory) return;

  var NativeWS = window.WebSocket;

  function DCWebSocket(url) {
    // only the game's own sockets are bridged; anything else keeps native behavior
    if (!/^wss?:/i.test(url || '') || !/\/ws$/.test((url || '').split('?')[0])) {
      return new NativeWS(url);
    }
    var self = this;
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.bufferedAmount = 0;
    this.extensions = '';
    this.protocol = '';
    this.binaryType = 'arraybuffer';
    this.onopen = this.onmessage = this.onerror = this.onclose = null;

    var pc = new RTCPeerConnection({ iceServers: cfg.stun || [] });
    var dc = pc.createDataChannel('ws', { ordered: true });
    var settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      self.readyState = 3;
      if (self.onerror) self.onerror(err || new Error('dc failed'));
      if (self.onclose) self.onclose({ code: 1006, reason: 'dc failed' });
    }

    (async function () {
      try {
        var offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise(function (r) { setTimeout(r, 1200); }); // allow ICE gathering
        var post = await fetch(cfg.directory + '/signal/' + encodeURIComponent(cfg.room), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'client', offer: pc.localDescription.sdp })
        });
        if (!post.ok) throw new Error('signal POST ' + post.status);
        var answer = null;
        for (var i = 0; i < 20; i++) {
          if (settled) return;
          await new Promise(function (r) { setTimeout(r, 1000); });
          var res = await fetch(cfg.directory + '/signal/' + encodeURIComponent(cfg.room), { cache: 'no-store' });
          if (!res.ok) continue;
          var j = await res.json();
          if (j.answer) { answer = j.answer; break; }
        }
        if (!answer) throw new Error('no answer from host');
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch (e) { fail(e); }
    })();

    dc.onopen = function () {
      if (settled) return;
      settled = true;
      self.readyState = 1;
      if (self.onopen) self.onopen({});
    };
    dc.onmessage = function (ev) {
      if (self.onmessage) self.onmessage({ data: ev.data });
    };
    dc.onclose = function () {
      self.readyState = 3;
      if (self.onclose) self.onclose({ code: 1000 });
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') fail();
    };

    this.send = function (data) {
      if (dc && dc.readyState === 'open') dc.send(typeof data === 'string' ? data : new Uint8Array(data));
    };
    this.close = function () {
      try { dc.close(); } catch (e) {}
      try { pc.close(); } catch (e) {}
    };
  }
  DCWebSocket.CONNECTING = 0; DCWebSocket.OPEN = 1; DCWebSocket.CLOSING = 2; DCWebSocket.CLOSED = 3;

  window.WebSocket = DCWebSocket;
  window.__SP_DC_ACTIVE = true;
})();
