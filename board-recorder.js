/* ============================================================================
   Board Center — the meeting recorder.
   Records a meeting in the browser: the room's microphone, or an online call
   (the microphone plus the audio of the tab the call is in). Knows nothing
   about Supabase; board-center.js decides what happens to the recording.

   A meeting cannot be held twice, so every few seconds of audio is written to
   this browser's IndexedDB as it is recorded. If the tab crashes, the laptop
   sleeps or somebody closes the window, the recording is still here the next
   time the Board Center opens, and can be uploaded or saved to the computer.
   It is removed only once it has been uploaded or somebody discards it.
   ========================================================================== */
window.BoardRecorder = (function () {
  'use strict';

  var DB_NAME = 'ppr-board-recorder';
  var SLICE_MS = 5000;
  // Speech, not music: about 14 MB an hour, so a long board meeting stays far
  // under the 50 MB upload limit.
  var BITRATE = 32000;
  // Where the browser has no Web Locks, a session whose last chunk is this
  // recent is taken to be still recording in another tab.
  var LIVE_MS = 30000;
  var LOCK_PREFIX = 'ppr-board-recording-';

  var rec = null;
  var listeners = [];

  function emit(type, detail) {
    listeners.forEach(function (fn) { try { fn(type, detail || {}); } catch (e) { console.error(e); } });
  }

  // --------------------------------------------------------------- support
  function supported() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext));
  }
  /** Capturing another tab's sound works in Chrome and Edge on a computer. */
  function canCaptureCall() {
    var ua = navigator.userAgent;
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) &&
      /Chrome|Edg\//.test(ua) && !/Mobile|Android/.test(ua);
  }
  function pickMime() {
    var options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < options.length; i++) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(options[i])) return options[i];
    }
    return '';
  }

  // ------------------------------------------------------------- IndexedDB
  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no IndexedDB')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('chunks')) {
          var chunks = d.createObjectStore('chunks', { autoIncrement: true });
          chunks.createIndex('session', 'session', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    // Private browsing in some browsers refuses IndexedDB. Recording still
    // works -- it just has no safety net -- so a failure here is not fatal.
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }
  function tx(stores, mode, work) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(stores, mode);
        var out = work(t);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }
  function putSession(s) {
    return tx(['sessions'], 'readwrite', function (t) { t.objectStore('sessions').put(s); })
      .catch(function (e) { console.warn('recorder: session not saved', e); });
  }
  function putChunk(session, seq, data) {
    return tx(['chunks'], 'readwrite', function (t) {
      t.objectStore('chunks').add({ session: session, seq: seq, data: data });
    }).catch(function (e) { console.warn('recorder: chunk not saved', e); });
  }

  /** Names of the recordings another open tab is making right now. Each
   *  recording holds a Web Lock for as long as it runs, and the browser drops
   *  the lock the moment that tab closes or crashes -- so a crashed recording
   *  is offered straight away, and a live one in another tab never is. */
  function liveElsewhere() {
    if (!navigator.locks || !navigator.locks.query) return Promise.resolve(null);
    return navigator.locks.query().then(function (state) {
      return (state.held || []).map(function (l) { return l.name; });
    }).catch(function () { return null; });
  }

  /** Recordings kept in this browser that have not been uploaded. */
  function pending() {
    return Promise.all([
      tx(['sessions'], 'readonly', function (t) { return t.objectStore('sessions').getAll(); }),
      liveElsewhere(),
    ]).then(function (both) {
      var list = both[0] || [];
      var held = both[1];
      var now = Date.now();
      return list.filter(function (s) {
        if (rec && rec.id === s.id) return false;
        if (s.done) return true;
        if (held) return held.indexOf(LOCK_PREFIX + s.id) === -1;
        return !s.lastChunkAt || now - s.lastChunkAt > LIVE_MS;
      }).sort(function (a, b) { return b.startedAt - a.startedAt; });
    }).catch(function () { return []; });
  }
  /** One kept recording as a single file. */
  function assemble(id) {
    return tx(['sessions', 'chunks'], 'readonly', function (t) {
      var out = { session: null, chunks: [] };
      t.objectStore('sessions').get(id).onsuccess = function (e) { out.session = e.target.result; };
      t.objectStore('chunks').index('session').getAll(IDBKeyRange.only(id)).onsuccess = function (e) {
        out.chunks = e.target.result || [];
      };
      return out;
    }).then(function (out) {
      if (!out.session || !out.chunks.length) return null;
      out.chunks.sort(function (a, b) { return a.seq - b.seq; });
      var mime = out.session.mime || 'audio/webm';
      return {
        id: id, meta: out.session.meta || {}, mime: mime, startedAt: out.session.startedAt,
        durationMs: out.session.durationMs || 0,
        blob: new Blob(out.chunks.map(function (c) { return c.data; }), { type: mime.split(';')[0] }),
      };
    });
  }
  function discard(id) {
    return tx(['sessions', 'chunks'], 'readwrite', function (t) {
      t.objectStore('sessions').delete(id);
      var idx = t.objectStore('chunks').index('session');
      idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = function (e) {
        var cursor = e.target.result;
        if (cursor) { t.objectStore('chunks').delete(cursor.primaryKey); cursor.continue(); }
      };
    }).catch(function (e) { console.warn('recorder: discard failed', e); });
  }

  // ----------------------------------------------------------- wake lock
  function holdScreen() {
    if (!rec || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (lock) { if (rec) rec.wakeLock = lock; })
      .catch(function () { /* not allowed here; the recording carries on regardless */ });
  }
  document.addEventListener('visibilitychange', function () {
    if (rec && document.visibilityState === 'visible') holdScreen();
  });

  // ------------------------------------------------------------- recording
  function friendly(err, what) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return what === 'tab'
        ? 'Sharing was cancelled, so nothing is being recorded. Choose Start again and pick the tab with your call.'
        : 'The browser was not allowed to use the microphone. Allow it from the icon at the left of the address bar, then try again.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No microphone was found. Plug one in or check your sound settings, then try again.';
    }
    if (name === 'NotReadableError') {
      return 'The microphone is busy in another app. Close it there (Zoom, Teams, another tab), then try again.';
    }
    return (err && err.message) || 'The recording could not start.';
  }

  /**
   * Starts recording.
   *   mode: 'room' -- the microphone; 'call' -- the microphone plus a tab's audio
   *   meta: anything worth keeping with the recording (the meeting's id, title)
   * Resolves once audio is flowing; rejects with a message fit to show.
   */
  async function start(mode, meta) {
    if (rec) throw new Error('A recording is already running.');
    if (!supported()) throw new Error('This browser cannot record. Use a recent Chrome, Edge, Firefox or Safari.');
    var mime = pickMime();
    var streams = [];
    var tabStream = null;
    var micStream;

    try {
      if (mode === 'call') {
        if (!canCaptureCall()) throw new Error('Recording an online call needs Chrome or Edge on a computer.');
        try {
          tabStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
            preferCurrentTab: false,
          });
        } catch (err) { throw new Error(friendly(err, 'tab')); }
        streams.push(tabStream);
        if (!tabStream.getAudioTracks().length) {
          throw new Error('No sound was shared. Choose Start again, pick the tab with your call, and switch on ' +
            '“Also share tab audio” before choosing Share.');
        }
      }
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: mode === 'call', noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) { throw new Error(friendly(err, 'mic')); }
      streams.push(micStream);
    } catch (err) {
      streams.forEach(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); });
      throw err;
    }

    // Everything goes through one mixer, so the call and the room end up in a
    // single track and the level meter shows what is actually being recorded.
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    if (ctx.state === 'suspended') await ctx.resume().catch(function () {});
    var dest = ctx.createMediaStreamDestination();
    try { dest.channelCount = 1; } catch (e) { /* stereo is fine too */ }
    var analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(micStream).connect(dest);
    ctx.createMediaStreamSource(micStream).connect(analyser);
    if (tabStream) {
      var tabSource = ctx.createMediaStreamSource(new MediaStream(tabStream.getAudioTracks()));
      tabSource.connect(dest);
      tabSource.connect(analyser);
    }

    var recorder;
    try {
      recorder = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: BITRATE }
                                                     : { audioBitsPerSecond: BITRATE });
    } catch (err) {
      streams.forEach(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); });
      ctx.close().catch(function () {});
      throw new Error('This browser could not start a recording.');
    }

    var id = 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    rec = {
      id: id, mode: mode, meta: meta || {}, mime: recorder.mimeType || mime || 'audio/webm',
      startedAt: Date.now(), runStart: Date.now(), elapsedBefore: 0, paused: false,
      recorder: recorder, streams: streams, ctx: ctx, analyser: analyser,
      buf: new Uint8Array(analyser.fftSize), chunks: [], seq: 0, bytes: 0, wakeLock: null,
      stopping: null,
    };
    var session = { id: id, meta: rec.meta, mime: rec.mime, startedAt: rec.startedAt, durationMs: 0,
      bytes: 0, lastChunkAt: Date.now(), done: false };
    putSession(session);

    recorder.ondataavailable = function (e) {
      if (!rec || !e.data || !e.data.size) return;
      var seq = rec.seq++;
      rec.chunks.push(e.data);
      rec.bytes += e.data.size;
      putChunk(id, seq, e.data);
      session.durationMs = elapsed();
      session.bytes = rec.bytes;
      session.lastChunkAt = Date.now();
      putSession(session);
    };

    // The call's tab stopped being shared ("Stop sharing", or the tab closed).
    // The room microphone keeps going; say so rather than stop silently.
    if (tabStream) {
      tabStream.getTracks().forEach(function (t) {
        t.addEventListener('ended', function () {
          if (rec && rec.id === id && !rec.stopping) emit('tab-ended');
        });
      });
    }
    micStream.getAudioTracks().forEach(function (t) {
      t.addEventListener('ended', function () {
        if (rec && rec.id === id && !rec.stopping) emit('mic-ended');
      });
    });

    recorder.start(SLICE_MS);
    var mine = rec;
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request(LOCK_PREFIX + id, function () {
        return new Promise(function (resolve) {
          if (mine.released) resolve(); else mine.releaseLock = resolve;
        });
      }).catch(function () { /* no lock: pending() falls back to timing */ });
    }
    holdScreen();
    emit('start', { id: id });
    return { id: id, mime: rec.mime };
  }

  function elapsed() {
    if (!rec) return 0;
    return rec.elapsedBefore + (rec.paused ? 0 : Date.now() - rec.runStart);
  }
  function state() { return !rec ? 'idle' : rec.stopping ? 'stopping' : rec.paused ? 'paused' : 'recording'; }
  function current() { return rec ? { id: rec.id, mode: rec.mode, meta: rec.meta, bytes: rec.bytes } : null; }

  /** Input level, 0 to 1, for the meter. */
  function level() {
    if (!rec || rec.paused) return 0;
    rec.analyser.getByteTimeDomainData(rec.buf);
    var sum = 0;
    for (var i = 0; i < rec.buf.length; i++) { var v = (rec.buf[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / rec.buf.length) * 4);
  }

  function pause() {
    if (!rec || rec.paused || rec.recorder.state !== 'recording') return;
    rec.recorder.pause();
    rec.elapsedBefore += Date.now() - rec.runStart;
    rec.paused = true;
    emit('pause');
  }
  function resume() {
    if (!rec || !rec.paused) return;
    rec.recorder.resume();
    rec.runStart = Date.now();
    rec.paused = false;
    emit('resume');
  }

  function release(r) {
    r.released = true;
    if (r.releaseLock) r.releaseLock();
    r.streams.forEach(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); });
    r.ctx.close().catch(function () {});
    if (r.wakeLock) r.wakeLock.release().catch(function () {});
  }

  /** Stops, and resolves with the whole recording. It stays in IndexedDB
   *  until discard() -- call that once it is safely uploaded. */
  function stop() {
    if (!rec) return Promise.reject(new Error('Nothing is being recorded.'));
    if (rec.stopping) return rec.stopping;
    var r = rec;
    var durationMs = elapsed();
    r.stopping = new Promise(function (resolve) {
      r.recorder.onstop = function () {
        // Let the final ondataavailable land before reading the chunks.
        setTimeout(function () {
          release(r);
          var result = {
            id: r.id, meta: r.meta, mime: r.mime, durationMs: durationMs, startedAt: r.startedAt,
            blob: new Blob(r.chunks, { type: r.mime.split(';')[0] }),
          };
          putSession({ id: r.id, meta: r.meta, mime: r.mime, startedAt: r.startedAt, durationMs: durationMs,
            bytes: result.blob.size, lastChunkAt: Date.now(), done: true });
          rec = null;
          emit('stop', { id: r.id });
          resolve(result);
        }, 0);
      };
      if (r.recorder.state === 'inactive') r.recorder.onstop();
      else r.recorder.stop();
    });
    emit('stopping');
    return r.stopping;
  }

  /** Throws the recording away. */
  function cancel() {
    if (!rec) return Promise.resolve();
    var r = rec;
    rec = null;
    try { if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch (e) { /* already stopped */ }
    release(r);
    emit('stop', { id: r.id });
    return discard(r.id);
  }

  window.addEventListener('beforeunload', function (e) {
    if (rec) { e.preventDefault(); e.returnValue = ''; }
  });

  return {
    supported: supported, canCaptureCall: canCaptureCall,
    start: start, pause: pause, resume: resume, stop: stop, cancel: cancel,
    state: state, current: current, elapsed: elapsed, level: level,
    pending: pending, assemble: assemble, discard: discard,
    on: function (fn) { listeners.push(fn); },
  };
})();
