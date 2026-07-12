/* ============================================================
   store/tweaks.ts — Estado dos Tweaks do app (fontes, escala,
   density, sidebar, type, glow). Persiste em localStorage e
   aplica no <html> via applyTweaks(). Migra schema antigo
   (fontScale/zoom) para o novo (scale).
   ============================================================ */

import { createSignal, createEffect } from "solid-js";
import { normSetEnabled, normSetTarget, themeVar } from "../tauri";
import { ensureInkContrast } from "../lib/color";

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
  /** Beat sync: o kick (low band do audio-fft) empurra a DERIVADA do
      relógio virtual do bg — a animação acelera no beat, contínua e
      suavizada, sem salto de fase. Off = velocidade puramente nominal
      (bgSpeed). Consumido pelo SpectrumCanvas via --bg-beat-sync. */
  bgBeatSync: boolean;

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
  /** Accent adaptativo: --primary e família (container, on-primary,
      blue-fg/bg/ring — chips, halos, botões) seguem o hue da capa da
      faixa tocando, com contraste garantido na derivação. Desligado ou
      capa acromática → o accent do tema vale. */
  adaptiveAccent: boolean;
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
  bgBeatSync: true,
  loudnessNorm: true,
  loudnessTarget: -14,
  adaptiveInk: true,
  adaptiveAccent: true,
};

