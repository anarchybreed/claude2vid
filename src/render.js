// Orchestrator: serves the input dir, launches Puppeteer, injects the virtual
// clock, drives the frame loop, pipes screenshots into ffmpeg.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';

import { startServer } from './server.js';
import { startFfmpeg, muxVideoAudio } from './ffmpeg.js';
import { clockShimSource } from './clock-shim.js';
import { audioShimSource } from './audio-shim.js';
import { buildAudioCaptureShim } from './audio-capture-shim.js';
import { detectMeta, chromeHideCSS } from './claude-design.js';
import { loadSample, mixAudioEvents } from './audio-mixer.js';

const DEFAULTS = { width: 1920, height: 1080, fps: 60, crf: 18, preset: 'medium' };

function log(verbose, ...args) {
  if (verbose) console.error('[claude2vid]', ...args);
}

export async function render({
  input,
  output,
  width,
  height,
  duration,
  fps = DEFAULTS.fps,
  crf = DEFAULTS.crf,
  preset = DEFAULTS.preset,
  hideChrome = false,
  injectCss,
  keepFrames,
  selector,
  soundBlip,
  soundCompletion,
  soundThresholdMs = 50,
  capturePageAudio = false,
  verbose = false,
}) {
  if (capturePageAudio && (soundBlip || soundCompletion)) {
    throw new Error('--capture-page-audio is mutually exclusive with --sound-blip / --sound-completion');
  }
  const inputAbs = path.resolve(input);
  const inputDir = path.dirname(inputAbs);
  const inputFile = path.basename(inputAbs);

  await fs.access(inputAbs); // throws if missing

  // Resolve provisional dimensions: CLI > file-scanned > defaults.
  // Duration may still be null at this point — Contract B pages declare it
  // via window.__vb (read after page load), so we defer that check.
  const detected = await detectMeta(inputAbs);
  let finalWidth   = Number(width  ?? detected.width  ?? DEFAULTS.width);
  let finalHeight  = Number(height ?? detected.height ?? DEFAULTS.height);
  let finalDuration = duration != null ? Number(duration)
                    : detected.duration != null ? Number(detected.duration)
                    : null;
  const finalOutput = output ?? path.join(inputDir, inputFile.replace(/\.[^.]+$/, '') + '.mp4');

  log(verbose, `input:    ${inputAbs}`);
  log(verbose, `detected: ${JSON.stringify(detected)}`);
  log(verbose, `output:   ${finalOutput}`);
  log(verbose, `hideChrome: ${hideChrome}`);

  const customCss = injectCss ? await fs.readFile(path.resolve(injectCss), 'utf8') : '';

  const server = await startServer(inputDir);
  log(verbose, `serving ${inputDir} at ${server.url}`);

  let framesDir = null;
  if (keepFrames) {
    framesDir = path.resolve(keepFrames);
    await fs.mkdir(framesDir, { recursive: true });
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--hide-scrollbars'],
  });

  // Capture-mode audio shim sizes its OfflineAudioContext at injection time,
  // which is before page load — so it needs duration up-front. Resolve via
  // CLI/file scan only for this code path; Contract B pages can't combine
  // --capture-page-audio with __vb-supplied duration.
  if (capturePageAudio && finalDuration == null) {
    throw new Error(
      `--capture-page-audio requires a known duration before page load.\n` +
      `  Pass --duration <seconds> (window.__vb.duration is read too late for audio sizing).`
    );
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: finalWidth, height: finalHeight, deviceScaleFactor: 1 });

    // Inject the virtual clock + audio shim BEFORE any page JS runs.
    // Audio shim choice: capture mode wraps a real OfflineAudioContext so the
    // page's actual synth output is preserved; otherwise the lightweight mock
    // just records event metadata for sample replacement.
    await page.evaluateOnNewDocument(clockShimSource);
    if (capturePageAudio) {
      await page.evaluateOnNewDocument(buildAudioCaptureShim({ durationSeconds: finalDuration }));
    } else {
      await page.evaluateOnNewDocument(audioShimSource);
    }

    // Forward page console messages when verbose.
    if (verbose) {
      page.on('console', m => console.error(`[page:${m.type()}]`, m.text()));
      page.on('pageerror', e => console.error('[pageerror]', e.message));
    }

    // Always append ?export=1 — Contract B pages key off this to hide their
    // own chrome, skip localStorage, and autoplay from t=0. Pages that don't
    // handle it ignore the param.
    const url = `${server.url}/${encodeURIComponent(inputFile)}?export=1`;
    log(verbose, `goto: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });

    // Wait for fonts and for some content to mount in body.
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForFunction(
      () => !!window.__claude2vid_clock && !!document.body && document.body.children.length > 0,
      { timeout: 30_000 }
    );

    // Contract B: read window.__vb if the page exposed it. Page-declared
    // dims/duration take precedence over file-scanned values, but CLI flags
    // still win. fps from __vb is read but only adopted if --fps wasn't
    // overridden (we can't distinguish "user passed --fps 60" from "default";
    // safest is to honour __vb.fps only when it differs from the default).
    const vb = await page.evaluate(() => {
      const v = window.__vb;
      if (!v || typeof v !== 'object') return null;
      const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
      return { width: num(v.width), height: num(v.height), duration: num(v.duration), fps: num(v.fps) };
    });

    if (vb) {
      log(verbose, `__vb:     ${JSON.stringify(vb)}`);
      const newW = width  != null ? finalWidth  : (vb.width  ?? finalWidth);
      const newH = height != null ? finalHeight : (vb.height ?? finalHeight);
      if (duration == null && vb.duration != null) finalDuration = vb.duration;
      if (newW !== finalWidth || newH !== finalHeight) {
        finalWidth = newW;
        finalHeight = newH;
        await page.setViewport({ width: finalWidth, height: finalHeight, deviceScaleFactor: 1 });
      }
    }

    // Now enforce the duration check — both Contract A and B have had their say.
    if (finalDuration == null) {
      throw new Error(
        `could not determine animation duration.\n` +
        `  The input HTML exposes neither a <Stage duration={...}> prop nor a window.__vb.duration value,\n` +
        `  and no --duration flag was given.\n` +
        `  Pass --duration <seconds> to set it explicitly (e.g. --duration 30).`
      );
    }
    log(verbose, `using:    ${finalWidth}x${finalHeight} @ ${fps}fps, ${finalDuration}s`);

    // Contract B pages handle their own chrome via ?export=1. Skip the
    // harness CSS injection — it targets the React Stage DOM shape and will
    // mis-hide content on hand-rolled layouts.
    if (vb && hideChrome) {
      log(verbose, `--hide-chrome ignored: page exposes window.__vb and handles chrome via ?export=1`);
    }
    const cssBlobs = [];
    if (hideChrome && !vb) cssBlobs.push(chromeHideCSS);
    if (customCss) cssBlobs.push(customCss);
    if (cssBlobs.length) {
      await page.addStyleTag({ content: cssBlobs.join('\n') });
    }

    // Prime the rAF loop: many animation loops (including the Stage example)
    // skip their first frame's delta because lastTsRef starts null. Calling
    // __advanceFrame(0) lets the first rAF run, set its baseline, and re-queue
    // — so frame 1 onwards reports a correct dt. Also flushes any boot-time
    // setTimeout(0) / rAF callbacks the page queued, which is how Contract B
    // pages flip __vbReady under the virtual clock.
    await page.evaluate(() => window.__advanceFrame(0));
    await flushRealMacrotasks(page);

    // Contract B: now wait for the page's own first-paint signal. The prime
    // tick above should have fired the page's markReady() callbacks (rAF +
    // setTimeout(0) both drain on the first __advanceFrame). 10s cap so we
    // don't hang if the page never sets it.
    if (vb) {
      try {
        await page.waitForFunction(() => window.__vbReady === true, { timeout: 10_000 });
        log(verbose, `__vbReady: ok`);
      } catch {
        log(verbose, `__vbReady: never set within 10s — proceeding anyway`);
      }
    }

    // If any audio path is requested (capture or replacement), render video to
    // a temp file first and mux audio in at the end. Otherwise write straight
    // to the final output.
    const wantAudio = !!(soundBlip || soundCompletion);
    const audioPipelineActive = wantAudio || capturePageAudio;
    const videoTarget = audioPipelineActive
      ? path.join(os.tmpdir(), `claude2vid-${Date.now()}-${process.pid}-video.mp4`)
      : finalOutput;

    // Start ffmpeg.
    const ffmpeg = startFfmpeg({
      fps,
      width: finalWidth,
      height: finalHeight,
      output: videoTarget,
      crf,
      preset,
      verbose,
    });

    const frameCount = Math.round(finalDuration * fps);
    const dt = 1000 / fps;
    const screenshotOpts = {
      type: 'png',
      clip: { x: 0, y: 0, width: finalWidth, height: finalHeight },
      omitBackground: false,
    };
    if (selector) {
      delete screenshotOpts.clip;
    }

    log(verbose, `rendering ${frameCount} frames`);
    const tStart = Date.now();
    let lastReport = tStart;

    for (let i = 0; i < frameCount; i++) {
      if (i > 0) {
        await page.evaluate((d) => window.__advanceFrame(d), dt);
      }
      // Let React commit any pending state updates and the compositor paint.
      await flushRealMacrotasks(page);

      let png;
      if (selector) {
        const el = await page.$(selector);
        if (!el) throw new Error(`--selector ${JSON.stringify(selector)} matched no element`);
        png = await el.screenshot({ type: 'png' });
      } else {
        png = await page.screenshot(screenshotOpts);
      }

      if (framesDir) {
        await fs.writeFile(path.join(framesDir, `frame-${String(i).padStart(6, '0')}.png`), png);
      }

      const ok = ffmpeg.stdin.write(png);
      if (!ok) await new Promise(r => ffmpeg.stdin.once('drain', r));

      const now = Date.now();
      if (verbose && now - lastReport > 2000) {
        const fpsActual = ((i + 1) / ((now - tStart) / 1000)).toFixed(1);
        log(verbose, `frame ${i + 1}/${frameCount}  (${fpsActual} fps capture)`);
        lastReport = now;
      }
    }

    ffmpeg.stdin.end();
    await ffmpeg.done;
    log(verbose, `video pass: ${videoTarget} in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

    // Audio pass — two flavors:
    //   (a) capture mode: page actually rendered into an OfflineAudioContext;
    //       we just trigger startRendering + upload the WAV.
    //   (b) replacement mode: we collected event metadata; mix user samples in.
    let audioStats = null;
    let audioTmp = null;

    if (capturePageAudio) {
      audioTmp = path.join(os.tmpdir(), `claude2vid-${Date.now()}-${process.pid}-audio.wav`);
      server.setUploadPath(audioTmp);
      const uploadUrl = `${server.url}/__upload_audio`;
      log(verbose, `triggering page audio render -> ${uploadUrl}`);
      const meta = await page.evaluate(async (u) => {
        return await window.__renderAndUploadAudio(u);
      }, uploadUrl);
      if (!meta || !meta.rendered) {
        log(true, `capture mode: page never constructed an AudioContext — output will be silent`);
        audioTmp = null;
      } else {
        log(verbose, `captured ${meta.durationSeconds.toFixed(2)}s of ${meta.numChannels}ch audio @ ${meta.sampleRate}Hz (${(meta.bytes / 1024 / 1024).toFixed(1)} MB)`);
        audioStats = { mode: 'capture', ...meta };
      }
    } else if (wantAudio) {
      const events = await page.evaluate(() => window.__getAudioEvents ? window.__getAudioEvents() : []);
      log(verbose, `audio events captured: ${events.length}`);

      // Warn if events extend close to the end of the rendered window — likely truncation.
      if (events.length > 0) {
        const maxEnd = Math.max(...events.map(e => e.endTime));
        if (maxEnd >= finalDuration * 0.99) {
          const suggested = Math.ceil(maxEnd + 3);
          console.warn(
            `WARNING: audio events extend to t=${maxEnd.toFixed(2)}s but render duration is ${finalDuration}s.\n` +
            `         The animation is likely still playing past the end of the video.\n` +
            `         Re-run with --duration ${suggested} to capture the rest.`
          );
        }
      }

      const sampleRate = 44100;
      const samples = {};
      if (soundBlip)       samples.short = await loadSample(path.resolve(soundBlip), sampleRate);
      if (soundCompletion) samples.long  = await loadSample(path.resolve(soundCompletion), sampleRate);

      audioTmp = path.join(os.tmpdir(), `claude2vid-${Date.now()}-${process.pid}-audio.wav`);
      audioStats = {
        mode: 'replace',
        ...await mixAudioEvents({
          events,
          duration: finalDuration,
          sampleRate,
          thresholdMs: soundThresholdMs,
          samples,
          outputPath: audioTmp,
          verbose,
        }),
      };
    }

    if (audioPipelineActive) {
      if (audioTmp) {
        log(verbose, `muxing video + audio -> ${finalOutput}`);
        await muxVideoAudio({ videoPath: videoTarget, audioPath: audioTmp, outputPath: finalOutput, verbose });
        await fs.unlink(audioTmp).catch(() => {});
      } else {
        // No audio was produced — just promote the video temp to the final output.
        await fs.rename(videoTarget, finalOutput);
      }
      await fs.unlink(videoTarget).catch(() => {});
    }

    log(verbose, `done: ${finalOutput} in ${((Date.now() - tStart) / 1000).toFixed(1)}s total`);
    return {
      output: finalOutput,
      width: finalWidth, height: finalHeight,
      duration: finalDuration, fps, frames: frameCount,
      audio: audioStats,
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

// Real-macrotask escape hatch: setTimeout/rAF are patched in the page, but the
// shim stashed originals under window.__real. Wait one real macrotask so that
// React's scheduler (which uses MessageChannel / setImmediate-ish) can commit
// before we screenshot.
async function flushRealMacrotasks(page) {
  await page.evaluate(() => new Promise(r => window.__real.setTimeout(r, 0)));
}
