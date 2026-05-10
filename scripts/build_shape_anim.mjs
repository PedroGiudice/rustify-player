#!/usr/bin/env node
// Pre-generate animated shape pack from a video.
//
// Algorithm mirrors loadShape() in src/components/SpectrumBackground_V2.tsx:
//  1. Each video frame is greyscale + blurred (sum of base + blur16*0.5 + blur6*0.7).
//  2. Per-pixel brightness is computed with deterministic dither.
//  3. Sobel kernel produces gx/gy; magnitude > 0.005 yields a normal direction.
//  4. R=brightness, G=normal_x, B=normal_y is packed into an RGB PNG.
//
// Output layout: <out_dir>/<name>/{manifest.json, normal_NNNN.png, color.png}
//
// Usage:
//   node scripts/build_shape_anim.mjs --video <path> --name <slug> --frames 48 --dim 700 --out <dir>

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    video: null,
    name: null,
    frames: 48,
    dim: 700,
    out: path.join(os.homedir(), ".local/share/rustify-player/media/shapes"),
    color_frame: null,
    blur_strength: 1.0,
    pixel_art: false,
  };
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    const v = args[i + 1];
    if (k === "--video") { out.video = v; i++; }
    else if (k === "--name") { out.name = v; i++; }
    else if (k === "--frames") { out.frames = parseInt(v, 10); i++; }
    else if (k === "--dim") { out.dim = parseInt(v, 10); i++; }
    else if (k === "--out") { out.out = v; i++; }
    else if (k === "--color-frame") { out.color_frame = parseInt(v, 10); i++; }
    else if (k === "--blur-strength") { out.blur_strength = parseFloat(v); i++; }
    else if (k === "--pixel-art") { out.pixel_art = true; }
  }
  if (!out.video || !out.name) {
    console.error("Usage: --video PATH --name SLUG [--frames 48] [--dim 700] [--out DIR] [--color-frame N] [--blur-strength 1.0] [--pixel-art]");
    process.exit(1);
  }
  return out;
}

async function probeDuration(videoPath) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
  ], { encoding: "utf8" });
  return parseFloat(r.stdout.trim());
}

async function extractFrames(videoPath, tmpDir, frameCount, sourceDuration) {
  await fs.mkdir(tmpDir, { recursive: true });
  // Sample uniformly across the duration regardless of source fps.
  const targetFps = frameCount / sourceDuration;
  const r = spawnSync("ffmpeg", [
    "-y", "-i", videoPath,
    "-vf", `fps=${targetFps}`,
    "-frames:v", String(frameCount),
    path.join(tmpDir, "f_%04d.png"),
  ], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr);
    throw new Error("ffmpeg extract failed");
  }
}

