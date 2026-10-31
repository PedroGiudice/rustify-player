// src/components/Toast.tsx — aviso transitório (store/toast). Singleton no
// App, no canto da direita acima da PlayerBar (perto da fila, de onde vem a
// maioria dos avisos). A região viva fica sempre no DOM: o leitor de tela só
// anuncia o que muda dentro de uma região que já existia.
import { Show } from "solid-js";
import { dismissToast, pauseToast, resumeToast, runToastAction, toast } from "../store/toast";
import { Icon, ICONS } from "./Icon";

export function Toast() {
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
                <button type="button" class="toast__action" onClick={runToastAction}>
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
