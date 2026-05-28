// Node-side audio synthesizer. Takes the event log captured by audio-shim.js
// plus user-supplied sample files, mixes everything into a stereo float WAV.

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

// Decode any audio file (WAV/MP3/AIFF/FLAC/etc.) into stereo Float32 PCM at
// the given sample rate using ffmpeg. Returns { left, right, sampleRate, duration }.
export async function loadSample(filePath, sampleRate) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-v', 'error',
      '-i', filePath,
      '-f', 'f32le',
      '-ar', String(sampleRate),
      '-ac', '2',
      '-',
    ], { stdio: ['ignore', 'pipe', 'inherit'] });

    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode failed for ${filePath} (exit ${code})`));
      const buf = Buffer.concat(chunks);
      // Interleaved LRLRLR... 32-bit float
      const interleaved = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const frames = interleaved.length / 2;
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i]  = interleaved[i * 2];
        right[i] = interleaved[i * 2 + 1];
      }
      resolve({ left, right, sampleRate, duration: frames / sampleRate });
    });
  });
}

// Mix one sample into the output buffer at the given start time, with gain.
// Clips at sample boundaries — samples that extend past the output buffer end
// are truncated.
function mixSampleAt(outL, outR, sample, startTimeSec, sampleRate, gain) {
  const startSample = Math.round(startTimeSec * sampleRate);
  const len = Math.min(sample.left.length, outL.length - startSample);
  if (startSample < 0 || len <= 0) return;
  for (let i = 0; i < len; i++) {
    outL[startSample + i] += sample.left[i]  * gain;
    outR[startSample + i] += sample.right[i] * gain;
  }
}

// Encode a stereo float buffer as 32-bit IEEE float WAV.
function encodeWavF32(left, right, sampleRate) {
  const frames = left.length;
  const numChannels = 2;
  const bytesPerSample = 4;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frames * blockAlign;
  const header = Buffer.alloc(44);
  let p = 0;
  header.write('RIFF', p); p += 4;
  header.writeUInt32LE(36 + dataSize, p); p += 4;
  header.write('WAVE', p); p += 4;
  header.write('fmt ', p); p += 4;
  header.writeUInt32LE(16, p); p += 4;
  header.writeUInt16LE(3, p); p += 2;   // 3 = IEEE float
  header.writeUInt16LE(numChannels, p); p += 2;
  header.writeUInt32LE(sampleRate, p); p += 4;
  header.writeUInt32LE(byteRate, p); p += 4;
  header.writeUInt16LE(blockAlign, p); p += 2;
  header.writeUInt16LE(32, p); p += 2;  // bits per sample
  header.write('data', p); p += 4;
  header.writeUInt32LE(dataSize, p);

  const body = Buffer.alloc(dataSize);
  for (let i = 0; i < frames; i++) {
    body.writeFloatLE(left[i],  i * blockAlign);
    body.writeFloatLE(right[i], i * blockAlign + 4);
  }
  return Buffer.concat([header, body]);
}

// Main entry. events: array from window.__getAudioEvents().
// samples: { short?: SampleObj, long?: SampleObj }.
export async function mixAudioEvents({
  events,
  duration,
  sampleRate = 44100,
  thresholdMs = 50,
  samples,
  outputPath,
  normalize = true,
  verbose = false,
}) {
  const totalFrames = Math.ceil(duration * sampleRate);
  const left  = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);

  let shortCount = 0, longCount = 0, dropped = 0;
  for (const ev of events) {
    const durMs = ev.duration * 1000;
    const sample = durMs < thresholdMs ? samples.short : samples.long;
    if (!sample) { dropped++; continue; }
    // peakGain from the page is the envelope peak; clamp into a reasonable range.
    const gain = Math.min(1, Math.max(0, ev.peakGain || 1));
    mixSampleAt(left, right, sample, ev.startTime, sampleRate, gain);
    if (durMs < thresholdMs) shortCount++; else longCount++;
  }

  if (verbose) {
    console.error(`[audio-mixer] mixed ${shortCount} short + ${longCount} long events (dropped ${dropped})`);
  }

  // Optional normalize to avoid clipping when many samples overlap.
  if (normalize) {
    let peak = 0;
    for (let i = 0; i < totalFrames; i++) {
      const a = Math.abs(left[i]);  if (a > peak) peak = a;
      const b = Math.abs(right[i]); if (b > peak) peak = b;
    }
    if (peak > 1.0) {
      const scale = 0.98 / peak;
      for (let i = 0; i < totalFrames; i++) { left[i] *= scale; right[i] *= scale; }
      if (verbose) console.error(`[audio-mixer] normalized: peak ${peak.toFixed(3)} -> 0.98`);
    }
  }

  const wav = encodeWavF32(left, right, sampleRate);
  await fs.writeFile(outputPath, wav);
  return { shortCount, longCount, dropped, sampleRate, totalFrames };
}
