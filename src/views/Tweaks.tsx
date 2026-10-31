/* ============================================================
   views/Tweaks.tsx — Painel flutuante de Tweaks (Solid).

   Substitui o legacy `src/js/components/tweaks.js` que sofria de
   render destrutivo (innerHTML) no input handler do slider — bug
   conhecido em docs/bugs/17052026-tweaks-font-slider-freeze.md.

   Aqui:
   - Sliders são source-of-truth controlado por signals
   - O label "valor %" é um `<span>` derivado, atualiza sem refazer DOM
   - Apply + persist roda via createEffect no store/tweaks.ts
   - Painel monta uma vez via <Portal>; visibilidade via classList

   Varredura Impeccable de 31/10:
   - B17: o Fundo vem primeiro (Fundo, Áudio, Aparência, Remoto) e o
     cabeçalho tem âncoras para as seções; nenhum controle se esconde.
   - B18: Bg ink, Adaptive ink e Ink cycle viraram UM seletor "Cor do
     fundo" com a precedência à vista (store: bgInkMode/setBgInkMode).
   - A30: controle que depende de outro fica marcado e diz de quem
     depende; "↺ tema" compacto; o range herda o .slider; o Scale aplica
     ao soltar (arrastar reescalava o painel sob o cursor); segmentados
     são radiogroups com o ativo dito; fechar é ícone Lucide.
   - A33/A4: fundo WebGL que não iniciou diz que o 2D está no ar e
     oferece tentar de novo; fps 0 é "medindo…"; o ponto só tem halo
     em aviso.
   - B4: "Redefinir tudo" pede o segundo clique.
   ============================================================ */

import { For, Show, createEffect, createResource, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { pushEscLayer } from "../lib/escLayers";
import { Icon, ICONS } from "../components/Icon";
import {
  tweaks,
  tweaksOpen,
  setTweaksOpen,
  updateTweak,
  resetTweaks,
  listSystemFonts,
  isDirty,
  clearDirty,
  bgInkMode,
  setBgInkMode,
  type BgInkMode,
  type TweaksState,
} from "../store/tweaks";
import {
  RELIEF_LINES,
  reliefHasSurface,
  glStatus,
  glActiveScene,
  resetGlStatus,
  SCENE_HINTS,
  SCENE_OFF_BUDGET,
  SCENE_KEYS,
  SCENE_LABELS,
} from "../gl/meta";
import { GL_BENCH_EVENT, glBenchProgress, glBenchResult, runGlBench } from "../gl/bench";
import { bridgeLine, bridgeStatus, chipVisible } from "../store/bridge";
import type { BenchResult } from "../gl/benchStats";

// ── Subcomponentes locais ────────────────────────────────────

/** Dependência de um controle: desligado o pai, o filho não tem efeito e
    a linha diz isso (A30), em vez de ficar aceso e ser ignorado. */
interface Dep {
  /** O controle vale (pai ligado). */
  on: boolean;
  /** "Depende de <isto>". */
  parent: string;
}

function DepHint(props: { dep?: Dep }) {
  return (
    <Show when={props.dep && !props.dep.on}>
      <div class="tweaks__hint tweaks__dep">Depende de {props.dep!.parent}</div>
    </Show>
  );
}

/** Grupo de opções exclusivas: radiogroup com o ativo em aria-checked. */
function Choice<T>(props: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onPick: (v: T) => void;
  dep?: Dep;
  wrap?: boolean;
  /** title por opção (dica longa). */
  titles?: (v: T) => string | undefined;
  /** Marca curta ao lado do rótulo da opção (B19: cena fora do critério de
      fps). `long` entra no nome acessível e no title. */
  marks?: (v: T) => { short: string; long: string } | undefined;
}) {
  const id = createUniqueId();
  const off = () => !!props.dep && !props.dep.on;
  return (
    <div class="tweaks__row" classList={{ "is-dependent": off() }}>
      <span class="tweaks__label" id={id}>{props.label}</span>
      <div
        class="segmented"
        classList={{ "segmented--wrap": !!props.wrap }}
        role="radiogroup"
        aria-labelledby={id}
        aria-disabled={off() ? "true" : undefined}
      >
        <For each={props.options}>
          {([val, text]) => (
            <button
              type="button"
              role="radio"
              class="segmented__btn"
              classList={{ "is-active": props.value === val }}
              aria-checked={props.value === val ? "true" : "false"}
              aria-disabled={off() ? "true" : undefined}
              title={props.marks?.(val)?.long ?? props.titles?.(val)}
              aria-label={props.marks?.(val) ? `${text}, ${props.marks!(val)!.long}` : undefined}
              onClick={() => { if (!off()) props.onPick(val); }}
            >
              {text}
              <Show when={props.marks?.(val)}>
                {(m) => <span class="segmented__mark" aria-hidden="true">{m().short}</span>}
              </Show>
            </button>
          )}
        </For>
      </div>
      <DepHint dep={props.dep} />
    </div>
  );
}

