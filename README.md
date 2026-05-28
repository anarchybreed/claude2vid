# claude2vid

Convert **Claude Design** HTML/JS animations into YouTube-ready MP4 videos.

Claude's "Claude Design" skill emits self-contained HTML+React+JSX animations that look great in a browser but can't be uploaded directly to YouTube. `claude2vid` is a small Node CLI that renders them deterministically into MP4: it runs the animation in headless Chromium with a virtual clock so every frame is captured exactly, then encodes the result through ffmpeg.

The same technique powers Remotion's renderer, `timecut`, and a handful of paid SaaS tools. This is a minimal personal implementation — easy to read, easy to extend, MIT licensed.

## Install

```
git clone https://github.com/<you>/claude2vid
cd claude2vid
npm install
```

Node 20+ is required. Puppeteer downloads its own Chromium and `ffmpeg-static` bundles ffmpeg, so no system dependencies.

## Use

```
node src/cli.js render <input.html> [options]
```

Quick example with the bundled Cosmic Zoom fixture:

```
node src/cli.js render "examples/cosmic-zoom/Cosmic Zoom.html" -o cosmic.mp4
```

`claude2vid` will:

1. Read `<Stage width={N} height={N} duration={N}>` from the input and its sibling `.jsx` files to auto-fill viewport size and length.
2. Spin up a tiny static server, launch headless Chromium, and inject a virtual clock before the page loads.
3. Walk the timeline frame-by-frame, screenshot each frame, and pipe the PNGs straight into ffmpeg (no temp files unless you ask).
4. Produce an H.264 / yuv420p MP4 with `+faststart` — ready to upload to YouTube.

### Options

| flag                          | default               | what it does                                                          |
| ----------------------------- | --------------------- | --------------------------------------------------------------------- |
| `-o, --output <file>`         | `<input>.mp4`         | output path                                                           |
| `--width <px>`                | detected, else `1920` | viewport width                                                        |
| `--height <px>`               | detected, else `1080` | viewport height                                                       |
| `--duration <seconds>`        | detected, else `10`   | how long to render                                                    |
| `--fps <n>`                   | `60`                  | frames per second                                                     |
| `--crf <n>`                   | `18`                  | libx264 CRF — lower is higher quality (18 = visually lossless-ish)    |
| `--preset <name>`             | `medium`              | libx264 preset (`ultrafast`..`veryslow`)                              |
| `--hide-chrome`               | off                   | hide the Stage playback bar + reset auto-scale (see note below)       |
| `--inject-css <file>`         |                       | CSS file injected before rendering — for ad-hoc tweaks                |
| `--selector <css>`            | full viewport         | screenshot only this element instead of the full frame                |
| `--keep-frames <dir>`         |                       | write each PNG to disk for debugging                                  |
| `--sound-blip <file>`         |                       | sample played at each short audio event (see Audio below)             |
| `--sound-completion <file>`   |                       | sample played at each long audio event                                |
| `--sound-threshold-ms <n>`    | `50`                  | duration cutoff (ms) between "short" and "long" events                |
| `--capture-page-audio`        |                       | capture the page's original Web Audio output verbatim                 |
| `-v, --verbose`               | off                   | log progress, page errors, and the ffmpeg command line                |

### Audio

Animations like the Claude Design sort visualizers use the Web Audio API to play synthesized blips/tones driven by the animation. claude2vid offers **two** ways to handle this:

#### 1. Capture the original — `--capture-page-audio`

The page's `AudioContext` is replaced with a wrapper backed by a real `OfflineAudioContext`. Every oscillator, gain envelope, and filter the page schedules is rendered by Chromium's actual Web Audio engine, then exported as WAV and muxed into the MP4. The output sounds exactly like the page does in Chrome — pitch mappings, arpeggios, envelopes, everything.

```
node src/cli.js render "examples/sort-bubble/Bubble Sort.html" \
  --duration 30 --capture-page-audio -o bubble.mp4
```

Best fidelity, zero effort. Recommended when you want the page's audio as-is.