// ── Dirty tracking ────────────────────────────────────────────
// Campos onde o tema fornece o default e o valor do usuário só vale se
// ele tocou no knob. Sem dirty, o applyTweaks se abstém e deixa o tema
// (ou a capa, no caso do ink) valer. Signal pra UI reagir (botão reset).
const THEME_GOVERNED: ReadonlyArray<keyof TweaksState> = ["bgInk", "lyricsGlass", "glow"];
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

  // Fontes: valor não-vazio = escolha do usuário (vence o tema). No caminho
  // unset, RESTAURAR o que o tema declarou — removeProperty apagaria a
  // inline var do applyTheme e mataria a fonte do tema no primeiro toque
  // em qualquer knob (achado da auditoria).
  if (s.fontUI) {
    html.style.setProperty(
      "--font-sans",
      `"${s.fontUI}", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`,
    );
  } else {
    const tv = themeVar("--font-sans");
    if (tv !== null) html.style.setProperty("--font-sans", tv);
    else html.style.removeProperty("--font-sans");
  }

  if (s.fontMono) {
    html.style.setProperty(
      "--font-mono",
      `"${s.fontMono}", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace`,
    );
  } else {
    const tv = themeVar("--font-mono");
    if (tv !== null) html.style.setProperty("--font-mono", tv);
    else html.style.removeProperty("--font-mono");
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

  // Glow é theme-governed: escrever incondicionalmente estompava o --glow
  // declarado pelo tema a cada mudança de knob. Só o valor dirty vence.
  if (isDirty("glow")) {
    html.style.setProperty("--glow", String(s.glow));
  } else {
    const tv = themeVar("--glow");
    if (tv !== null) html.style.setProperty("--glow", tv);
    else html.style.removeProperty("--glow");
  }

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

  // Accent da UI: capa (adaptiveAccent) > tema. Roda em todo state change
  // pra cobrir o toggle sem listener dedicado.
  applyAccentResolved(s);

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
  // Beat sync como flag numérica ("1"/"0"): o canvas lê com parseFloat
  // no mesmo batch das outras vars, sem parsing especial de bool.
  html.style.setProperty("--bg-beat-sync", s.bgBeatSync ? "1" : "0");
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

/** Ink base do tema ativo (ou default) — referência de luminância pro
    deriveInk do adaptive. */
export function themeInkBase(): string {
  return _themeInk || DEFAULTS.bgInk;
}

export function setAdaptiveColor(hex: string | null) {
  _adaptiveColor = hex;
  applyInkResolved();
}

// ── Accent: capa > tema ───────────────────────────────────────
// O adaptiveInk.ts deriva {accent, container, on} da capa e entrega aqui.
// Aplicar = sobrescrever as inline vars que o applyTheme escreveu; restaurar
// = reescrever os valores do TEMA (themeVar) — removeProperty cairia nos
// defaults do :root e apagaria o tema junto.
export interface AdaptiveAccent {
  accent: string;
  container: string;
  on: string;
}

let _adaptiveAccent: AdaptiveAccent | null = null;

export function setAdaptiveAccent(a: AdaptiveAccent | null) {
  _adaptiveAccent = a;
  applyAccentResolved();
}

/** Vars regidas pelo accent adaptativo. blue-* incluídas porque o design
    system usa blue-fg/bg/ring como papel de destaque (chips, halos). */
const ACCENT_VARS = [
  "--primary", "--primary-container", "--primary-fixed-dim",
  "--on-primary", "--on-primary-container",
  "--blue-fg", "--blue-bg", "--blue-ring",
] as const;

function applyAccentResolved(s: TweaksState = state()) {
  const html = document.documentElement;
  const a = s.adaptiveAccent ? _adaptiveAccent : null;
  if (a) {
    const { r, g, b } = hexToRgb(a.accent);
    html.style.setProperty("--primary", a.accent);
    html.style.setProperty("--primary-container", a.container);
    html.style.setProperty("--primary-fixed-dim", a.container);
    html.style.setProperty("--on-primary", a.on);
    html.style.setProperty("--on-primary-container", a.on);
    html.style.setProperty("--blue-fg", a.accent);
    html.style.setProperty("--blue-ring", a.accent);
    html.style.setProperty("--blue-bg", `rgba(${r}, ${g}, ${b}, 0.12)`);
    return;
  }
  // Restaura o accent do tema ativo; sem tema, remove (caem os :root).
  for (const name of ACCENT_VARS) {
    const v = themeVar(name);
    if (v !== null) html.style.setProperty(name, v);
    else html.style.removeProperty(name);
  }
}

/** Piso de visibilidade (não-texto WCAG). O deriveInk da capa mira 4:1 por
    conta própria; este piso pega o resto — knob manual, tema, default. */
const MIN_INK_CONTRAST = 3.0;

/** Canvas do tema ativo (referência do piso de contraste). Sem tema, cai
    no valor computado do :root; se nem isso parsear, ensureInkContrast
    vira no-op — nunca quebra. */
function activeCanvas(): string {
  return (
    themeVar("--bg-canvas") ??
    getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim()
  );
}

function resolveInk(s: TweaksState): string {
  let ink: string;
  if (isDirty("bgInk")) ink = s.bgInk || DEFAULTS.bgInk;
  else if (s.adaptiveInk && _adaptiveColor) ink = _adaptiveColor;
  else ink = themeInkBase();
  // Enforcement final: NENHUMA fonte entrega ink invisível contra o canvas
  // do tema ativo (espelha o ensure_bg_ink_contrast do load_theme).
  return ensureInkContrast(ink, activeCanvas(), MIN_INK_CONTRAST);
}

/** Escreve --bg-ink/--bg-ink-rgb uma vez, sem animação própria: a suavidade
    é da camada de apresentação. --bg-ink é custom property registrada como
    <color> (animatedColorProps.ts) e transiciona 480ms via CSS — todo
    consumidor DOM e o EqCanvas (que lê o valor em transição) herdam o
    crossfade. --bg-ink-rgb salta pro alvo; o SpectrumCanvas faz lerp
    interno por frame, então nunca vê o salto. */
function applyInkResolved(s: TweaksState = state()) {
  const target = resolveInk(s);
  const to = hexToRgb(target);
  const html = document.documentElement;
  html.style.setProperty("--bg-ink", target);
  html.style.setProperty("--bg-ink-rgb", `${to.r}, ${to.g}, ${to.b}`);
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
  if (isDirty("glow")) html.style.setProperty("--glow", String(s.glow));
  applyInkResolved(s);
  applyAccentResolved(s);
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
  // Libera aplicação/persistência ANTES do setState: o effect global passa
  // a valer a partir do estado carregado, nunca dos DEFAULTS do import.
  _loaded = true;
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
    // A união com a inferência cobre chaves que viraram theme-governed
    // DEPOIS do estado ter sido salvo (ex: glow): valor != default = escolha
    // do usuário. Seguro porque clearDirty zera o valor pro default — um
    // reset nunca é ressuscitado pela inferência.
    if (Array.isArray(saved.__dirty)) {
      const explicit = (saved.__dirty as string[]).filter(
        (k): k is keyof TweaksState =>
          (THEME_GOVERNED as ReadonlyArray<string>).includes(k),
      );
      const inferred = THEME_GOVERNED.filter((k) => next[k] !== DEFAULTS[k]);
      setDirtyKeys(new Set([...explicit, ...inferred]));
    } else {
      setDirtyKeys(new Set(THEME_GOVERNED.filter((k) => next[k] !== DEFAULTS[k])));
    }

    setState(next);
  } catch {}
  applyTweaks();
}

// Auto-apply + persist sempre que state mudar. ATENÇÃO (achado da
// auditoria): createEffect em module-level roda SÍNCRONO no import —
// sem o gate _loaded, este effect salvava DEFAULTS por cima do kv-tweaks
// persistido ANTES de loadTweaks() rodar, apagando os tweaks do usuário
// a cada boot. Persistência e aplicação só valem após o load.
let _loaded = false;

createEffect(() => {
  const s = state();
  if (!_loaded) return;
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

// `state` é um signal do objeto INTEIRO: ler um campo NÃO restringe a
// dependência (achado da auditoria — qualquer knob re-rodava este effect
// e re-empurrava IPC redundante, revertendo o toggle do Settings). O guard
// de valores anteriores garante IPC só quando o PAR de fato mudou; o gate
// _loaded evita empurrar DEFAULTS antes do loadTweaks.
let _prevNorm: boolean | undefined;
let _prevTarget: number | undefined;

createEffect(() => {
  const s = state();
  const norm = s.loudnessNorm;
  const target = s.loudnessTarget;
  if (!_loaded) return;
  if (norm === _prevNorm && target === _prevTarget) return;
  _prevNorm = norm;
  _prevTarget = target;
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
