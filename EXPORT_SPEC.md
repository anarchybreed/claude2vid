# Claude Design → claude2vid export spec

A contract for Claude Design HTML exports so `claude2vid` can render them to MP4 with **no per-export flags** and no detection guesswork. Anything not in this spec is fair game — these are the bits the recorder has to read.

The recorder runs the page in headless Chromium with a monkey-patched virtual clock (`Date.now`, `performance.now`, `requestAnimationFrame`, `setTimeout`, `setInterval` all advance only when the recorder ticks them). It then screenshots one frame per tick and pipes to ffmpeg. The page is not aware it's being recorded.

There are two contracts. Implement **either one**. The first is what every current export already does — just tighten it up. The second is strictly better and the recommended target for new exports.

---

## Contract A — declarative (the current pattern, cleaned up)

The recorder regex-scrapes the entry HTML and JSX files to discover the frame size and duration. To make that reliable:

### 1. Stage tag

Place exactly **one** `<Stage>` tag in the source, with width/height/duration as **direct numeric literals**:

```jsx
<Stage width={1080} height={1920} duration={45} ...>
```

Acceptable variants the recorder also parses:

```jsx
<Stage width={W} height={H} duration={D}>        // bare const idents
<Stage width={VB.frameW} height={VB.frameH} ...> // single-level member access on an object literal
```

**Do not:**
- Alias the import (`const StageA = window.Stage; <StageA …>`) — works today but only because of a loose regex; brittle.
- Use computed/expression values (`width={Math.min(...)}`, `width={cfg().w}`, template strings, ternaries).
- Use nested member access (`width={cfg.video.frameW}`).
- Spread props (`<Stage {...dims}>`).
- Render multiple `<Stage>` tags in one document.

If you must use an object literal for the values, keep it flat and primitive:

```jsx
const VB = { frameW: 1080, frameH: 1920, duration: 45 };
```

### 2. File layout

The recorder walks the entry HTML's directory recursively (depth ≤ 3) for `.js / .jsx / .mjs` files. Subdirectories are fine (`scenes/`, `animation/`, etc.). It skips `node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `coverage`, and any dot-prefixed dir — do not put export source there.

### 3. Root element

A single React mount target with an `id`, directly under `<body>`:

```html
<body>
  <div id="root"></div>
  <script ...></script>
</body>
```

The id value doesn't matter (`#root`, `#vbroot`, `#app` all work) — but it **must** have one, and it must be the **only** `body > div[id]`. Don't put decorative div siblings before the mount target.

### 4. Stage component DOM shape

The recorder's `--hide-chrome` mode targets the playback bar via this structure (the shape produced by the current `animations.jsx` Stage):

```
body > div[id]            ← mount target
  └─ div                  ← Stage outer (the first div the Stage renders)
       ├─ div             ← canvas wrapper (flex: 1)
       │    └─ div        ← canvas at intrinsic width × height
       └─ div             ← PlaybackBar (LAST child)
```

Two structural rules the chrome-hide CSS depends on:
- The Stage's outer wrapper is the **only** child of the mount target.
- The PlaybackBar is the **last direct child** of the Stage outer (so `:last-child` and `:nth-child(2)` both find it).

If you add another top-level child to the Stage outer (e.g. a debug overlay), keep the PlaybackBar last.

### 5. No persistent side-effects on first paint

The page must look the same on every fresh load. Two specific gotchas seen in the wild:

- **`localStorage` playhead persistence.** If your Stage persists `time` to `localStorage` ("resume where you left off"), it will resume mid-animation on the recorder's first frame. Either skip persistence entirely, or skip it when `?export=1` is present (see Contract B §URL flags).
- **Random seeds.** If a scene calls `Math.random()` during render, particles/stars will differ between local preview and recorded output. Seed RNG from a fixed value, or call `Math.random()` only inside `useState`/`useMemo` initializers that depend on a stable input.

---

## Contract B — programmatic (recommended for new exports)

