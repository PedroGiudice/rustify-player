/* ============================================================
   longPress.ts — o gesto canônico do Android, que a UI mobile não
   tinha.

   Por que não é `setTimeout` solto: num WebView, segurar o dedo
   numa lista compete com o scroll e com o menu nativo de seleção de
   texto. O gesto só vale se cancelar por movimento (o dedo que rola
   a lista começa parado) e se o `click` que vem depois for engolido
   — senão o long-press também toca a faixa.
   ============================================================ */

const DEFAULT_DELAY_MS = 450;
const DEFAULT_TOLERANCE_PX = 10;

export interface LongPressOptions {
  onFire: (e: PointerEvent) => void;
  /** ms segurando até disparar. */
  delay?: number;
  /** quanto o dedo pode andar sem cancelar. */
  tolerance?: number;
}

export interface LongPressHandlers {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: () => void;
}

export interface LongPress {
  handlers: LongPressHandlers;
  /** `true` uma única vez, se o click atual veio de um long-press. */
  consumedClick: () => boolean;
  /** Para desmontagem: mata o timer pendente. */
  dispose: () => void;
}

export function createLongPress(opts: LongPressOptions): LongPress {
  const delay = opts.delay ?? DEFAULT_DELAY_MS;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE_PX;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;
  let fired = false;

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    handlers: {
      onPointerDown(e) {
        clear();
        fired = false;
        startX = e.clientX;
        startY = e.clientY;
        timer = setTimeout(() => {
          timer = undefined;
          fired = true;
          opts.onFire(e);
        }, delay);
      },
      onPointerMove(e) {
        if (timer === undefined) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.hypot(dx, dy) > tolerance) clear();
      },
      onPointerUp() {
        clear();
      },
      onPointerCancel() {
        clear();
        fired = false;
      },
    },
    consumedClick() {
      if (!fired) return false;
      fired = false;
      return true;
    },
    dispose: clear,
  };
}
