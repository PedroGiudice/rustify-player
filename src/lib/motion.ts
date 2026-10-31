// src/lib/motion.ts — decisões de movimento que o CSS sozinho não toma.
//
// O vocabulário (keyframes, durações, curvas) mora no extractor-lab.css; aqui
// fica só QUANDO animar:
//
// - Troca de conteúdo (capa, título, pílula) na troca de faixa anima só fora
//   de rajada. 77% dos pulos acontecem em até 5 s, em sequência: animar cada
//   um vira ruído. A troca que chega menos de CALM_GAP_MS depois da anterior
//   corta seco. Play/pause, anterior, próxima e seek nunca animam (o controle
//   não se mexe; quem se mexe é o conteúdo, e só quando a troca é calma).
// - Janela de entrada de vista: conjunto pequeno que pode ser recriado depois
//   (cards de station após o refetch) só escalona logo depois de montar.
// - Presença com saída (A46): componente que desmonta (<Show>) sumia num
//   corte. createPresence segura o nó (e o último valor, para o rótulo não
//   mudar no meio da saída) por --dur-med enquanto o CSS toca a saída.
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";

/** Intervalo mínimo desde a troca anterior para a troca animar. */
export const CALM_GAP_MS = 1500;

/** Duração da janela de entrada (maior atraso do escalonamento + entrada). */
export const ENTER_WINDOW_MS = 600;

/** "a"/"b" alternam para a animação recomeçar; "off" = corte seco. */
export type SwapKey = "a" | "b" | "off";

/** Relógio monotônico (substituível nos testes via vi.spyOn(performance, "now")). */
export const now = (): number => performance.now();

/** A troca é calma quando a anterior foi há pelo menos CALM_GAP_MS. */
export function isCalmChange(lastChangeAt: number, at: number): boolean {
  return at - lastChangeAt >= CALM_GAP_MS;
}

/** Chave seguinte: alterna fora de rajada, desliga dentro dela. */
export function nextSwapKey(prev: SwapKey, lastChangeAt: number, at: number): SwapKey {
  if (!isCalmChange(lastChangeAt, at)) return "off";
  return prev === "a" ? "b" : "a";
}

/**
 * Chave para `data-swap` que muda quando `source` muda. A montagem conta como
 * a última troca: a vista que acabou de abrir já entra com a própria animação.
 */
export function createSwapKey(source: () => unknown): Accessor<SwapKey> {
  const [key, setKey] = createSignal<SwapKey>("off");
  let last = now();
  // `on` com defer não entrega o valor anterior na primeira troca: guarda à mão.
  let prev = source();
  createEffect(
    on(
      source,
      (value) => {
        if (value === prev) return;
        prev = value;
        const at = now();
        setKey((k) => nextSwapKey(k, last, at));
        last = at;
      },
      { defer: true },
    ),
  );
  return key;
}

/** true durante ENTER_WINDOW_MS depois de montar (atributo data-enter). */
export function createEnterWindow(ms: number = ENTER_WINDOW_MS): Accessor<boolean> {
  const [open, setOpen] = createSignal(true);
  const t = setTimeout(() => setOpen(false), ms);
  onCleanup(() => clearTimeout(t));
  return open;
}

/** Duração de uma custom property de tempo do :root, em ms ("0.18s",
    "180ms"). Lida na hora: o tema YAML (motion.*) também manda aqui. */
export function cssDurationMs(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^(\d*\.?\d+)(ms|s)$/.exec(raw);
  if (!m) return fallback;
  return m[2] === "s" ? Math.round(parseFloat(m[1]) * 1000) : Math.round(parseFloat(m[1]));
}

export interface Presence<T> {
  /** O valor a renderizar: o da fonte, ou o último enquanto sai. */
  value: Accessor<T | null>;
  /** true entre a fonte esvaziar e o fim da saída (atributo data-leaving). */
  leaving: Accessor<boolean>;
}

/**
 * Montado até a saída acabar. `source` vazia (null/undefined/false) põe
 * `leaving` em true e só solta o valor depois de `exitMs()`; a fonte voltar
 * no meio cancela a saída. O CSS dá a saída por `[data-leaving]`.
 */
export function createPresence<T>(
  source: Accessor<T | null | undefined | false>,
  exitMs: () => number = () => cssDurationMs("--dur-med", 180),
): Presence<T> {
  const initial = source();
  const [value, setValue] = createSignal<T | null>(initial ? initial : null);
  const [leaving, setLeaving] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      source,
      (v) => {
        clearTimeout(timer);
        if (v) {
          setLeaving(false);
          setValue(() => v);
          return;
        }
        if (value() === null) return;
        setLeaving(true);
        timer = setTimeout(() => {
          setLeaving(false);
          setValue(null);
        }, exitMs());
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return { value, leaving };
}
