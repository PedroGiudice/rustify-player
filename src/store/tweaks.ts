/* ============================================================
   store/tweaks.ts — Estado dos Tweaks do app (fontes, escala,
   density, sidebar, type, glow). Persiste em localStorage e
   aplica no <html> via applyTweaks(). Migra schema antigo
   (fontScale/zoom) para o novo (scale).
   ============================================================ */

import { createSignal, createEffect } from "solid-js";
import { normSetEnabled, normSetTarget, themeVar } from "../tauri";
import { ensureInkContrast } from "../lib/color";
import { isSceneKey, type SceneKey } from "../gl/meta";

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
  /** Modo do beat-sync do bg (espelha os modos do Beat Sync Lab):
      - "speed": o kick (low band, expandido pra faixa real) empurra a
        DERIVADA do relógio — o movimento acelera no beat, contínuo e
        imediato. O comportamento clássico (v0.2.52), preferência
        declarada do usuário 2026-07-17 ("mais agressivo, mas melhor"),
        agora sobre o sinal de 62 Hz consertado. DEFAULT.
      - "pulse": onset detection + PLL travando fase (lib/beatPll.ts);
        pulso modula amplitude. Em música real com bass sustentado o
        lock é parcial (medido: lockMean ~0.18 na melhor calibração) —
        modo experimental.
      Consumido do store via bgKnobs (gate 0/1 + modo 0/1/2). */
  bgBeatMode: "off" | "speed" | "pulse";
  /** Intensidade do beat-sync (vale pros dois modos): 0.3 sutil,
      0.55 default, 0.85 forte. No speed mapeia pro ganho de velocidade
      (0.55 → ganho 1.5, o calibrado da v0.2.52); no pulse é o
      BEAT_DEPTH do pulso de amplitude. Via bgKnobs. */
  bgBeatDepth: number;

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
  /** Paleta alternante: com adaptiveInk ligado e capa com 2+ famílias de
      cor (dominant_palette_v4), o ink do bg alterna entre elas a cada
      ~40s, sempre começando/voltando pela dominante. O ciclo vive em
      lib/adaptiveInk.ts (JS puro, sem CSS var); accent da UI não cicla. */
  bgInkCycle: boolean;
  // ── Motor do background ─────────────────────────────────────
  /** Quem desenha o fundo animado:
      - "2d": SpectrumCanvas (Canvas 2D, 18 shapes x 5 renderers). DEFAULT.
      - "webgl": as quatro cenas de gl/scenes.ts na GPU.
      Os dois nunca rodam juntos — App.tsx monta um OU outro. Se o
      contexto WebGL falhar, o app volta pro 2D sozinho e o motivo
      aparece aqui no painel (glStatus). */
  bgEngine: "2d" | "webgl";
  /** Cena ativa quando bgEngine === "webgl". */
  bgScene: SceneKey;

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
  bgBeatMode: "speed",
  bgBeatDepth: 0.55,
  loudnessNorm: true,
  loudnessTarget: -14,
  adaptiveInk: true,
  bgInkCycle: true,
  adaptiveAccent: true,
  bgEngine: "2d",
  bgScene: "dust",
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

/** --font-sans que o USUÁRIO impõe, ou null (vale o tema/:root). Type Mono
    vence a UI Font: o html[data-type="mono"] do CSS perde pra qualquer
    --font-sans inline (UI Font ou fonte do tema), então o Mono também
    precisa ir pro inline — senão marcar Mono não muda nada (config-v4). */
