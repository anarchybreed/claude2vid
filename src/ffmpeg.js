// ffmpeg launcher: reads PNG frames from stdin (image2pipe) and produces an
// H.264 / yuv420p MP4 with +faststart for direct streaming/upload.

import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export function startFfmpeg({
  fps,
  width,
  height,
  output,
  crf = 18,
  preset = 'medium',
  verbose = false,
}) {
  // Even dimensions are required by yuv420p. Round up if needed.
  const w = width  % 2 === 0 ? width  : width  + 1;
  const h = height % 2 === 0 ? height : height + 1;

  const padFilter = (w !== width || h !== height)
    ? ['-vf', `pad=${w}:${h}:0:0:color=black`]
    : [];

  const args = [
    '-y',
    '-loglevel', verbose ? 'info' : 'error',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-i', '-',
    ...padFilter,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', preset,
    '-crf', String(crf),
    '-movflags', '+faststart',
    output,
  ];

  if (verbose) console.error(`[ffmpeg] ${ffmpegPath} ${args.join(' ')}`);

  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'inherit', 'inherit'] });

  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });

  // Surface stdin write errors instead of dying silently on EPIPE.
  proc.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') console.error('[ffmpeg stdin]', err);
  });

  return { stdin: proc.stdin, done, proc };
}

// Mux a silent video with an audio track into a final MP4. Copies video stream
// (no re-encode), encodes audio as AAC.
export function muxVideoAudio({ videoPath, audioPath, outputPath, verbose = false }) {
  const args = [
    '-y',
    '-loglevel', verbose ? 'info' : 'error',
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ];

  if (verbose) console.error(`[ffmpeg-mux] ${ffmpegPath} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg mux exited with code ${code}`));
    });
  });
}