Expose a small global the recorder can read directly. With this, the recorder does not parse JSX at all — it just reads the globals after the page mounts.

### Required globals

```js
window.__vb = {
  width:    1080,                       // integer px
  height:   1920,                       // integer px
  duration: 45,                         // seconds (number, can be fractional)
  fps:      60,                         // optional; recorder defaults to 60
};
window.__vbReady = true;                // set true once first paint is complete
```

Set `__vb` **synchronously at the top of `<head>`** (in an inline `<script>` before any other code runs) so the recorder can read it immediately after page load. Setting it inside a `useEffect` or a deferred callback works only if you also gate `__vbReady` correctly — see Virtual-clock gotchas below.

`__vbReady` should be flipped to `true` after one or two `requestAnimationFrame` callbacks have fired (so the recorder knows the DOM has actually painted). The recorder ticks the virtual clock once before waiting on `__vbReady`, so both `rAF` callbacks and `setTimeout(..., 0)` will drain on that first tick.

### Required URL flags

The recorder loads the page with `?export=1`. When that flag is present, the page must:

1. **Skip all `localStorage` reads/writes** (no resumed playhead).
2. **Hide the playback bar** (or never render it). Inline this in the page:
   ```html
   <script>
     if (new URLSearchParams(location.search).has('export')) {
       document.body.classList.add('vb-export');
     }
   </script>
   <style>
     body.vb-export .vb-chrome { display: none !important; }
   </style>
   ```
   Tag the playback bar with `class="vb-chrome"` (or whatever name; just be consistent).
3. **Autoplay from t=0.** No autoplay-paused, no welcome modal, no "click to start."

### Recommended: static-frame mode

If the page can render an exact timestamp without running the animation loop, expose:

```
?export=1&frame=1&seek=N
```

where `N` is seconds. In this mode the page bypasses its `requestAnimationFrame` loop entirely and freezes the timeline at `N` seconds, then sets `__vbReady = true` once the frame has painted. Stellar Magnitude does this — see its `app.jsx` for a working example.

Static-frame mode is faster (no virtual-clock simulation) and more robust (no risk of state desync from accumulated rAF ticks). The recorder will use it when present and fall back to live mode otherwise.

---

---

## Virtual-clock gotchas

The recorder monkey-patches `Date.now`, `performance.now`, `requestAnimationFrame`, `setTimeout`, and `setInterval` so they only advance when the recorder ticks (`window.__advanceFrame(dtMs)`). This makes frame capture deterministic, but it changes the semantics of common boot-time idioms. Pages that ignore this render blank opening frames or hang.

### Don't gate first paint on real Promises

`document.fonts.ready` returns a real (un-patched) Promise tied to actual font loading. The recorder waits on it before starting the frame loop, so by the time your scripts run, fonts are loaded. But your page-side `.then(boot)` handler still has to be queued before the recorder ticks — and any **fallback** like `setTimeout(boot, 600)` is now 600ms of *virtual* time = 36 blank frames at 60 fps.

```js
// ✗ Wrong — under virtual time, the fallback fires after 36 blank frames
document.fonts.ready.then(boot);
setTimeout(boot, 600);

// ✓ Right — boot synchronously, re-render once fonts settle if you need it
boot();
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { if (staticFrameMode) redraw(); }).catch(() => {});
}
```

### Don't trust wall-clock APIs

Anything that reads `Date.now()`, `performance.now()`, or `new Date()` is reading **virtual** time. Two consequences:

- A scene that starts a timer "5 seconds from now" using `Date.now() + 5000` works fine — `Date.now()` advances with `__advanceFrame`. But computing elapsed wall time across multiple frames will give you virtual deltas, not real ones.
- `performance.now()` starts at `0` on first frame, not at some arbitrary navigation offset. Code that assumes a non-zero baseline (e.g. `if (performance.now() > LAUNCH_TS)`) will misbehave.

### `setTimeout(fn, 0)` is not "next microtask"