function Segmented<K extends keyof TweaksState>(props: {
  label: string;
  key: K;
  options: Array<[TweaksState[K], string]>;
  dep?: Dep;
}) {
  return (
    <Choice
      label={props.label}
      value={tweaks()[props.key]}
      options={props.options}
      onPick={(v) => updateTweak(props.key, v)}
      dep={props.dep}
    />
  );
}

function FontSelect(props: {
  label: string;
  key: "fontUI" | "fontMono";
  fonts: string[];
  dep?: Dep;
}) {
  const id = createUniqueId();
  const off = () => !!props.dep && !props.dep.on;
  return (
    <div class="tweaks__row" classList={{ "is-dependent": off() }}>
      <span class="tweaks__label" id={id}>{props.label}</span>
      <span class="select-shell select-shell--block">
        <select
          class="tweaks__select"
          aria-labelledby={id}
          disabled={off()}
          value={tweaks()[props.key]}
          onChange={(e) => updateTweak(props.key, e.currentTarget.value)}
        >
          <option value="">Default</option>
          <For each={props.fonts}>
            {(f) => <option value={f}>{f}</option>}
          </For>
        </select>
        <Icon class="select-shell__chev" name={ICONS.chevronDown} size={14} />
      </span>
      <DepHint dep={props.dep} />
    </div>
  );
}

/** "↺ tema" compacto ao lado do rótulo (A30): era uma barra de largura
    total porque herdava o .tweaks__reset. */
function ThemeReset(props: { onClick: () => void; title: string }) {
  return (
    <button type="button" class="tweaks__retheme" title={props.title} onClick={props.onClick}>
      <Icon name={ICONS.reset} size={11} />
      tema
    </button>
  );
}

function NumberSlider(props: {
  label: string;
  key:
    | "scale"
    | "glow"
    | "lyricsGlass"
    | "bgBassGain"
    | "bgMidGain"
    | "bgTrebleGain"
    | "bgSmoothing"
    | "bgSpeed"
    | "bgBeatDepth"
    | "loudnessTarget";
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  /** Knob regido pelo tema: mostra "↺ tema" quando o usuário sobrescreveu. */
  themeGoverned?: boolean;
  /** Aplica só ao soltar (o Scale reescala o painel: aplicar no arrasto
      movia o trilho sob o cursor). */
  commitOnRelease?: boolean;
  dep?: Dep;
}) {
  const id = createUniqueId();
  const off = () => !!props.dep && !props.dep.on;
  // Valor exibido durante o arrasto quando só aplica ao soltar.
  const [draft, setDraft] = createSignal<number | null>(null);
  const shown = () => draft() ?? tweaks()[props.key];
  return (
    <div class="tweaks__row" classList={{ "is-dependent": off() }}>
      <span class="tweaks__label">
        <span id={id}>{props.label}</span> <span class="tweaks__val">{props.format(shown())}</span>
        <Show when={props.themeGoverned && isDirty(props.key)}>
          <ThemeReset title="Voltar a seguir o tema" onClick={() => clearDirty(props.key)} />
        </Show>
      </span>
      <input
        type="range"
        class="slider tweaks__range"
        aria-labelledby={id}
        aria-valuetext={props.format(shown())}
        disabled={off()}
        min={props.min}
        max={props.max}
        step={props.step}
        value={shown()}
        // input = arrasto em tempo real; o store reage e aplica.
        // Sem re-render do painel, sem perder pointer capture.
        onInput={(e) => {
          const v = parseFloat(e.currentTarget.value);
          if (props.commitOnRelease) setDraft(v);
          else updateTweak(props.key, v);
        }}
        onChange={(e) => {
          if (!props.commitOnRelease) return;
          // Lê antes de limpar o rascunho: limpar re-renderiza o value.
          const v = parseFloat(e.currentTarget.value);
          updateTweak(props.key, v);
          setDraft(null);
        }}
      />
      <DepHint dep={props.dep} />
    </div>
  );
}

