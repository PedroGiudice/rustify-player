import { onMount, onCleanup, createEffect } from "solid-js";
import { onAudioFft, spectrumSubscribe, spectrumUnsubscribe, getTrackColor } from "../tauri";
import { player } from "../store/player";

const LINE_COUNT = 120;
const POINTS_PER_LINE = 140;
const SMOOTHING = 0.12;

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

export default function Visualizer() {
  let canvas: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;
  let animId = 0;
  let unlisten: (() => void) | null = null;

  const fftData = new Uint8Array(128);
  const smoothed = new Float32Array(128);

  let imgData: ImageData | null = null;
  let baseHue = 280;

  // React to track changes — fetch dominant color
  createEffect(async () => {
    const track = player.currentTrack;
    if (!track) return;
    try {
      const hex = await getTrackColor(track.id);
      if (hex && hex.startsWith("#")) {
        const [h] = hexToHsl(hex);
        baseHue = h;
      }
    } catch {}
  });

  function resize() {
    if (!canvas) return;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx = canvas.getContext("2d", { alpha: false });
    ctx?.scale(devicePixelRatio, devicePixelRatio);
  }

  function loadDisplacementImage(url: string) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const offscreen = document.createElement("canvas");
      offscreen.width = POINTS_PER_LINE;
      offscreen.height = LINE_COUNT;
      const octx = offscreen.getContext("2d")!;
      octx.filter = "blur(8px)";
      octx.drawImage(img, 0, 0, POINTS_PER_LINE, LINE_COUNT);
      imgData = octx.getImageData(0, 0, POINTS_PER_LINE, LINE_COUNT);
    };
    img.src = url;
  }

  function draw() {
    animId = requestAnimationFrame(draw);
    if (!ctx || !canvas) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    for (let i = 0; i < fftData.length; i++) {
      smoothed[i] += (fftData[i] - smoothed[i]) * SMOOTHING;
    }

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    if (!imgData) {
      drawBars(ctx, w, h);
      return;
    }

    const bassPulse = smoothed[2] / 255;

    for (let j = 0; j < LINE_COUNT; j++) {
      const depth = j / LINE_COUNT;
      const hue = baseHue + (bassPulse * 30) - 15;

      ctx.strokeStyle = `hsla(${hue}, 85%, ${45 + depth * 20}%, ${0.08 + depth * 0.5})`;
      ctx.lineWidth = 0.6 + depth * 1.2;

      ctx.beginPath();
      for (let i = 0; i < POINTS_PER_LINE; i++) {
        const idx = (i + j * POINTS_PER_LINE) * 4;
        const r = imgData.data[idx];
        const g = imgData.data[idx + 1];
        const b = imgData.data[idx + 2];
        const brightness = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

        const displacement = Math.pow(brightness, 1.5) * (20 + bassPulse * 140);

        const x = (i / (POINTS_PER_LINE - 1)) * w;
        const y = (j / (LINE_COUNT - 1)) * h - displacement + h * 0.1;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function drawBars(c: CanvasRenderingContext2D, w: number, h: number) {
    const barCount = 64;
    const barW = w / barCount;
    for (let i = 0; i < barCount; i++) {
      const val = smoothed[i * 2] / 255;
      const barH = val * h * 0.8;
      const hue = baseHue + (val * 30);
      c.fillStyle = `hsl(${hue}, 80%, ${40 + val * 30}%)`;
      c.fillRect(i * barW, h - barH, barW - 1, barH);
    }
  }

  onMount(() => {
    resize();
    window.addEventListener("resize", resize);

    onAudioFft((data) => {
      for (let i = 0; i < Math.min(data.magnitudes.length, 128); i++) fftData[i] = data.magnitudes[i];
    }).then(unsub => { unlisten = unsub; });

    setTimeout(() => spectrumSubscribe(), 200);
    draw();
  });

  onCleanup(() => {
    cancelAnimationFrame(animId);
    window.removeEventListener("resize", resize);
    spectrumUnsubscribe();
    unlisten?.();
  });

  return (
    <div class="view-content" style="background: #000; height: 100%; padding: 0;">
      <canvas
        ref={canvas!}
        style="width: 100%; height: 100%; display: block;"
      />
    </div>
  );
}
