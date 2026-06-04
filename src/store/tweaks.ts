/* ============================================================
   store/tweaks.ts — Estado dos Tweaks do app (fontes, escala,
   density, sidebar, type, glow). Persiste em localStorage e
   aplica no <html> via applyTweaks(). Migra schema antigo
   (fontScale/zoom) para o novo (scale).
   ============================================================ */

import { createSignal, createEffect } from "solid-js";
import { normSetEnabled, normSetTarget } from "../tauri";

const { invoke } = (window as any).__TAURI__.core;

const STORAGE_KEY = "kv-tweaks";

export type Density = "normal" | "compact";
export type Sidebar = "labels" | "icons";
export type TypeMode = "body" | "mono";

export interface TweaksState {
  fontUI: string;
  fontMono: string;
  scale: number;
  density: Density;
  sidebar: Sidebar;
  type: TypeMode;
  glow: number;
  /** Translucidez da caixa de lyrics (Now Playing).
      0   = quase invisivel (alpha 0.04, brightness 0.92)
      0.5 = meio termo
      1   = quase opaco (alpha 0.30, brightness 0.65) */
  lyricsGlass: number;
  /** Mostra o card de lyrics no Now Playing. Toggle rapido via botao
      na PlayerBar; persiste igual aos demais tweaks. */
  lyricsVisible: boolean;
  /** Cor das linhas do spectrum bg (hex #rrggbb). Default = carbono escuro. */
  bgInk: string;
  /** Overlay de spectrum real (pos-DSP) sob a curva do EQ.
      31 barras ISO 1/3 oitava com peak-hold. Herda --bg-ink-rgb. */
  eqSpectrumOverlay: boolean;

  // ── Bg reactivity ───────────────────────────────────────────
  // Cada gain pondera o envelope da banda correspondente na soma
  // que modula a amplitude do bg. 0 = banda ignorada, 1 = peso
  // neutro, 2 = empurra forte. Mesma escala nas três pra facilitar
  // mental model: "quanto graves importam vs agudos".
  /** Peso dos graves (20-200 Hz). 0..2, default 1. */
  bgBassGain: number;
  /** Peso dos médios (200-2 000 Hz). 0..2, default 1. */
  bgMidGain: number;
  /** Peso dos agudos (2 000-12 000 Hz). 0..2, default 0.8. Mais
      baixo por padrão porque chimbal/hi-hat saturam fácil. */
  bgTrebleGain: number;
  /** Smoothing do envelope final no canvas. 0 = resposta crua
      (~100 ms tau), 1 = bem suave (~800 ms tau). */
  bgSmoothing: number;
  /** Velocidade global da animação do bg (breath + phase + drift +
      shape time). 0 = congela, 1 = nominal, 2 = dobro. Aplicado
      ao tempo virtual antes de propagar pra todas as fórmulas
      time-dependent — mudanças do slider afetam só a derivada,
      sem saltos de fase. */
  bgSpeed: number;

  // ── Loudness ────────────────────────────────────────────────
  /** Normalização de loudness ligada. Default ON (alvo streaming).
      Mapeia pra `norm_set_enabled` no backend. */
  loudnessNorm: boolean;
  /** Alvo de loudness em LUFS. Range UI -20..-6, default -14 (padrão
      streaming). A maioria das masters modernas fica entre -6 e -10,
      então subir o alvo (-10/-8) atenua menos. Mapeia pra
      `norm_set_target`; aplica na faixa tocando agora. */
  loudnessTarget: number;
}

export const DEFAULTS: TweaksState = {
  fontUI: "",
  fontMono: "",
  scale: 1.0,
  density: "normal",
  sidebar: "labels",
  type: "body",
  glow: 0.15,
  lyricsGlass: 0.25,
  lyricsVisible: true,
  bgInk: "#171717",
  eqSpectrumOverlay: true,
  bgBassGain: 1.0,
  bgMidGain: 1.0,
  bgTrebleGain: 0.8,
  bgSmoothing: 0.3,
  bgSpeed: 1.0,
  loudnessNorm: true,
  loudnessTarget: -14,
};