async function processFrame(inputPath, dim, blurStrength = 1.0) {
  // Decode → resize → greyscale.
  const base = await sharp(inputPath)
    .resize(dim, dim, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Two blurred copies, summed with weights matching canvas filter:blur + globalAlpha.
  // CSS blur(Npx) ≈ Gaussian sigma = N/2 → blur(16px)→σ=8, blur(6px)→σ=3.
  // blur_strength scales weights uniformly (0 = base only, 1 = default, 2 = double).
  // Skip blur computation when strength is 0 — saves 2 sharp passes per frame.
  const skipBlur = blurStrength <= 0;
  const blur16 = skipBlur ? null : await sharp(inputPath)
    .resize(dim, dim, { fit: "fill" })
    .greyscale()
    .blur(8)
    .raw()
    .toBuffer();

  const blur6 = skipBlur ? null : await sharp(inputPath)
    .resize(dim, dim, { fit: "fill" })
    .greyscale()
    .blur(3)
    .raw()
    .toBuffer();

  const w = dim, h = dim;
  const baseBuf = base.data;
  // Sharp greyscale raw output is single-channel.
  const channels = base.info.channels;
  const stride = channels;

  const w16 = 0.5 * blurStrength;
  const w6 = 0.7 * blurStrength;
  const brightness = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = baseBuf[i * stride] / 255;
    const b16 = skipBlur ? 0 : blur16[i * stride] / 255;
    const b6 = skipBlur ? 0 : blur6[i * stride] / 255;
    // Composition: base*1.0 + blur16*w16 + blur6*w6 (w* scaled by blur_strength).
    let v = a + b16 * w16 + b6 * w6;
    // Clamp and apply same deterministic dither used at runtime.
    if (v > 1) v = 1;
    const noise = ((Math.sin(i * 43758.5453) * 43758.5453) % 1) * 0.06 - 0.03;
    v += noise;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    brightness[i] = v;
  }

  const packed = Buffer.alloc(w * h * 3);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -brightness[(y-1)*w+(x-1)] + brightness[(y-1)*w+(x+1)]
                 -2*brightness[y*w+(x-1)] + 2*brightness[y*w+(x+1)]
                 -brightness[(y+1)*w+(x-1)] + brightness[(y+1)*w+(x+1)];
      const gy = -brightness[(y-1)*w+(x-1)] - 2*brightness[(y-1)*w+x] - brightness[(y-1)*w+(x+1)]
                 + brightness[(y+1)*w+(x-1)] + 2*brightness[(y+1)*w+x] + brightness[(y+1)*w+(x+1)];
      const mag = Math.sqrt(gx * gx + gy * gy);
      let nx = 0.5, ny = 0.5;
      if (mag > 0.005) {
        nx = (-gy / mag) * 0.5 + 0.5;
        ny = ( gx / mag) * 0.5 + 0.5;
      }
      const off = i * 3;
      packed[off]     = Math.floor(brightness[i] * 255);
      packed[off + 1] = Math.floor(nx * 255);
      packed[off + 2] = Math.floor(ny * 255);
    }
  }

  return sharp(packed, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function main() {
  const args = parseArgs();
  const duration = await probeDuration(args.video);
  if (!duration || isNaN(duration)) throw new Error("could not probe duration");
  console.log(`source: ${args.video} (${duration.toFixed(2)}s)`);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shape-anim-"));
  console.log(`extracting ${args.frames} frames → ${tmp}`);
  await extractFrames(args.video, tmp, args.frames, duration);

  const targetDir = path.join(args.out, args.name);
  await fs.mkdir(targetDir, { recursive: true });

  const frames = (await fs.readdir(tmp)).filter(f => f.endsWith(".png")).sort();
  if (frames.length === 0) throw new Error("no frames extracted");

  for (let i = 0; i < frames.length; i++) {
    const idx = String(i).padStart(4, "0");
    const out = path.join(targetDir, `normal_${idx}.png`);
    const buf = await processFrame(path.join(tmp, frames[i]), args.dim, args.blur_strength);
    await fs.writeFile(out, buf);

    // Per-frame color: pixel-art mode preserves blocks (PNG, full dim, nearest);
    // default mode optimizes size (JPEG q82 downsized to 512).
    if (args.pixel_art) {
      const colorOut = path.join(targetDir, `color_${idx}.png`);
      await sharp(path.join(tmp, frames[i]))
        .resize(args.dim, args.dim, { fit: "inside", kernel: "nearest" })
        .png({ compressionLevel: 9 })
        .toFile(colorOut);
    } else {
      const colorOut = path.join(targetDir, `color_${idx}.jpg`);
      await sharp(path.join(tmp, frames[i]))
        .resize(512, 512, { fit: "inside" })
        .jpeg({ quality: 82 })
        .toFile(colorOut);
    }

    process.stdout.write(`\rprocessed ${i + 1}/${frames.length}`);
  }
  process.stdout.write("\n");

  const colorIdx = args.color_frame ?? Math.floor(frames.length / 2);
  const colorSrc = path.join(tmp, frames[Math.min(colorIdx, frames.length - 1)]);
  await sharp(colorSrc).png().toFile(path.join(targetDir, "color.png"));

  const manifest = {
    name: args.name,
    frames: frames.length,
    dim: args.dim,
    duration_seconds: duration,
    source_fps: frames.length / duration,
    color_frames: true,
    pixel_art: args.pixel_art,
    generated_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`wrote ${targetDir}`);

  await fs.rm(tmp, { recursive: true, force: true });
}

main().catch(e => { console.error(e); process.exit(1); });
