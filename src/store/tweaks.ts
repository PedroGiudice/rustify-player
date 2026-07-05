/* ============================================================
   store/tweaks.ts — Estado dos Tweaks do app (fontes, escala,
   density, sidebar, type, glow). Persiste em localStorage e
   aplica no <html> via applyTweaks(). Migra schema antigo
   (fontScale/zoom) para o novo (scale).
   ============================================================ */

import { createSignal, createEffect } from "solid-js";
import { normSetEnabled, normSetTarget } from "../tauri";

const { invoke } = window.__TAURI__.core;

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

  /** Ink adaptativo: o bg animado (e as linhas do spectrum) seguem a cor
      dominante da capa da faixa tocando. Precedência do ink:
      usuário (bgInk tocado) > capa (este toggle) > tema > default. */
  adaptiveInk: boolean;
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
  adaptiveInk: true,
};

// ── Dirty tracking ────────────────────────────────────────────
// Campos onde o tema fornece o default e o valor do usuário só vale se
// ele tocou no knob. Sem dirty, o applyTweaks se abstém e deixa o tema
// (ou a capa, no caso do ink) valer. Signal pra UI reagir (botão reset).
const THEME_GOVERNED: ReadonlyArray<keyof TweaksState> = ["bgInk", "lyricsGlass"];
const [dirtyKeys, setDirtyKeys] = createSignal<ReadonlySet<keyof TweaksState>>(new Set());

export function isDirty(key: keyof TweaksState): boolean {
  return dirtyKeys().has(key);
}

function markDirty(key: keyof TweaksState) {
  if (dirtyKeys().has(key)) return;
  setDirtyKeys(new Set([...dirtyKeys(), key]));
}

/** Limpa o override do usuário: o knob volta a seguir o tema. */
export function clearDirty(key: keyof TweaksState) {
  const next = new Set(dirtyKeys());
  next.delete(key);
  setDirtyKeys(next);
  // Volta o valor exibido no knob pro default (o efetivo vem do tema).
  setState((s) => ({ ...s, [key]: DEFAULTS[key] }));
}

const [state, setState] = createSignal<TweaksState>({ ...DEFAULTS });
export const tweaks = state;

// Open/close do painel — controlado pelo evento "toggle-tweaks".
const [open, setOpen] = createSignal(false);
export const tweaksOpen = open;
export function setTweaksOpen(v: boolean) { setOpen(v); }

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
  // Sem dirty, o CSS decide pelos fallbacks inline (tema-neutro).
  if (isDirty("lyricsGlass")) {
    applyLyricsGlass(s);
  } else {
    html.style.removeProperty("--lyrics-bg-alpha");
    html.style.removeProperty("--lyrics-bg-brightness");
    html.dataset.lyricsSolid = "off";
  }

  // Cor das linhas do spectrum bg: resolvida pela precedência
  // usuário > capa > tema > default (ver resolveInk).
  applyInkResolved(s);

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