const [state, setState] = createSignal<TweaksState>({ ...DEFAULTS });
export const tweaks = state;

// Open/close do painel — controlado pelo evento "toggle-tweaks".
const [open, setOpen] = createSignal(false);
export const tweaksOpen = open;
export function setTweaksOpen(v: boolean) { setOpen(v); }
export function toggleTweaks() { setOpen((v) => !v); }

// Fontes do sistema — carrega uma vez, cache em memoria.
let fontsCache: string[] | null = null;
export async function listSystemFonts(): Promise<string[]> {
  if (fontsCache) return fontsCache;
  try {
    const list = await invoke<string[]>("list_system_fonts");
    fontsCache = Array.isArray(list) ? list : [];
  } catch (err) {
    console.error("[tweaks] list_system_fonts falhou:", err);
    fontsCache = [];
  }
  return fontsCache;
}

// ── Aplicacao no DOM ──────────────────────────────────────────
export function applyTweaks(s: TweaksState = state()) {
  const html = document.documentElement;

  if (s.fontUI) {
    html.style.setProperty(
      "--font-sans",
      `"${s.fontUI}", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`,
    );
  } else {
    html.style.removeProperty("--font-sans");
  }

  if (s.fontMono) {
    html.style.setProperty(
      "--font-mono",
      `"${s.fontMono}", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace`,
    );
  } else {
    html.style.removeProperty("--font-mono");
  }

  // zoom afeta TUDO inclusive font-size em px hardcoded.
  // Suportado pelo WebKitGTK do Tauri.
  html.style.zoom = String(s.scale);
  html.style.removeProperty("font-size");

  if (s.density === "compact") html.dataset.density = "compact";
  else delete html.dataset.density;

  if (s.sidebar === "icons") html.dataset.sidebar = "icons";
  else delete html.dataset.sidebar;

  if (s.type === "mono") html.dataset.type = "mono";
  else delete html.dataset.type;

  html.style.setProperty("--glow", String(s.glow));

  // Lyrics glass: slider unico controla alpha + brightness + (em valores
  // altos) desliga o backdrop-filter — replicando a estetica do modo
  // "dragged" (sem blur, fundo carbono ~55%). Range estendido pra
  // permitir o look full-solid via Tweaks. Acima de SOLID_THRESHOLD
  // o data attr `data-lyrics-solid` ativa a regra CSS que zera o backdrop.
  const SOLID_THRESHOLD = 0.85;
  const g = Math.max(0, Math.min(1, s.lyricsGlass));
  const alpha = 0.04 + g * 0.61;          // 0.04 .. 0.65
  const brightness = 0.92 - g * 0.40;     // 0.92 .. 0.52
  html.style.setProperty("--lyrics-bg-alpha", alpha.toFixed(3));
  html.style.setProperty("--lyrics-bg-brightness", brightness.toFixed(3));
  html.dataset.lyricsSolid = g >= SOLID_THRESHOLD ? "on" : "off";

  // Cor das linhas do spectrum bg. SpectrumCanvas le essa var via
  // getComputedStyle no frame loop (~3x/s, igual aos outros knobs).
  // Convertemos hex -> rgb pra o canvas usar com alpha controlada.
  const rgb = hexToRgb(s.bgInk || DEFAULTS.bgInk);
  html.style.setProperty("--bg-ink", s.bgInk || DEFAULTS.bgInk);
  html.style.setProperty("--bg-ink-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);

  // EQ spectrum overlay: data attr e debug-only. EqCanvas le tweaks().eqSpectrumOverlay direto.
  html.dataset.eqSpectrum = s.eqSpectrumOverlay ? "on" : "off";

  // Bg reactivity: 3 ganhos por banda + smoothing. SpectrumCanvas
  // lê essas vars no frame loop (~3x/s) sem listener, igual o
  // bgInk. Range esperado: 0..2 nos gains, 0..1 no smoothing.
  html.style.setProperty("--bg-bass-gain", s.bgBassGain.toFixed(3));
  html.style.setProperty("--bg-mid-gain", s.bgMidGain.toFixed(3));
  html.style.setProperty("--bg-treble-gain", s.bgTrebleGain.toFixed(3));
  html.style.setProperty("--bg-smoothing", s.bgSmoothing.toFixed(3));
  html.style.setProperty("--bg-speed", s.bgSpeed.toFixed(3));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return { r: 23, g: 23, b: 23 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

// ── Update helper ─────────────────────────────────────────────
export function updateTweak<K extends keyof TweaksState>(key: K, val: TweaksState[K]) {
  setState((s) => ({ ...s, [key]: val }));
}

export function resetTweaks() {
  setState({ ...DEFAULTS });
}

// ── Persistencia ──────────────────────────────────────────────
function save(s: TweaksState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

export function loadTweaks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) { applyTweaks(); return; }
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") { applyTweaks(); return; }

    const next: TweaksState = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as Array<keyof TweaksState>) {
      if (k in saved) (next as any)[k] = saved[k];
    }
    // Migracao: schema antigo usa "zoom" como controle separado.
    if (!("scale" in saved) && "zoom" in saved) next.scale = saved.zoom;
    // Migracao: sidebar "collapsed"/"expanded" -> "icons"/"labels"
    if (saved.sidebar === "collapsed") next.sidebar = "icons";
    if (saved.sidebar === "expanded") next.sidebar = "labels";

    setState(next);
  } catch {}
  applyTweaks();
}

