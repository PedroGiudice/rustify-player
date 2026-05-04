import { onMount, onCleanup, createEffect } from "solid-js";
import { onAudioFft, getTrackColor } from "../tauri";
import { player } from "../store/player";

const LINE_COUNT = 100;
const POINTS_PER_LINE = 120;
const SMOOTHING = 0.25;
const RAW_BANDS = 512;
const LOG_BANDS = 128;

// Pre-compute log-spaced bin mapping: 128 perceptual bins from 512 linear bins.
// Low frequencies get more resolution (bins 0-20 → ~40% of output).
const logBinMap: [number, number][] = (() => {
  const map: [number, number][] = [];
  for (let i = 0; i < LOG_BANDS; i++) {
    const t = i / LOG_BANDS;
    // Exponential mapping: more bins devoted to low freqs
    const startFrac = Math.pow(t, 2.5);
    const endFrac = Math.pow((i + 1) / LOG_BANDS, 2.5);
    const start = Math.floor(startFrac * RAW_BANDS);
    const end = Math.max(start + 1, Math.floor(endFrac * RAW_BANDS));
    map.push([start, end]);
  }
  return map;
})();

function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return h * 360;
}

interface NormalMap {
  brightness: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  width: number;
  height: number;
}

function computeNormalMap(imgData: ImageData): NormalMap {
  const w = imgData.width;
  const h = imgData.height;
  const brightness = new Float32Array(w * h);
  const nx = new Float32Array(w * h);
  const ny = new Float32Array(w * h);

  // Extract luminance
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    brightness[i] =
      (0.2126 * imgData.data[idx] + 0.7152 * imgData.data[idx + 1] + 0.0722 * imgData.data[idx + 2]) / 255;
  }

  // Sobel gradients → normal direction (perpendicular to contour)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      // Sobel X
      const gx =
        -brightness[(y - 1) * w + (x - 1)] + brightness[(y - 1) * w + (x + 1)] +
        -2 * brightness[y * w + (x - 1)] + 2 * brightness[y * w + (x + 1)] +
        -brightness[(y + 1) * w + (x - 1)] + brightness[(y + 1) * w + (x + 1)];
      // Sobel Y
      const gy =
        -brightness[(y - 1) * w + (x - 1)] - 2 * brightness[(y - 1) * w + x] - brightness[(y - 1) * w + (x + 1)] +
        brightness[(y + 1) * w + (x - 1)] + 2 * brightness[(y + 1) * w + x] + brightness[(y + 1) * w + (x + 1)];

      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag > 0.01) {
        nx[idx] = gx / mag;
        ny[idx] = gy / mag;
      }
    }
  }

  return { brightness, nx, ny, width: w, height: h };
}

