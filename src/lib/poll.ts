// src/lib/poll.ts — poll que dorme com a janela oculta (A49).
//
// O app fica aberto o dia todo, muitas vezes minimizado, numa máquina que
// roda a 97-98 °C. setInterval não pausa com a janela oculta (o rAF pausa):
// sem isto, o Crate seguia consultando o slskd e as fontes de 5 em 5 s com o
// app no fundo. Ao voltar à vista, dispara na hora (o dado pode ter mudado)
// e recomeça a contagem do intervalo.

const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** Chama `fn` a cada `ms` enquanto a janela está à vista. Devolve o `stop`. */
export function pollWhileVisible(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const start = () => {
    clearInterval(timer);
    timer = setInterval(() => { if (!isHidden()) fn(); }, ms);
  };
  const onVisibility = () => {
    if (stopped) return;
    if (isHidden()) {
      clearInterval(timer);
      timer = undefined;
      return;
    }
    fn();
    start();
  };
  start();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
