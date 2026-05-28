#!/usr/bin/env node
// claude2vid CLI — `claude2vid render <input.html>` produces an MP4.

import { Command } from 'commander';
import { render } from './render.js';

const program = new Command();

program
  .name('claude2vid')
  .description('Convert Claude Design HTML/JS animations into MP4 videos.')
  .version('0.1.0');

program
  .command('render')
  .description('Render an HTML animation file into MP4.')
  .argument('<input>', 'path to the HTML entry file (e.g. ./Cosmic Zoom.html)')
  .option('-o, --output <file>',     'output MP4 path (default: <input>.mp4)')
  .option('--width <px>',            'canvas width (default: detected from Stage, else 1920)', toInt)
  .option('--height <px>',           'canvas height (default: detected from Stage, else 1080)', toInt)
  .option('--duration <seconds>',    'animation duration in seconds (default: detected, else 10)', toFloat)
  .option('--fps <n>',               'frames per second', toInt, 60)
  .option('--crf <n>',               'libx264 CRF (lower = higher quality)', toInt, 18)
  .option('--preset <name>',         'libx264 preset (ultrafast..veryslow)', 'medium')
  .option('--selector <css>',        'CSS selector to screenshot (default: full viewport)')
  .option('--hide-chrome',           'hide the Stage playback bar and reset auto-scale')
  .option('--inject-css <file>',     'path to a CSS file to inject before rendering')
  .option('--keep-frames <dir>',     'write per-frame PNGs into <dir> for debugging')
  .option('--sound-blip <file>',         'sample played at each SHORT audio event (sorting blips)')
  .option('--sound-completion <file>',   'sample played at each LONG audio event (completion notes)')
  .option('--sound-threshold-ms <n>',    'duration cutoff between short/long events in ms', toInt, 50)
  .option('--capture-page-audio',        'capture the page\'s original Web Audio output (mutex with --sound-*)')
  .option('-v, --verbose',           'verbose logging', false)
  .action(async (input, opts) => {
    try {
      const result = await render({
        input,
        output:     opts.output,
        width:      opts.width,
        height:     opts.height,
        duration:   opts.duration,
        fps:        opts.fps,
        crf:        opts.crf,
        preset:     opts.preset,
        selector:   opts.selector,
        hideChrome: !!opts.hideChrome,
        injectCss:  opts.injectCss,
        keepFrames: opts.keepFrames,
        soundBlip:       opts.soundBlip,
        soundCompletion: opts.soundCompletion,
        soundThresholdMs: opts.soundThresholdMs,
        capturePageAudio: !!opts.capturePageAudio,
        verbose:    opts.verbose,
      });
      console.log(`\n  ${result.output}`);
      console.log(`  ${result.width}x${result.height}  ${result.fps}fps  ${result.duration}s  (${result.frames} frames)`);
      if (result.audio) {
        if (result.audio.mode === 'capture') {
          console.log(`  audio: captured ${result.audio.durationSeconds.toFixed(2)}s @ ${result.audio.sampleRate}Hz (${result.audio.numChannels}ch)`);
        } else if (result.audio.mode === 'replace') {
          console.log(`  audio: ${result.audio.shortCount} short + ${result.audio.longCount} long events`);
        }
      }
    } catch (err) {
      console.error('claude2vid: ' + (err.stack || err.message || err));
      process.exit(1);
    }
  });

program.parseAsync(process.argv);

function toInt(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`expected integer, got ${v}`);
  return n;
}
function toFloat(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`expected number, got ${v}`);
  return n;
}