function userFontSans(s: TweaksState): string | null {
  if (s.type === "mono") return "var(--font-mono)";
  if (s.fontUI) {
    return `"${s.fontUI}", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
  }
  return null;
}

// ── Aplicacao no DOM ──────────────────────────────────────────
// Escrita diferencial (cfg-15): custom property herdada no :root, mesmo
// reescrita com o valor que já tinha, invalida o estilo da árvore inteira
// (o mesmo mecanismo da regra que proíbe transition de custom property no
// :root). Arrastar um slider rodava applyTweaks por quadro e reescrevia
// ~25 vars. Compara com o valor INLINE atual — não com um cache próprio,
// porque o applyTheme escreve as mesmas vars — e só toca no que mudou.
// Devolve se escreveu.
function writeVar(name: string, value: string | null): boolean {
  const st = document.documentElement.style;
  if (value === null) {
    if (st.getPropertyValue(name) === "") return false;
    st.removeProperty(name);
    return true;
  }
  if (st.getPropertyValue(name) === value) return false;
  st.setProperty(name, value);
  return true;
}

/** Var regida por tema: valor do usuário, ou o que o tema declarou, ou nada. */
function writeThemeVar(name: string, userValue: string | null): boolean {
  return writeVar(name, userValue ?? themeVar(name));
}

function writeData(key: string, value: string | undefined): boolean {
  const ds = document.documentElement.dataset;
  if (ds[key] === value) return false;
  if (value === undefined) delete ds[key];
  else ds[key] = value;
  return true;
}

/** Números que o frame loop do fundo 2D consome (SpectrumCanvas). Os knobs
    do fundo são lidos só por JS — nenhum CSS os usa —, então vivem no
    store e não no :root (cfg-15). O WebGL lê o store direto (GlBackground). */
export interface BgKnobs {
  bassGain: number;
  midGain: number;
  trebleGain: number;
  smoothing: number;
  speed: number;
  /** Gate do beat-sync: 1 ligado, 0 desligado. */
  beatSync: number;
  /** 0 = off, 1 = speed, 2 = pulse. */
  beatMode: number;
  beatDepth: number;
}

export function bgKnobs(s: TweaksState): BgKnobs {
  return {
    bassGain: s.bgBassGain,
    midGain: s.bgMidGain,
    trebleGain: s.bgTrebleGain,
    smoothing: s.bgSmoothing,
    speed: s.bgSpeed,
    beatSync: s.bgBeatMode !== "off" ? 1 : 0,
    beatMode: s.bgBeatMode === "speed" ? 1 : s.bgBeatMode === "pulse" ? 2 : 0,
    beatDepth: s.bgBeatDepth,
  };
}

export function applyTweaks(s: TweaksState = state()) {
  const html = document.documentElement;

  // Fontes: valor não-vazio = escolha do usuário (vence o tema). No caminho
  // unset, RESTAURAR o que o tema declarou — removeProperty apagaria a
  // inline var do applyTheme e mataria a fonte do tema no primeiro toque
  // em qualquer knob (achado da auditoria).
  writeThemeVar("--font-sans", userFontSans(s));
  writeThemeVar(
    "--font-mono",
    s.fontMono ? `"${s.fontMono}", ui-monospace, "SF Mono", "Menlo", "Consolas", monospace` : null,
  );

  // zoom afeta TUDO inclusive font-size em px hardcoded.
  // Suportado pelo WebKitGTK do Tauri. Relayout inteiro: só quando muda.
  const zoom = String(s.scale);
  if (html.style.zoom !== zoom) html.style.zoom = zoom;
  if (html.style.getPropertyValue("font-size") !== "") html.style.removeProperty("font-size");

  writeData("density", s.density === "compact" ? "compact" : undefined);
  writeData("sidebar", s.sidebar === "icons" ? "icons" : undefined);
  writeData("type", s.type === "mono" ? "mono" : undefined);

  // Glow é theme-governed: escrever incondicionalmente estompava o --glow
  // declarado pelo tema a cada mudança de knob. Só o valor dirty vence.
  writeThemeVar("--glow", isDirty("glow") ? String(s.glow) : null);

  // Lyrics glass: slider unico controla alpha + brightness + (em valores
  // altos) desliga o backdrop-filter — replicando a estetica do modo
  // "dragged" (sem blur, fundo carbono ~55%). Range estendido pra
  // permitir o look full-solid via Tweaks. Acima de SOLID_THRESHOLD
  // o data attr `data-lyrics-solid` ativa a regra CSS que zera o backdrop.
  // Sem dirty, vale o tema (seção lyrics do YAML); sem tema, os fallbacks
  // do CSS. removeProperty puro apagaria a var inline do applyTheme.
  let glassChanged: boolean;
  if (isDirty("lyricsGlass")) {
    glassChanged = applyLyricsGlass(s);
  } else {
    const a = writeThemeVar("--lyrics-bg-alpha", null);
    const b = writeThemeVar("--lyrics-bg-brightness", null);
    const c = writeData("lyricsSolid", "off");
    glassChanged = a || b || c;
  }

  // Cor das linhas do spectrum bg: resolvida pela precedência
  // usuário > capa > tema > default (ver resolveInk). Só re-resolve se
  // alguma entrada mudou — sem tema, resolver lê o canvas computado.
  if (inkKey(s) !== _inkKey) applyInkResolved(s);

  // Accent da UI: capa (adaptiveAccent) > tema. Roda em todo state change
  // pra cobrir o toggle sem listener dedicado (escrita diferencial).
  applyAccentResolved(s);

  // EQ spectrum overlay: data attr e debug-only. EqCanvas le tweaks().eqSpectrumOverlay direto.
  writeData("eqSpectrum", s.eqSpectrumOverlay ? "on" : "off");

  // Motor do bg: quem MONTA o canvas é o App (lê o store direto).
  writeData("bgEngine", s.bgEngine);

  // Knobs do fundo (ganhos por banda, smoothing, velocidade, beat-sync):
  // NÃO vão pro :root. SpectrumCanvas e GlBackground leem do store
  // (bgKnobs / tweaks()).

  // Aviso pra quem MEDE o vidro (o card de letras do NowPlaying). Desde o
  // cfg-15 a escrita roda num rAF deste store; um rAF agendado por outro
  // effect no mesmo quadro pode rodar antes dela — a ordem segue a dos
  // observadores do signal, que o Solid embaralha a cada re-execução — e
  // ler o valor anterior. Só quando o vidro mudou: arrastar qualquer
  // outro slider não pode custar uma re-medição por quadro.
  if (glassChanged) window.dispatchEvent(new Event("rustify:tweaks-applied"));
}

/** Deriva e escreve as vars do lyrics glass a partir do slider. Devolve
    se alguma mudou. */
function applyLyricsGlass(s: TweaksState): boolean {
  const SOLID_THRESHOLD = 0.85;
  const g = Math.max(0, Math.min(1, s.lyricsGlass));
  const alpha = 0.04 + g * 0.61;          // 0.04 .. 0.65
  const brightness = 0.92 - g * 0.40;     // 0.92 .. 0.52
  const a = writeVar("--lyrics-bg-alpha", alpha.toFixed(3));
  const b = writeVar("--lyrics-bg-brightness", brightness.toFixed(3));
  const c = writeData("lyricsSolid", g >= SOLID_THRESHOLD ? "on" : "off");
  return a || b || c;
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
/** inkKey() da última resolução do ink (ver applyInkResolved). */
let _inkKey = "";

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
  const a = s.adaptiveAccent ? _adaptiveAccent : null;
  if (a) {
    const { r, g, b } = hexToRgb(a.accent);
    writeVar("--primary", a.accent);
    writeVar("--primary-container", a.container);
    writeVar("--primary-fixed-dim", a.container);
    writeVar("--on-primary", a.on);
    writeVar("--on-primary-container", a.on);
    writeVar("--blue-fg", a.accent);
    writeVar("--blue-ring", a.accent);
    writeVar("--blue-bg", `rgba(${r}, ${g}, ${b}, 0.12)`);
    return;
  }
  // Restaura o accent do tema ativo; sem tema, remove (caem os :root).
  for (const name of ACCENT_VARS) writeThemeVar(name, null);
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

/** Escreve --bg-ink/--bg-ink-rgb uma vez, sem animação própria: ambas
    SALTAM pro alvo. A suavidade é dos consumidores — SpectrumCanvas e
    EqCanvas fazem lerp exponencial local por frame (lib/rgbLerp.ts).
    NÃO reintroduzir transition CSS nessas vars: animar custom property
    registrada no :root força restyle global por frame no WebKitGTK
    (medido 2026-07-17: 60fps -> 29fps, stall de 382ms). */
function applyInkResolved(s: TweaksState = state()) {
  _inkKey = inkKey(s);
  const target = resolveInk(s);
  const to = hexToRgb(target);
  writeVar("--bg-ink", target);
  writeVar("--bg-ink-rgb", `${to.r}, ${to.g}, ${to.b}`);
}

/** Tudo de que o ink resolvido depende. applyTweaks só re-resolve quando
    isto muda; tema e capa chamam applyInkResolved direto (o applyTheme
    reescreve --bg-ink inline, então o listener sempre re-resolve). */
function inkKey(s: TweaksState): string {
  return [
    isDirty("bgInk"), s.bgInk, s.adaptiveInk, _adaptiveColor, _themeInk,
    themeVar("--bg-canvas"),
  ].join("|");
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
  const fontSans = userFontSans(s);
  if (fontSans !== null) html.style.setProperty("--font-sans", fontSans);
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
    // Migracao beat-sync, 2 geracoes:
    // v1 (bgBeatSync bool) e v2 (bgBeatDepth com 0 = off embutido) ->
    // v3 (bgBeatMode off/speed/pulse + bgBeatDepth só intensidade).
    // Off persistido continua off; ligado vira "speed" (default novo).
    if (!("bgBeatMode" in saved)) {
      if ("bgBeatDepth" in saved) {
        if (saved.bgBeatDepth === 0) {
          next.bgBeatMode = "off";
          next.bgBeatDepth = DEFAULTS.bgBeatDepth;
        } else {
          next.bgBeatMode = "speed";
        }
      } else if ("bgBeatSync" in saved) {
        next.bgBeatMode = saved.bgBeatSync ? "speed" : "off";
      }
    }
    // Saneamento do motor do bg: estado salvo por outra versão (ou
    // localStorage editado à mão) não pode montar uma cena inexistente —
    // seria um canvas preto sem mensagem nenhuma.
    if (!isSceneKey(next.bgScene)) next.bgScene = DEFAULTS.bgScene;
    if (next.bgEngine !== "2d" && next.bgEngine !== "webgl") next.bgEngine = DEFAULTS.bgEngine;

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

// Agrupamento (cfg-15): arrastar um slider dispara um input por evento, e
// cada applyTweaks mexe em custom properties herdadas no :root — restyle da
// árvore inteira (o mesmo mecanismo da regra que proíbe transition de
// custom property no :root). A escrita no DOM vai pra UM rAF por quadro,
// com o estado mais recente; a gravação no localStorage (JSON.stringify +
// setItem síncrono) espera o arrasto parar. flushTweaks fecha o que estiver
// pendente — no beforeunload, pra não perder o último ajuste.
const SAVE_DEBOUNCE_MS = 300;
let _applyFrame: number | null = null;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleApply() {
  if (_applyFrame !== null) return;
  _applyFrame = requestAnimationFrame(() => {
    _applyFrame = null;
    applyTweaks(state());
  });
}

function scheduleSave() {
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    save(state());
  }, SAVE_DEBOUNCE_MS);
}

/** Aplica e grava agora o que estiver agendado. */
export function flushTweaks() {
  if (_applyFrame !== null) {
    cancelAnimationFrame(_applyFrame);
    _applyFrame = null;
    applyTweaks(state());
  }
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    save(state());
  }
}

window.addEventListener("beforeunload", flushTweaks);

createEffect(() => {
  state();
  if (!_loaded) return;
  scheduleApply();
  scheduleSave();
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