Under the patched clock, `setTimeout(fn, 0)` queues `fn` against a virtual deadline of `0` and fires it on the next `__advanceFrame` call (with any `dt`, including `0`). It is *not* synchronous, and it does not run as a microtask. If you need a true microtask, use `Promise.resolve().then(...)` or `queueMicrotask(...)` — those bypass the patched timers and run as expected.

The recorder calls `__advanceFrame(0)` once after page load specifically to drain any `setTimeout(0)` and `rAF` callbacks queued during boot. This is when `__vbReady` typically gets flipped.

### Avoid stateful rAF loops if you can

If your render function is pure (`render(t)` produces the same output for the same `t`), the recorder can drive it directly via static-frame mode (`?frame=1&seek=N`) — no virtual-clock simulation, no risk of drift. This is strictly more robust than a stateful `requestAnimationFrame` loop that integrates `dt`.

If you must keep a stateful loop, cap your `dt` (`Math.min(dt, 0.05)` or similar) so that a single oversized virtual tick doesn't break your physics, and don't accumulate floats across the loop seam (re-derive state from `t` each frame).

### Don't use `setInterval` for animation pacing

`setInterval(fn, 16)` will fire `fn` exactly once per `__advanceFrame` tick regardless of how many virtual milliseconds elapsed. Use `requestAnimationFrame` for animation — it composes correctly with the virtual clock.

### Don't rely on `Math.random()` for visible state

`Math.random()` is not patched. Two recorder runs of the same page produce different stars/particles, which makes diffing exported frames useless and makes static-frame mode non-deterministic. Seed an RNG from a fixed constant (or from `t` itself if you want time-varying randomness), or call `Math.random()` only inside `useState`/`useMemo` initializers that depend on stable input.

---

## Audio (optional)

If your export plays audio via the Web Audio API, the recorder can capture it. Two modes:

### Capture mode

The recorder wraps `AudioContext` with an `OfflineAudioContext` of length `duration`. To make this work, the page must:

- Use `new AudioContext()` (no args) or `new (window.AudioContext || window.webkitAudioContext)()`.
- Not assume the context is "running" — the captured context never reaches the speakers, so don't gate playback on `ctx.state === 'running'`.
- Avoid `MediaElementSource` and `MediaStreamSource` — they only work in real-time contexts.
- All sound events must be deterministic functions of timeline time, not wall-clock.

### Event-stamping mode

For sample-replacement workflows, dispatch a custom event on each "beat":

```js
window.dispatchEvent(new CustomEvent('vb-audio', {
  detail: { kind: 'short' | 'long', t: currentTimelineSeconds }
}));
```

The recorder collects these and mixes user-supplied WAVs in place of the live synth.

---

## Quick conformance checklist

For any new export, before shipping:

- [ ] Entry HTML loads in browser at `?export=1` with no chrome, no playhead persistence, autoplay from t=0.
- [ ] `window.__vb` is set synchronously in `<head>` and `__vbReady` flips to `true` after first paint (one or two `rAF` ticks). (Contract B only.)
- [ ] `<Stage width={…} height={…} duration={…}>` uses literal numbers, simple consts, or single-level member access. (Contract A only.)
- [ ] Single `body > div[id]` mount target, Stage outer is its only child, PlaybackBar is the last child of the Stage outer.
- [ ] First paint is **not** gated on `document.fonts.ready` or any real Promise. Re-render on font load if you need glyph metrics, but don't *block* on it.
- [ ] No `setTimeout(..., N)` fallbacks used for boot — under the virtual clock, `N ms` is `N ms of frames`.
- [ ] `dt` is capped in any stateful `rAF` loop (`Math.min(dt, 0.05)` or similar) and per-frame state is re-derived from `t` rather than integrated across the loop seam.
- [ ] No `Math.random()` called during render outside stable `useState`/`useMemo` initializers (use a seeded RNG, or derive from `t`).
- [ ] If audio: no `MediaElement`/`MediaStream` sources, all events deterministic in timeline time.
- [ ] No CORS-dependent assets — bundle everything in the export folder.