/** Deriva e escreve as vars do lyrics glass a partir do slider. */
function applyLyricsGlass(s: TweaksState) {
  const html = document.documentElement;
  const SOLID_THRESHOLD = 0.85;
  const g = Math.max(0, Math.min(1, s.lyricsGlass));
  const alpha = 0.04 + g * 0.61;          // 0.04 .. 0.65
  const brightness = 0.92 - g * 0.40;     // 0.92 .. 0.52
  html.style.setProperty("--lyrics-bg-alpha", alpha.toFixed(3));
  html.style.setProperty("--lyrics-bg-brightness", brightness.toFixed(3));
  html.dataset.lyricsSolid = g >= SOLID_THRESHOLD ? "on" : "off";
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

// ── Ink: precedência + animação ───────────────────────────────
// usuário (bgInk dirty) > capa (adaptiveInk + cor corrente) > tema > default.
// O tema entra via evento "rustify:theme-applied" (applyTheme em tauri.ts);
// a capa via setAdaptiveColor (src/lib/adaptiveInk.ts).
let _themeInk: string | null = null;
let _adaptiveColor: string | null = null;
let _currentInkRgb: { r: number; g: number; b: number } | null = null;
let _inkAnimFrame = 0;

/** Ink base do tema ativo (ou default) — referência de luminância pro
    deriveInk do adaptive. */
export function themeInkBase(): string {
  return _themeInk || DEFAULTS.bgInk;
}

export function setAdaptiveColor(hex: string | null) {
  _adaptiveColor = hex;
  applyInkResolved();
}

function resolveInk(s: TweaksState): string {
  if (isDirty("bgInk")) return s.bgInk || DEFAULTS.bgInk;
  if (s.adaptiveInk && _adaptiveColor) return _adaptiveColor;
  return themeInkBase();
}

/** Escreve --bg-ink/--bg-ink-rgb com transição curta (o SpectrumCanvas
    amostra a var ~3x/s; 600ms dá 1-2 passos intermediários — suficiente
    pra troca de faixa não "piscar"). Chamadas re-entrantes cancelam a
    animação anterior e partem da cor corrente. */
function applyInkResolved(s: TweaksState = state()) {
  const target = resolveInk(s);
  const to = hexToRgb(target);
  const html = document.documentElement;
  html.style.setProperty("--bg-ink", target);

  clearTimeout(_inkAnimFrame);
  const from = _currentInkRgb;
  if (!from || (from.r === to.r && from.g === to.g && from.b === to.b)) {
    _currentInkRgb = to;
    html.style.setProperty("--bg-ink-rgb", `${to.r}, ${to.g}, ${to.b}`);
    return;
  }
  // Passos de ~150ms: os consumidores (SpectrumCanvas/EqCanvas) amostram a
  // var ~3x/s via getComputedStyle — interpolar por frame (rAF) gastaria
  // ~36 writes dos quais só 2 seriam lidos. 4 passos batem a cadência.
  const STEPS = 4;
  const STEP_MS = 150;
  let i = 0;
  const step = () => {
    i += 1;
    const t2 = i / STEPS;
    const e = 1 - (1 - t2) * (1 - t2); // ease-out quad
    const cur = {
      r: Math.round(from.r + (to.r - from.r) * e),
      g: Math.round(from.g + (to.g - from.g) * e),
      b: Math.round(from.b + (to.b - from.b) * e),
    };
    _currentInkRgb = cur;
    html.style.setProperty("--bg-ink-rgb", `${cur.r}, ${cur.g}, ${cur.b}`);
    if (i < STEPS) _inkAnimFrame = window.setTimeout(step, STEP_MS) as unknown as number;
  };
  _inkAnimFrame = window.setTimeout(step, STEP_MS) as unknown as number;
}

// Tema aplicado (boot, troca no picker, hot-reload do watcher): captura o
// ink declarado pelo tema e re-asserta SOMENTE os overrides que o usuário
// de fato tem (fontes setadas, lyrics dirty, ink resolvido) por cima das
// inline vars que o applyTheme acabou de escrever. NÃO chama applyTweaks
// inteiro: o caminho "unset" faria removeProperty de --font-mono e
// sobrescreveria --glow, matando o que o tema declarou.
window.addEventListener("rustify:theme-applied", (e: Event) => {
  const detail = (e as CustomEvent<{ ink: string | null }>).detail;
  _themeInk = detail?.ink ?? null;
  const s = state();
  const html = document.documentElement;
  if (s.fontUI) {
    html.style.setProperty(
      "--font-sans",
      `"${s.fontUI}", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`,
    );
  }
  if (s.fontMono) {
    html.style.setProperty(
      "--font-mono",
      `"${s.fontMono}", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace`,
    );
  }
  if (isDirty("lyricsGlass")) applyLyricsGlass(s);
  applyInkResolved(s);
});

// ── Update helper ─────────────────────────────────────────────
export function updateTweak<K extends keyof TweaksState>(key: K, val: TweaksState[K]) {
  if ((THEME_GOVERNED as ReadonlyArray<string>).includes(key)) markDirty(key);
  setState((s) => ({ ...s, [key]: val }));
}

export function resetTweaks() {
  setDirtyKeys(new Set<keyof TweaksState>());
  setState({ ...DEFAULTS });
}

// ── Persistencia ──────────────────────────────────────────────
function save(s: TweaksState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...s, __dirty: [...dirtyKeys()] }));
  } catch {}
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

    // Dirty list persistida. Estado salvo por versão anterior (sem __dirty):
    // infere — valor diferente do default = escolha do usuário, preserva.
    if (Array.isArray(saved.__dirty)) {
      const keys = (saved.__dirty as string[]).filter(
        (k): k is keyof TweaksState =>
          (THEME_GOVERNED as ReadonlyArray<string>).includes(k),
      );
      setDirtyKeys(new Set(keys));
    } else {
      setDirtyKeys(new Set(THEME_GOVERNED.filter((k) => next[k] !== DEFAULTS[k])));
    }

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
