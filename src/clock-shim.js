// Virtual clock shim. Injected into the page via page.evaluateOnNewDocument()
// BEFORE any user script runs. Replaces all wall-clock APIs with virtual ones
// that advance only when window.__advanceFrame(dtMs) is called from the host.
//
// This is the same technique used by timecut/timeweb — but rewritten as a
// self-contained ESM module that exports the source as a string. The string is
// wrapped in an IIFE and evaluated inside the page.

export const clockShimSource = `(() => {
  if (window.__claude2vid_clock) return; // idempotent

  // Stash real implementations so the host (puppeteer side) can still get a
  // real macrotask escape hatch via window.__real.setTimeout(fn, 0).
  window.__real = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Date: window.Date,
    performanceNow: performance.now.bind(performance),
  };

  // Virtual clock state ----------------------------------------------------
  const startEpoch = 1700000000000; // fixed Nov 2023 epoch, so Date.now() is stable
  let virtualNow = 0;               // ms since startEpoch
  let nextTimerId = 1;
  let nextRafId = 1;
  const timers = new Map();         // id -> { deadline, cb, args, interval? }
  let rafQueue = [];                // [{ id, cb }] — fires on next advanceFrame
  let nextRafQueue = [];            // rAFs queued *during* a drain — fire after
  let draining = false;

  // Date -------------------------------------------------------------------
  const RealDate = window.__real.Date;
  function virtualEpochMs() { return startEpoch + virtualNow; }

  function VirtualDate(...args) {
    if (!(this instanceof VirtualDate)) {
      return new RealDate(virtualEpochMs()).toString();
    }
    if (args.length === 0) return new RealDate(virtualEpochMs());
    return new RealDate(...args);
  }
  VirtualDate.prototype = RealDate.prototype;
  VirtualDate.now = () => virtualEpochMs();
  VirtualDate.parse = RealDate.parse;
  VirtualDate.UTC = RealDate.UTC;
  window.Date = VirtualDate;

  // performance.now --------------------------------------------------------
  performance.now = () => virtualNow;

  // setTimeout / setInterval ----------------------------------------------
  window.setTimeout = (cb, ms = 0, ...args) => {
    const id = nextTimerId++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { deadline: virtualNow + delay, cb, args });
    return id;
  };
  window.clearTimeout = (id) => { timers.delete(id); };
  window.setInterval = (cb, ms, ...args) => {
    const id = nextTimerId++;
    const delay = Math.max(1, Number(ms) || 1);
    timers.set(id, { deadline: virtualNow + delay, cb, args, interval: delay });
    return id;
  };
  window.clearInterval = (id) => { timers.delete(id); };

  // requestAnimationFrame --------------------------------------------------
  window.requestAnimationFrame = (cb) => {
    const id = nextRafId++;
    (draining ? nextRafQueue : rafQueue).push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    rafQueue = rafQueue.filter(r => r.id !== id);
    nextRafQueue = nextRafQueue.filter(r => r.id !== id);
  };

  // The host-side driver ---------------------------------------------------
  // dtMs: amount of virtual time to advance. Pass 0 to flush queued rAFs
  // without moving the clock (useful for frame 0).
  window.__advanceFrame = (dtMs) => {
    virtualNow += Math.max(0, Number(dtMs) || 0);
    draining = true;

    // Drain due timers, in deadline order, with a safety cap.
    for (let pass = 0; pass < 1000; pass++) {
      let due = [];
      for (const [id, t] of timers) {
        if (t.deadline <= virtualNow) due.push([id, t]);
      }
      if (due.length === 0) break;
      due.sort((a, b) => a[1].deadline - b[1].deadline);
      for (const [id, t] of due) {
        if (!timers.has(id)) continue;
        if (t.interval != null) {
          t.deadline = virtualNow + t.interval;
        } else {
          timers.delete(id);
        }
        try { t.cb.apply(null, t.args); } catch (e) { console.error(e); }
      }
    }

    // Fire rAFs scheduled for this frame.
    const toFire = rafQueue;
    rafQueue = [];
    for (const { cb } of toFire) {
      try { cb(virtualNow); } catch (e) { console.error(e); }
    }

    // Promote any rAFs scheduled DURING the drain to be next frame's queue.
    rafQueue = nextRafQueue;
    nextRafQueue = [];
    draining = false;

    return virtualNow;
  };

  // Read-only accessors for diagnostics
  window.__virtualNow = () => virtualNow;
  window.__pendingCounts = () => ({
    timers: timers.size,
    rafThisFrame: rafQueue.length,
    rafNextFrame: nextRafQueue.length,
  });

  window.__claude2vid_clock = { ready: true, version: 1 };
})();`;
