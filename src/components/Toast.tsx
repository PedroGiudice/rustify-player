// src/components/Toast.tsx — aviso transitório (store/toast). Singleton no
// App, no canto da direita acima da PlayerBar (perto da fila, de onde vem a
// maioria dos avisos). A região viva fica sempre no DOM: o leitor de tela só
// anuncia o que muda dentro de uma região que já existia.
import { Show, onCleanup, onMount } from "solid-js";
import { dismissToast, pauseToast, resumeToast, runToastAction, toast } from "../store/toast";
import { isTypingContext } from "../lib/keyboard";
import { Icon, ICONS } from "./Icon";

export function Toast() {
  // Ctrl+Z (Cmd+Z) aciona o Desfazer do aviso na tela: a gaveta da fila é
  // modal e prende o Tab, então o botão do aviso não é alcançável pelo teclado.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      if (isTypingContext(e) || !toast()?.action) return;
      e.preventDefault();
      runToastAction();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="toast-region" role="status" aria-live="polite">
      <Show when={toast()} keyed>
        {(t) => (
          <div
            class="toast"
            onPointerEnter={pauseToast}
            onPointerLeave={resumeToast}
            onFocusIn={pauseToast}
            onFocusOut={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resumeToast();
            }}
          >
            <span class="toast__msg">{t.message}</span>
            <Show when={t.action}>
              {(a) => (
                <button type="button" class="toast__action" title={`${a().label} (Ctrl+Z)`} onClick={runToastAction}>
                  {a().label}
                </button>
              )}
            </Show>
            <button
              type="button"
              class="toast__close"
              aria-label="Fechar aviso"
              title="Fechar aviso"
              onClick={() => dismissToast(t.id)}
            >
              <Icon name={ICONS.close} size={12} />
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
