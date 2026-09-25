/* ============================================================
   lib/escLayers.ts — pilha única dos overlays que fecham com Esc.

   Um listener por overlay executa na ordem de REGISTRO (fixada na
   montagem), não na ordem em que os overlays foram abertos. Com o
   Tweaks aberto, a ⌘K, a fila ou o menu de contexto por cima
   perdiam o Esc para o painel de baixo, e o App saía do cinema no
   mesmo toque em que a fila fechava.

   Aqui a camada aberta por último fecha primeiro. Regras:
   - quem abre chama pushEscLayer(close) e, ao fechar, a função que
     ela devolve (idempotente);
   - o listener roda em bubble no window: um controle focado que
     trata o próprio Esc (input do Fader, campo da ⌘K) chama
     preventDefault antes e tem precedência;
   - o Esc que fecha uma camada sai com defaultPrevented. O App, que
     sai do cinema com Esc, ignora o evento consumido ou qualquer Esc
     com camada aberta (hasEscLayer), seja qual for a ordem dos
     listeners.
   ============================================================ */

interface Layer { close: () => void }

const stack: Layer[] = [];

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

/** Empilha um overlay aberto. Devolve a função que o desempilha. */
export function pushEscLayer(close: () => void): () => void {
  const entry: Layer = { close };
  if (stack.length === 0) window.addEventListener("keydown", onKey);
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    if (stack.length === 0) window.removeEventListener("keydown", onKey);
  };
}

/** true enquanto algum overlay empilhado está aberto. */
export function hasEscLayer(): boolean {
  return stack.length > 0;
}