/** Motor do background. Ligar o WebGL precisa limpar uma falha anterior —
    senão o App, que cai pro 2D quando glStatus.ok === false, nunca
    deixaria tentar de novo. */
function EngineRow() {
  return (
    <Choice
      label="Motor"
      value={tweaks().bgEngine}
      options={[["2d", "2D"], ["webgl", "WebGL"]] as Array<[TweaksState["bgEngine"], string]>}
      onPick={(val) => {
        if (val === "webgl") resetGlStatus();
        updateTweak("bgEngine", val);
      }}
    />
  );
}

/** Critério do CEO (26/09): média >= 58 fps medidos no app. */
const GL_FPS_OK = 58;

/** O que a linha de estado do WebGL diz do fps. 0 = ainda não mediu
    (o primeiro segundo): "medindo…", sem o âmbar de abaixo do critério. */
export function glFpsView(fps: number): { text: string; low: boolean } {
  if (!(fps > 0)) return { text: "medindo…", low: false };
  return { text: `${fps} fps`, low: fps < GL_FPS_OK };
}

/** Marca das cenas fora do critério de 60 fps (B19). Quais e por quê moram
    no `offBudget` do SCENE_META (gl/meta.ts). */
const OFF_BUDGET = "fora do critério de 60 fps";

/** Seleção da cena + o que o motor está entregando de fato (cena e fps
    medidos no app). O fps é o gate da feature: o critério é 60 na
    cmr-auto, e "Medir cenas" mede todas de uma vez. */
function GlSection() {
  return (
    <>
      <Choice
        label="Cena"
        value={tweaks().bgScene}
        options={SCENE_KEYS.map((k) => [k, SCENE_LABELS[k]] as [typeof k, string])}
        wrap
        marks={(k) => (SCENE_OFF_BUDGET[k] ? { short: "< 60 fps", long: OFF_BUDGET } : undefined)}
        onPick={(k) => {
          // Cena que não compilou derrubou o motor pro 2D; escolher
          // outra é tentar de novo, como religar o WebGL.
          if (glStatus().ok === false) resetGlStatus();
          updateTweak("bgScene", k);
        }}
      />
      <div class="tweaks__hint">{SCENE_HINTS[tweaks().bgScene]}</div>
      <Show when={SCENE_OFF_BUDGET[tweaks().bgScene]}>
        {(why) => <div class="tweaks__hint">Fora do critério de 60 fps: {why()}.</div>}
      </Show>
      <Show when={tweaks().bgScene === "relief"}>
        {/* B19 (CEO, 31/10): as variantes saem do caminho, recolhidas; o
            valor salvo continua valendo e aparece no resumo. */}
        <details class="tweaks__advanced">
          <summary class="tweaks__advanced-sum">
            <Icon class="tweaks__advanced-chev" name={ICONS.chevronRight} size={12} />
            <span>Avançado</span>
            <span class="tweaks__advanced-cur">
              {RELIEF_LINES.find((m) => m.key === tweaks().reliefLines)?.label ?? ""}
            </span>
          </summary>
          <div class="tweaks__advanced-body">
            <ReliefControls />
          </div>
        </details>
      </Show>
      <Show when={glStatus().ok === true}>
        {/* O nome do renderer vem mascarado pelo WebKitGTK ("Apple GPU"
            até na Intel) e não diz nada: fica só no title, para
            diagnóstico. Na tela, a cena que o motor está desenhando e o
            fps medido, com o ponto no critério de 58. */}
        <div class="tweaks__hint tweaks__gl-status" title={glStatus().renderer || undefined}>
          <span
            class="tweaks__gl-dot"
            classList={{ "tweaks__gl-dot--low": glFpsView(glStatus().fps).low }}
            aria-hidden="true"
          />
          <span>WebGL · {SCENE_LABELS[glActiveScene() ?? tweaks().bgScene]}</span>
          <span class="tweaks__gl-fps">{glFpsView(glStatus().fps).text}</span>
        </div>
      </Show>
      <Show when={glStatus().ok === false}>
        {/* A33: a mensagem interna fica no title; a tela diz o que aconteceu
            e dá a saída. */}
        <div class="tweaks__gl-fail" role="status" title={glStatus().error || undefined}>
          <span>O fundo WebGL não iniciou; o 2D está no ar.</span>
          <button type="button" class="tweaks__retheme" onClick={() => resetGlStatus()}>
            Tentar de novo
          </button>
        </div>
      </Show>
    </>
  );
}

