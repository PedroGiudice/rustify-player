// src/store/toast.ts — aviso transitório com ação opcional ("Fila limpa ·
// Desfazer"). Um aviso por vez: o novo substitui o anterior (a ação do velho
// deixa de valer, como em qualquer desfazer de um passo só). Renderizado por
// <Toast/> montado no App.
//
// O prazo para enquanto o ponteiro ou o foco estão no aviso (quem vai clicar
// em Desfazer não perde o botão no meio do gesto) e recomeça com o tempo que
// faltava quando saem.
import { createSignal } from "solid-js";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastSpec {
  message: string;
  action?: ToastAction;
  /** Milissegundos na tela. Padrão 6 s. */
  duration?: number;
}

export interface ToastState extends ToastSpec {
  id: number;
}

export const TOAST_MS = 6000;

const [toast, setToast] = createSignal<ToastState | null>(null);
export { toast };

let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let deadline = 0;
let remaining = 0;
let paused = false;

function arm(ms: number) {
  clearTimeout(timer);
  remaining = ms;
  deadline = Date.now() + ms;
  const id = toast()?.id;
  timer = setTimeout(() => dismissToast(id), ms);
}

/** Mostra um aviso e devolve o id dele (para dispensar só esse depois). */
export function showToast(spec: ToastSpec): number {
  const id = ++seq;
  paused = false;
  setToast({ ...spec, id });
  arm(spec.duration ?? TOAST_MS);
  return id;
}

/** Tira o aviso. Com id, só se ainda for aquele (um aviso novo não cai junto). */
export function dismissToast(id?: number) {
  const cur = toast();
  if (!cur || (id !== undefined && cur.id !== id)) return;
  clearTimeout(timer);
  timer = undefined;
  paused = false;
  setToast(null);
}

/** Executa a ação do aviso atual e o tira da tela. */
export function runToastAction() {
  const cur = toast();
  if (!cur?.action) return;
  dismissToast(cur.id);
  cur.action.run();
}

/** Ponteiro ou foco entrou no aviso: o prazo para. */
export function pauseToast() {
  if (!toast() || paused) return;
  paused = true;
  clearTimeout(timer);
  remaining = Math.max(0, deadline - Date.now());
}

/** Saiu: o prazo segue com o que faltava (piso de 1,5 s para dar tempo de ler). */
export function resumeToast() {
  if (!toast() || !paused) return;
  paused = false;
  arm(Math.max(remaining, 1500));
}