export default function SpectrumBackground(props: { shapeUrl?: string | null }) {
  let canvas: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;
  let animId = 0;
  let unlisten: (() => void) | null = null;

  const rawFft = new Uint8Array(RAW_BANDS);
  const smoothed = new Float32Array(LOG_BANDS);
  let baseHue = 260;
  let normalMap: NormalMap | null = null;

  createEffect(async () => {
    const track = player.currentTrack;
    if (!track) return;
    try {
      const hex = await getTrackColor(track.id);
      if (hex?.startsWith("#")) baseHue = hexToHue(hex);
    } catch {}
  });

  function loadShape(url: string) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const offscreen = document.createElement("canvas");
      offscreen.width = POINTS_PER_LINE;
      offscreen.height = LINE_COUNT;
      const octx = offscreen.getContext("2d")!;
      octx.filter = "blur(4px)";
      octx.drawImage(img, 0, 0, POINTS_PER_LINE, LINE_COUNT);
      const imgData = octx.getImageData(0, 0, POINTS_PER_LINE, LINE_COUNT);
      normalMap = computeNormalMap(imgData);
    };
    img.src = url;
  }

  function resize() {
    if (!canvas) return;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx = canvas.getContext("2d", { alpha: false });
    ctx?.scale(devicePixelRatio, devicePixelRatio);
  }

  function draw() {
    animId = requestAnimationFrame(draw);
    if (!ctx || !canvas) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // Log-remap 512 linear bins → 128 perceptual bins, then smooth
    for (let i = 0; i < LOG_BANDS; i++) {
      const [start, end] = logBinMap[i];
      let max = 0;
      for (let j = start; j < end && j < RAW_BANDS; j++) {
        if (rawFft[j] > max) max = rawFft[j];
      }
      smoothed[i] += (max - smoothed[i]) * SMOOTHING;
    }

    ctx.fillStyle = "#080808";
    ctx.fillRect(0, 0, w, h);

    const bassPulse = smoothed[2] / 255;
    const midEnergy = (smoothed[8] + smoothed[12] + smoothed[16]) / (255 * 3);

    if (normalMap) {
      drawWithShape(ctx, w, h, bassPulse, midEnergy);
    } else {
      drawBars(ctx, w, h, bassPulse, midEnergy);
    }
  }

  function drawWithShape(c: CanvasRenderingContext2D, w: number, h: number, bassPulse: number, midEnergy: number) {
    const nm = normalMap!;

    // Frequency regions: sub-bass, bass, low-mid, mid, high-mid, presence, brilliance
    const regions = [
      { start: 0, end: 4, label: "sub" },
      { start: 4, end: 12, label: "bass" },
      { start: 12, end: 24, label: "lowmid" },
      { start: 24, end: 40, label: "mid" },
      { start: 40, end: 56, label: "himid" },
      { start: 56, end: 80, label: "presence" },
      { start: 80, end: 128, label: "brilliance" },
    ];

    // Pre-compute energy per region
    const regionEnergy = regions.map(r => {
      let sum = 0;
      for (let i = r.start; i < r.end; i++) sum += smoothed[i];
      return sum / ((r.end - r.start) * 255);
    });

    for (let j = 0; j < LINE_COUNT; j++) {
      const depth = j / LINE_COUNT;
      // Map line position to frequency region (bottom=sub-bass, top=brilliance)
      const regionIdx = Math.min(Math.floor(depth * regions.length), regions.length - 1);
      const bandEnergy = regionEnergy[regionIdx];
      // Blend with neighbor regions for smoother transition
      const prevEnergy = regionIdx > 0 ? regionEnergy[regionIdx - 1] : bandEnergy;
      const nextEnergy = regionIdx < regions.length - 1 ? regionEnergy[regionIdx + 1] : bandEnergy;
      const blendedEnergy = prevEnergy * 0.2 + bandEnergy * 0.6 + nextEnergy * 0.2;

      const hue = baseHue + (bassPulse * 25) - 12;
      const alpha = 0.12 + blendedEnergy * 0.75 + depth * 0.1;
      const lightness = 40 + depth * 15 + blendedEnergy * 25;

      c.strokeStyle = `hsla(${hue}, 80%, ${lightness}%, ${alpha})`;
      c.lineWidth = 0.5 + blendedEnergy * 2.0;

      c.beginPath();
      for (let i = 0; i < POINTS_PER_LINE; i++) {
        const nmIdx = j * nm.width + i;
        const bright = nm.brightness[nmIdx];
        const dirX = nm.nx[nmIdx];
        const dirY = nm.ny[nmIdx];

        const strength = bright * (10 + blendedEnergy * 180);

        const baseX = (i / (POINTS_PER_LINE - 1)) * w;
        const baseY = (j / (LINE_COUNT - 1)) * h;

        const x = baseX + dirX * strength;
        const y = baseY + dirY * strength;

        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.stroke();
    }
  }

  function drawBars(c: CanvasRenderingContext2D, w: number, h: number, _bassPulse: number, _midEnergy: number) {
    const barCount = 64;
    const barW = w / barCount;
    for (let i = 0; i < barCount; i++) {
      const val = smoothed[i * 2] / 255;
      const barH = val * h * 0.85;
      const hue = baseHue + (val * 30);
      c.fillStyle = `hsl(${hue}, 80%, ${35 + val * 30}%)`;
      c.fillRect(i * barW + 1, h - barH, barW - 2, barH);
    }
  }

  createEffect(() => {
    const url = props.shapeUrl;
    if (url) loadShape(url);
    else normalMap = null;
  });

  onMount(async () => {
    resize();
    window.addEventListener("resize", resize);

    unlisten = await onAudioFft((data) => {
      for (let i = 0; i < Math.min(data.length, RAW_BANDS); i++) {
        rawFft[i] = data[i];
      }
    });

    draw();
  });

  onCleanup(() => {
    cancelAnimationFrame(animId);
    window.removeEventListener("resize", resize);
    unlisten?.();
  });

  return (
    <canvas
      ref={canvas!}
      class="np-bg__el"
      style="width: 100%; height: 100%; display: block; position: absolute; top: 0; left: 0;"
    />
  );
}