/** Variantes do Relevo (gl/meta.ts), dentro do Avançado recolhido (B19).
    "Relevo" some na Original (referência intacta); "Superfície" só existe
    nas variantes desenhadas por pixel. */
function ReliefControls() {
  const lines = () => tweaks().reliefLines;
  // Variante que não compilou derrubou o motor pro 2D; escolher outra é
  // tentar de novo, como nos botões de Cena.
  const pick = <K extends "reliefLines" | "reliefShape" | "reliefSurface">(key: K, val: TweaksState[K]) => {
    if (glStatus().ok === false) resetGlStatus();
    updateTweak(key, val);
  };
  return (
    <>
      <Choice
        label="Linhas"
        value={lines()}
        options={RELIEF_LINES.map((m) => [m.key, m.label] as [typeof m.key, string])}
        wrap
        titles={(k) => RELIEF_LINES.find((m) => m.key === k)?.hint}
        onPick={(k) => pick("reliefLines", k)}
      />
      <div class="tweaks__hint">{RELIEF_LINES.find((m) => m.key === lines())?.hint}</div>
      <Show when={lines() !== "original"}>
        <Choice
          label="Relevo"
          value={tweaks().reliefShape}
          options={[["detailed", "Detalhado"], ["smooth", "Suave"]] as Array<[TweaksState["reliefShape"], string]>}
          onPick={(k) => pick("reliefShape", k)}
        />
      </Show>
      <Show when={reliefHasSurface(lines())}>
        <Choice
          label="Superfície"
          value={tweaks().reliefSurface}
          options={[["open", "Vazada"], ["solid", "Sólida"]] as Array<[TweaksState["reliefSurface"], string]>}
          onPick={(k) => pick("reliefSurface", k)}
        />
      </Show>
    </>
  );
}

/* ── Cor do fundo (B18) ────────────────────────────────────── */

const INK_MODES: Array<[BgInkMode, string]> = [
  ["cover-cycle", "Da capa, alterna"],
  ["cover-fixed", "Da capa, fixa"],
  ["theme", "Do tema"],
  ["manual", "Manual"],
];

const INK_HINTS: Record<BgInkMode, string> = {
  "cover-cycle": "Alterna entre as cores dominantes da capa, a cada ~40 s.",
  "cover-fixed": "Segue a cor dominante da capa da faixa tocando.",
  theme: "Usa a cor que o tema declara.",
  manual: "A cor escolhida aqui vence a capa e o tema.",
};

function BgInkSection() {
  const colorId = createUniqueId();
  return (
    <>
      <Choice
        label="Cor do fundo"
        value={bgInkMode()}
        options={INK_MODES}
        wrap
        onPick={setBgInkMode}
      />
      <div class="tweaks__hint">{INK_HINTS[bgInkMode()]}</div>
      <Show when={bgInkMode() === "manual"}>
        <div class="tweaks__row tweaks__row--inline">
          <span class="tweaks__label" id={colorId}>
            Cor <span class="tweaks__val">{tweaks().bgInk}</span>
          </span>
          <input
            type="color"
            class="tweaks__color"
            aria-labelledby={colorId}
            value={tweaks().bgInk}
            onInput={(e) => updateTweak("bgInk", e.currentTarget.value)}
          />
        </div>
      </Show>
    </>
  );
}

/* ── Medição de cenas ──────────────────────────────────────── */

/** Rola o corpo do painel até a seção (mesmo gesto do botão de ajustes do
    Now Playing: o painel fechado é display:none, então a posição só existe
    no quadro seguinte). */