// Auto-apply + persist sempre que state mudar (depois do mount inicial).
// Roda no boot tambem (idempotente).
createEffect(() => {
  const s = state();
  applyTweaks(s);
  save(s);
});

// ── Loudness → backend (IPC) ──────────────────────────────────
// Effect DEDICADO: separado do applyTweaks (que e DOM-only). Le SO os
// dois campos de loudness pra nao re-disparar IPC quando outro tweak
// muda. Debounce leve pra nao floodar o backend durante o arrasto do
// slider de target.
let _loudnessTimer: ReturnType<typeof setTimeout> | undefined;

/** Empurra enabled + target pro backend. Idempotente; tolera o engine
    ainda nao ter subido (invoke falha com "engine not started") sem
    quebrar — o boot reaplica via applyLoudnessState(). */
function pushLoudness(norm: boolean, target: number) {
  normSetEnabled(norm).catch((e: unknown) => {
    console.warn("[tweaks] norm_set_enabled falhou:", e);
  });
  normSetTarget(target).catch((e: unknown) => {
    console.warn("[tweaks] norm_set_target falhou:", e);
  });
}

createEffect(() => {
  // Acessa os dois signals pra registrar dependencia reativa.
  const norm = state().loudnessNorm;
  const target = state().loudnessTarget;
  if (_loudnessTimer) clearTimeout(_loudnessTimer);
  _loudnessTimer = setTimeout(() => {
    _loudnessTimer = undefined;
    pushLoudness(norm, target);
  }, 100);
});

/** Reaplica o estado de loudness salvo ao backend no boot.
    Chamado em main.tsx ao lado de applyFullDspState(), porque no
    primeiro tick o engine pode nao estar pronto e o createEffect
    acima falharia silenciosamente — sem isso a primeira faixa tocaria
    no alvo default (-14) em vez do salvo. Retry curto cobre o gap de
    inicializacao do engine. */
export async function applyLoudnessState(retries = 5): Promise<void> {
  const s = state();
  try {
    await normSetEnabled(s.loudnessNorm);
    await normSetTarget(s.loudnessTarget);
  } catch (e) {
    if (retries > 0) {
      setTimeout(() => {
        applyLoudnessState(retries - 1).catch(() => {});
      }, 300);
    } else {
      console.warn("[tweaks] applyLoudnessState desistiu:", e);
    }
  }
}
