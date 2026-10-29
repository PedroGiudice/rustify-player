/* ============================================================
   store/bridge.ts — Estado da ponte MCP como o front o vê (cadeado
   da ponte, 29/10/2026).

   O interruptor mora no Tweaks (`remoteBridge`, store/tweaks.ts) e é
   empurrado ao backend por IPC. ESTE store só espelha o que o backend
   diz: ligada ou não e quantos clientes estão conectados ao WebSocket
   da ponte (evento `bridge-clients-changed`, emitido pelo plugin a cada
   conexão/desconexão e quando o interruptor muda). Consumidores: o chip
   da sidebar (só com a ponte ligada E alguém conectado) e a linha de
   estado no painel Tweaks.
   ============================================================ */

import { createSignal } from "solid-js";
import { bridgeGetStatus, onBridgeStatus, type BridgeStatus } from "../tauri";

const CLOSED: BridgeStatus = { enabled: false, clients: 0 };

const [status, setStatus] = createSignal<BridgeStatus>(CLOSED);
export const bridgeStatus = status;

let _wired = false;

/** Hidrata com o estado atual e passa a seguir o evento do backend.
    Idempotente (o app tem um só espelho). Sem backend (boot antes do
    engine, teste) fica no estado fechado. */
export async function wireBridgeStatus(): Promise<void> {
  if (_wired) return;
  _wired = true;
  // Evento que chegar enquanto a leitura inicial está no ar é mais novo
  // que ela: a resposta do invoke não pode sobrescrevê-lo.
  let eventos = 0;
  try {
    await onBridgeStatus((s) => {
      eventos += 1;
      setStatus(s);
    });
  } catch (e) {
    console.warn("[bridge] listener falhou:", e);
  }
  try {
    const lido = await bridgeGetStatus();
    if (eventos === 0) setStatus(lido);
  } catch {
    if (eventos === 0) setStatus(CLOSED);
  }
}

/** "1 cliente" / "n clientes". */
export function clientes(n: number): string {
  return n === 1 ? "1 cliente" : `${n} clientes`;
}

/** O chip "ponte conectada" só existe quando alguém de fora PODE agir:
    ponte ligada e pelo menos um cliente conectado. Desligada, o cliente
    é recusado em cada comando e o chip não aparece. */
export function chipVisible(s: BridgeStatus): boolean {
  return s.enabled && s.clients > 0;
}

/** Linha de estado do painel Tweaks: o que o interruptor permite agora. */
export function bridgeLine(s: BridgeStatus): string {
  const um = s.clients === 1;
  if (!s.enabled) {
    const base = "Desligada: nada de fora controla o app.";
    if (s.clients === 0) return base;
    return `${base} ${clientes(s.clients)} ${um ? "conectado está sendo recusado" : "conectados estão sendo recusados"}.`;
  }
  if (s.clients === 0) return "Ligada: nenhum cliente conectado agora.";
  return `Ligada: ${clientes(s.clients)} ${um ? "conectado pode" : "conectados podem"} ler e mexer na tela.`;
}

/** Tooltip do chip da sidebar: quem pode agir e onde desligar. Só faz
    sentido quando `chipVisible` (ponte ligada e cliente conectado). */
export function chipTitle(s: BridgeStatus): string {
  return `Ponte conectada: ${clientes(s.clients)} de fora ${s.clients === 1 ? "pode" : "podem"} ler e mexer na tela. Desligue em Tweaks > Controle remoto.`;
}

/** Só para testes: zera o espelho e deixa `wireBridgeStatus` rodar de novo. */
export function __resetForTests() {
  _wired = false;
  setStatus(CLOSED);
}