function scrollToSection(key: string) {
  const sec = document.querySelector<HTMLElement>(`[data-tweaks-section="${key}"]`);
  const body = sec?.closest<HTMLElement>(".tweaks__body");
  if (!sec || !body) return;
  body.scrollTop += sec.getBoundingClientRect().top - body.getBoundingClientRect().top;
}

function openTweaksAtFundo() {
  setTweaksOpen(true);
  requestAnimationFrame(() => scrollToSection("fundo"));
}

function startGlBench() {
  void runGlBench({
    onStart: () => setTweaksOpen(false),
    onFinish: () => openTweaksAtFundo(),
  });
}

const fmtInt = (v: number) => String(Math.round(v));
const fmtPct = (v: number) => `${v.toFixed(1).replace(".", ",")}%`;
const fmt2 = (v: number) => v.toFixed(2).replace(".", ",");

function benchWhen(r: BenchResult): string {
  const d = new Date(r.at);
  if (Number.isNaN(d.getTime())) return r.at;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Veredito agrupado, com o texto do critério (a cor da linha sozinha
    não basta para quem não distingue as cores). */
function benchGroups(r: BenchResult): Array<{ title: string; names: string; cls: "ok" | "low" | "err" }> {
  const pick = (f: (s: BenchResult["scenes"][number]) => boolean) =>
    r.scenes.filter(f).map((s) => s.label).join(", ");
  return [
    { title: "60 fps ok", names: pick((s) => !s.error && s.ok), cls: "ok" as const },
    { title: "abaixo de 60", names: pick((s) => !s.error && !s.ok), cls: "low" as const },
    { title: "não mediu", names: pick((s) => !!s.error), cls: "err" as const },
  ].filter((g) => g.names);
}

function BenchTable(props: { r: BenchResult }) {
  return (
    <div class="tweaks__bench">
      <table>
        <thead>
          <tr>
            <th scope="col">Cena</th>
            <th scope="col" title="fps médio">Média</th>
            <th scope="col" title="fps do 1% pior quadro (p99 do intervalo)">1% pior</th>
            <th scope="col" title="quadros acima de 20 ms">&gt;20 ms</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.r.scenes}>
            {(s) => (
              <tr classList={{ "is-ok": s.ok && !s.error, "is-low": !s.ok || !!s.error }}>
                <th scope="row">{s.label}</th>
                <Show
                  when={!s.error}
                  fallback={<td colSpan={3} class="tweaks__bench-err" title={s.error}>erro: {s.error}</td>}
                >
                  <td>{fmtInt(s.fpsAvg)}</td>
                  <td>{fmtInt(s.fpsLow1)}</td>
                  <td>{fmtPct(s.slowPct)}</td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <For each={benchGroups(props.r)}>
        {(g) => (
          <div class="tweaks__bench-verdict" classList={{ "is-ok": g.cls === "ok", "is-low": g.cls !== "ok" }}>
            <b>{g.title}:</b> {g.names}
          </div>
        )}
      </For>
      <div class="tweaks__hint">
        {benchWhen(props.r)} · {props.r.version === "—" ? "versão desconhecida" : `v${props.r.version}`} · {props.r.route}
      </div>
    </div>
  );
}

/** Botão + última tabela. Fica fora do <Show webgl>: medir liga o WebGL
    durante a medição mesmo com o 2D escolhido, e restaura depois. */
function BenchSection() {
  return (
    <div class="tweaks__row">
      <span class="tweaks__label">Desempenho</span>
      <button class="tweaks__btn" disabled={glBenchProgress() !== null} onClick={startGlBench}>
        Medir cenas
      </button>
      <div class="tweaks__hint">
        10 s por medição (2 de aquecimento, 8 medindo) no motor WebGL, com esta tela aberta: as cenas e depois o Relevo em cada estilo de linhas. Esc cancela.
      </div>
      <Show when={glBenchResult()}>{(r) => <BenchTable r={r()} />}</Show>
    </div>
  );
}

/* ── Redefinir tudo: arma e confirma (B4) ──────────────────── */

function ResetAll() {
  const [armed, setArmed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  // Fechar o painel desarma: reabrir não pode achar a bomba engatilhada.
  createEffect(() => { if (!tweaksOpen()) { clearTimeout(timer); setArmed(false); } });
  return (
    <button
      type="button"
      class="tweaks__btn"
      classList={{ "is-armed": armed() }}
      onClick={() => {
        clearTimeout(timer);
        if (!armed()) {
          setArmed(true);
          timer = setTimeout(() => setArmed(false), 4000);
          return;
        }
        setArmed(false);
        resetTweaks();
      }}
    >
      {armed() ? "Clique de novo para redefinir tudo" : "Redefinir tudo"}
    </button>
  );
}

// ── Painel ────────────────────────────────────────────────────

const SECTIONS: Array<[string, string]> = [
  ["fundo", "Fundo"],
  ["audio", "Áudio"],
  ["aparencia", "Aparência"],
  ["remoto", "Remoto"],
];

function SectionHead(props: { key: string; label: string }) {
  return (
    <h3 class="tweaks__divider" id={`tweaks-sec-${props.key}`} data-tweaks-section={props.key}>
      <span>{props.label}</span>
    </h3>
  );
}

export function Tweaks() {
  const [fonts] = createResource(async () => await listSystemFonts());

  onMount(() => {
    const onToggle = () => setTweaksOpen(!tweaksOpen());
    window.addEventListener("toggle-tweaks", onToggle);
    // Medição remota (ponte MCP): o mesmo fluxo do botão.
    window.addEventListener(GL_BENCH_EVENT, startGlBench);
    onCleanup(() => {
      window.removeEventListener("toggle-tweaks", onToggle);
      window.removeEventListener(GL_BENCH_EVENT, startGlBench);
    });
  });

  // Esc fecha o painel aberto quando ele é a camada de cima (lib/escLayers).
  // Captura no window com stopPropagation roubava o Esc da ⌘K, da fila, do
  // menu de contexto e do input do Fader, que ficam por cima do painel.
  createEffect(() => {
    if (!tweaksOpen()) return;
    onCleanup(pushEscLayer(() => setTweaksOpen(false)));
  });

  const t = tweaks;

  return (
    <Portal mount={document.body}>
      <aside
        id="tweaks-panel"
        class="tweaks"
        classList={{ "is-visible": tweaksOpen() }}
        aria-label="Tweaks"
      >
        <div class="tweaks__header">
          <span class="tweaks__title">Tweaks</span>
          <button
            type="button"
            class="tweaks__close"
            aria-label="Fechar"
            onClick={() => setTweaksOpen(false)}
          >
            <Icon name={ICONS.close} size={16} />
          </button>
        </div>
        {/* Âncoras (B17): levam à seção sem esconder nada. */}
        <nav class="tweaks__nav" aria-label="Seções do Tweaks">
          <For each={SECTIONS}>
            {([key, label]) => (
              <button type="button" class="tweaks__nav-btn" onClick={() => scrollToSection(key)}>
                {label}
              </button>
            )}
          </For>
        </nav>
        <div class="tweaks__body">
          {/* ── Fundo (primeiro: é o que mais se ajusta) ─────────
              data-tweaks-section: o botão de ajustes do Now Playing abre o
              painel rolado até aqui. */}
          <SectionHead key="fundo" label="Fundo" />
          <EngineRow />
          <Show when={t().bgEngine === "webgl"}>
            <GlSection />
          </Show>
          <Show when={t().bgEngine === "2d"}>
            <div class="tweaks__hint">
              Shape e renderer do fundo 2D seguem no Now Playing ([ ] e , .)
            </div>
          </Show>
          <BgInkSection />
          <NumberSlider label="Bass" key="bgBassGain" min={0} max={2} step={0.05} format={fmt2} />
          <NumberSlider label="Mid" key="bgMidGain" min={0} max={2} step={0.05} format={fmt2} />
          <NumberSlider label="Treble" key="bgTrebleGain" min={0} max={2} step={0.05} format={fmt2} />
          <NumberSlider
            label="Smoothing"
            key="bgSmoothing"
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <NumberSlider
            label="Speed"
            key="bgSpeed"
            min={0}
            max={2}
            step={0.05}
            format={(v) => `${fmt2(v)}x`}
          />
          <Segmented
            label="Beat sync"
            key="bgBeatMode"
            options={[["off", "Off"], ["speed", "Speed"], ["pulse", "Pulse"]]}
          />
          <div class="tweaks__hint">Speed: kick acelera o movimento · Pulse: pulso de amplitude no tempo</div>
          {/* Slider contínuo (2026-07-19): o pipeline sempre foi contínuo
              (bgBeatDepth); os 3 presets eram só amarra da UI. 0.55 segue o
              default calibrado. Sem Beat sync, não tem efeito (A30). */}
          <NumberSlider
            label="Beat depth"
            key="bgBeatDepth"
            min={0}
            max={1}
            step={0.05}
            format={fmt2}
            dep={{ on: t().bgBeatMode !== "off", parent: "Beat sync ligado" }}
          />
          <BenchSection />

          {/* ── Áudio ──────────────────────────────────────────── */}
          <SectionHead key="audio" label="Áudio" />
          <Segmented
            label="Normalização"
            key="loudnessNorm"
            options={[[true, "On"], [false, "Off"]]}
          />
          <NumberSlider
            label="Target"
            key="loudnessTarget"
            min={-20}
            max={-6}
            step={0.5}
            format={(v) => `${v.toFixed(1).replace(".", ",")} LUFS`}
            dep={{ on: t().loudnessNorm, parent: "Normalização ligada" }}
          />
          <Segmented
            label="EQ spectrum"
            key="eqSpectrumOverlay"
            options={[[true, "On"], [false, "Off"]]}
          />

          {/* ── Aparência ──────────────────────────────────────── */}
          <SectionHead key="aparencia" label="Aparência" />
          <Segmented
            label="Density"
            key="density"
            options={[["normal", "Normal"], ["compact", "Compact"]]}
          />
          <Segmented
            label="Sidebar"
            key="sidebar"
            options={[["icons", "Icons"], ["labels", "Labels"]]}
          />
          <Segmented
            label="Type"
            key="type"
            options={[["body", "Sans"], ["mono", "Mono"]]}
          />
          <Show when={!fonts.loading}>
            <FontSelect
              label="UI Font"
              key="fontUI"
              fonts={fonts() ?? []}
              dep={{ on: t().type !== "mono", parent: "Type: Sans" }}
            />
            <FontSelect label="Mono Font" key="fontMono" fonts={fonts() ?? []} />
          </Show>
          <NumberSlider
            label="Scale"
            key="scale"
            min={0.85}
            max={1.25}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            commitOnRelease
          />
          <NumberSlider
            label="Glow"
            key="glow"
            min={0}
            max={1}
            step={0.05}
            format={fmt2}
            themeGoverned
          />
          <NumberSlider
            label="Lyrics glass"
            key="lyricsGlass"
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            themeGoverned
          />
          <Segmented
            label="Adaptive accent"
            key="adaptiveAccent"
            options={[[true, "Album"], [false, "Off"]]}
          />

          {/* ── Controle remoto ─────────────────────────────────
              Cadeado da ponte MCP (29/10/2026): o app só obedece à ponte
              (127.0.0.1:9223, alcançada por túnel SSH) com isto ligado.
              Padrão Off; vai ao backend por IPC (store/tweaks.ts). A linha
              viva vem do espelho store/bridge.ts, o mesmo do chip da
              sidebar, e é a única dica da seção (A30). */}
          <SectionHead key="remoto" label="Controle remoto" />
          <Segmented
            label="Ponte MCP"
            key="remoteBridge"
            options={[[true, "On"], [false, "Off"]]}
          />
          <div
            class="tweaks__hint tweaks__gl-status"
            role="status"
            title="A ponte MCP é alcançada por túnel SSH; ligada, a sessão de fora pode ler e mexer na tela."
          >
            <Show when={chipVisible(bridgeStatus())}>
              <span class="tweaks__gl-dot tweaks__gl-dot--attn" aria-hidden="true" />
            </Show>
            <span>{bridgeLine(bridgeStatus())}</span>
          </div>

          <ResetAll />
        </div>
      </aside>
      <Show when={glBenchProgress()}>
        {(p) => (
          <div class="gl-bench-badge" role="status" aria-live="polite">
            Medindo {p().label} {p().index}/{p().total}
            <span class="gl-bench-badge__hint">Esc cancela</span>
          </div>
        )}
      </Show>
    </Portal>
  );
}
