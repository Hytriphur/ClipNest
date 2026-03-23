import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export async function createImageThumb(opts: {
  inputPath: string;
  outputPath: string;
  maxWidth: number;
}) {
  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
  await sharp(opts.inputPath).resize({ width: opts.maxWidth, withoutEnlargement: true }).webp({ quality: 82 }).toFile(opts.outputPath);
}

function findFfmpeg(): string | null {
  // Prefer PATH; allow optional dependency later if we add ffmpeg-static.
  return 'ffmpeg';
}

export async function createVideoThumbIfPossible(opts: {
  inputPath: string;
  outputPath: string;
  maxWidth: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };

  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });

  // Extract a single frame.
  // We use a small seek to avoid black frames at t=0 for some videos.
  const args = [
    '-y',
    '-ss',
    '0.12',
    '-i',
    opts.inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${opts.maxWidth}:-1`,
    opts.outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const p = childProcess.spawn(ffmpeg, args, { stdio: 'ignore' });
    p.on('error', (err) => reject(err));
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit code ${code}`));
    });
  });

  return { ok: true };
}

