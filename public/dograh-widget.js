// Dograh voice widget for the recruiting system.
// Implements the public embed flow against a self-hosted Dograh:
//   1. POST /api/v1/public/embed/init  (embed token + candidate context) -> session_token, workflow_run_id
//   2. RTCPeerConnection with the candidate's mic
//   3. WS  /api/v1/ws/public/signaling/{session_token}  (offer/answer + ICE trickle)
// The AI screener (Gemini Live) talks through the returned audio track; the
// webhook fires to the recruiting server when the call ends.
(function () {
  'use strict';
  const script = document.currentScript;
  const params = new URLSearchParams((script && script.src || '').split('?')[1] || '');
  const API = (params.get('apiEndpoint') || 'http://localhost:8000').replace(/\/+$/, '');
  const TOKEN = params.get('token') || '';
  let CONTEXT = {};
  try { CONTEXT = JSON.parse((script && script.getAttribute('data-dograh-context')) || '{}'); } catch (e) { CONTEXT = {}; }

  const handlers = { end: [], error: [], ready: [], transcript: [] };
  const state = { pc: null, ws: null, audio: null, session: null, started: false };

  function fire(kind, arg) { (handlers[kind] || []).forEach(fn => { try { fn(arg); } catch (e) { /* keep other handlers alive */ } }); }

  function status(msg) {
    let el = document.getElementById('dograh-widget-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dograh-widget-status';
      el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:99999;background:#111;color:#fff;font:14px/1.4 -apple-system,Segoe UI,sans-serif;padding:12px 18px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center;max-width:90vw;';
      document.body.appendChild(el);
    }
    el.innerHTML = '<span style="width:10px;height:10px;border-radius:50%;background:#ff4d4d;display:inline-block;flex:none;animation:dograh-pulse 1.2s infinite"></span><span>' + msg + '</span>';
    if (!document.getElementById('dograh-pulse-style')) {
      const s = document.createElement('style'); s.id = 'dograh-pulse-style';
      s.textContent = '@keyframes dograh-pulse{0%,100%{opacity:1}50%{opacity:.3}}';
      document.head.appendChild(s);
    }
  }

  async function start() {
    if (state.started) return;
    state.started = true;
    try {
      status('Connecting to the AI screener…');
      // 1. open an embed session on Dograh
      const r = await fetch(API + '/api/v1/public/embed/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, context_variables: CONTEXT }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error('Embed init failed (' + r.status + '): ' + t.slice(0, 200));
      }
      const session = await r.json();
      state.session = session;

      // 2. microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      // 3. peer connection
      const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
      state.pc = pc;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
      state.audio = audio;
      pc.addEventListener('track', evt => {
        if (evt.track.kind === 'audio') { audio.srcObject = evt.streams[0]; audio.play().catch(() => {}); }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        const st = pc.iceConnectionState;
        if (st === 'connected' || st === 'completed') status('Live. Talk to the AI screener.');
        if (st === 'failed') { fail(new Error('Voice connection failed')); }
        if (st === 'disconnected' || st === 'closed') { end(); }
      });

      // 4. signaling websocket
      const wsUrl = API.replace(/^http/, 'ws') + '/api/v1/ws/public/signaling/' + encodeURIComponent(session.session_token);
      const ws = new WebSocket(wsUrl);
      state.ws = ws;
      const pcId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random());
      ws.onopen = async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({
          type: 'offer',
          payload: {
            sdp: pc.localDescription.sdp,
            type: 'offer',
            pc_id: pcId,
            workflow_id: session.config && session.config.workflow_id,
            workflow_run_id: session.workflow_run_id,
            call_context_vars: CONTEXT,
          },
        }));
      };
      ws.onmessage = async ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'answer' && m.payload && m.payload.sdp) {
          await pc.setRemoteDescription({ type: 'answer', sdp: m.payload.sdp }).catch(e => fail(e));
        } else if (m.type === 'ice-candidate' && m.payload && m.payload.candidate) {
          try { await pc.addIceCandidate(m.payload.candidate); } catch (e) { /* stale candidate */ }
        } else if (m.type === 'bot-text' && m.payload) {
          (handlers.transcript || []).forEach(fn => fn({ role: 'agent', text: m.payload.content || m.payload.text || '' }));
        } else if (m.type === 'user-transcription' && m.payload) {
          (handlers.transcript || []).forEach(fn => fn({ role: 'candidate', text: m.payload.content || m.payload.text || '' }));
        } else if (m.type === 'pipeline-error') {
          fail(new Error((m.payload && (m.payload.message || m.payload.error)) || 'Dograh pipeline error'));
        }
      };
      ws.onerror = () => fail(new Error('Signaling websocket error'));
      ws.onclose = () => { if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') fail(new Error('Signaling closed before connect')); };
      fire('ready');
    } catch (e) { fail(e); }
  }

  function cleanup() {
    try { state.ws && state.ws.close(); } catch (e) {}
    try { state.pc && state.pc.close(); } catch (e) {}
    try { state.audio && state.audio.remove(); } catch (e) {}
    const el = document.getElementById('dograh-widget-status'); if (el) el.remove();
    state.pc = state.ws = state.audio = null;
    state.started = false;
  }
  function fail(err) { cleanup(); fire('error', err); }
  function end() { cleanup(); fire('end'); }

  window.DograhWidget = {
    start,
    onCallEnd: fn => handlers.end.push(fn),
    onError: fn => handlers.error.push(fn),
    onReady: fn => handlers.ready.push(fn),
    onTranscript: fn => handlers.transcript.push(fn),
    hangUp: () => { try { state.ws && state.ws.close(); } catch (e) {} end(); },
  };
})();