#### 2. Replace with your own samples — `--sound-blip` / `--sound-completion`

Useful when the page's bleeps are placeholders and you want a coordinated sound design without re-rendering hundreds of clicks by hand. The shim *captures* every scheduled audio event (start time, duration, frequency, peak gain) instead of playing it, and your samples are mixed in at those event times.

```
node src/cli.js render "examples/sort-bubble/Bubble Sort.html" \
  --duration 30 \
  --sound-blip ./samples/click.wav \
  --sound-completion ./samples/ding.wav \
  -o bubble.mp4
```

Events split into two buckets by `--sound-threshold-ms` (default 50 ms):

| event duration       | sample used         | typical use                           |
| -------------------- | ------------------- | ------------------------------------- |
| `< threshold`        | `--sound-blip`      | per-comparison / per-swap click       |
| `>= threshold`       | `--sound-completion`| completion tones, victory arpeggios   |

Sample files can be any format ffmpeg can decode (WAV, MP3, AIFF, FLAC, OGG…). They're resampled to the output rate and mixed as stereo. If you only supply one flag, only those events get sound; others are silent.

The two audio modes are **mutually exclusive**. If you pass neither, the output has no audio track.

### About `--hide-chrome`

By default, **the Stage's playback bar stays visible** in the output — it's part of the Cosmic Zoom aesthetic and many other Claude Design pieces use it intentionally. Pass `--hide-chrome` if you'd rather render a clean, full-bleed canvas (the typical "production render" case).

If your input uses a custom Stage variant the heuristic doesn't match, write your own rules into a file and pass `--inject-css ./tweaks.css`.

## How it works

When you call `requestAnimationFrame(cb)` in a browser, the browser fires `cb` roughly every 1/60th of a second of *wall-clock* time. That's wrong for video rendering: if a frame takes 200 ms to capture, real time has moved on, but virtual time should not have.

So `claude2vid` injects a small shim before any page script runs. It replaces:

- `Date`, `Date.now()`
- `performance.now()`
- `requestAnimationFrame`, `cancelAnimationFrame`
- `setTimeout`, `clearTimeout`
- `setInterval`, `clearInterval`

…with virtual versions backed by a single `virtualNow` counter. The host (Node) then calls `window.__advanceFrame(1000/fps)` on each iteration, which moves `virtualNow` forward, drains any timers whose deadline has passed, and fires the rAF callbacks. The page genuinely believes time is flowing at exactly the right rate, no matter how long the screenshot takes.

The original timing APIs are stashed under `window.__real.*` so the host can still do real-macrotask waits (used to let React's scheduler commit before screenshotting).

## Known limitations

- **CSS `@keyframes` / `transition`** are not controlled by the virtual clock. They run on real time and will look wrong at non-realtime fps. Most Claude Design animations drive everything from JS, so this rarely bites; if it does, set `* { animation-duration: 0s !important; transition: none !important; }` in `--inject-css` and rely on JS-driven motion.
- **External network calls** must complete before rendering. We wait for `networkidle0` and `document.fonts.ready`, which handles fonts/CDN scripts but won't help if your animation lazy-loads data mid-playback.
- **Audio capture limits**: capture mode covers oscillators, gains, filters, delays, compressors, panners, and buffer sources — everything in standard Web Audio. `AudioWorklet` and `MediaStream` sources aren't tested and probably won't capture cleanly. If a page uses HTML5 `<audio>` elements (separate from Web Audio), they're ignored entirely.
- **WebGL** content is fine — it advances per `rAF`, which we control.

## Prior art

This project owes its core technique to:

- [timecut / timesnap / timeweb](https://github.com/tungs/timecut) — Tim Hutton, BSD-3
- Remotion's `@remotion/renderer`
- [Replit's "Lying to the Browser About What Time It Is"](https://blog.replit.com/browsers-dont-want-to-be-cameras)
- WebVideoCreator (WVC)

If you need a more featured framework (audio, GPU encoding, distributed rendering), look at those. `claude2vid` is intentionally tiny.

## License

MIT
