/* ============================================================
   gl/kick.ts — o kick como EVENTO e como memória, sem GL.

   O sinal (gl/signal.ts) entrega `pulse`: o transiente do kick
   relativo à média da própria faixa, já com o depth do Tweaks e zero
   com o beat-sync desligado (inclusive na versão calma). As cenas
   que querem um gesto legível por kick — uma frente que corre pelo
   volume, um empurrão que decai — precisam de mais do que o valor
   instantâneo:

     - KickTrigger: borda de subida do pulso com histerese e
       intervalo mínimo. Vira 1 evento por bumbo, nunca uma rajada
       (o teto de 3 flashes por segundo do DESIGN.md mora aqui:
       KICK_MIN_GAP).
     - surge: envelope de pico com soltura lenta — o empurrão que o
       kick dá na velocidade e que a cena INTEGRA na posição.
     - PulseHistory: o pulso amostrado a taxa fixa no relógio
       virtual, para uma cena ler "o pulso de d segundos atrás" (a
       onda que desce o túnel da Órbitas). Relógio virtual: Speed = 0
       congela a memória junto com o resto.

   Puro e sem alocação por quadro (as cenas chamam a 60 Hz).
   ============================================================ */

/** Pulso acima disto dispara o evento... O pulso já vem multiplicado pelo
    depth do Tweaks (0,55 no padrão, 1,0 na cfg do CEO): 0,18 dispara na
    mesma taxa nos dois (replay do sinal real: ~0,55 evento/s, o mesmo
    número de kicks que o próprio pulso tem — a taxa é do sinal, não do
    limiar). */
export const KICK_ON = 0.18;
/** ...e só rearma depois de cair abaixo disto (histerese). */
export const KICK_OFF = 0.08;
/** Intervalo mínimo entre eventos (s). 0,34 s = no máximo ~2,9 por
    segundo: abaixo do teto de 3 flashes/s mesmo em rajada de bumbo
    (drum'n'bass a 175 BPM dispara em batidas alternadas). */
export const KICK_MIN_GAP = 0.34;

export interface KickTrigger {
  armed: boolean;
  /** Segundos desde o último evento. */
  since: number;
}

export function createKickTrigger(): KickTrigger {
  return { armed: true, since: KICK_MIN_GAP };
}

/** Avança o detector; devolve true no quadro do evento. */
export function stepKickTrigger(k: KickTrigger, pulse: number, dt: number): boolean {
  k.since += dt > 0 ? dt : 0;
  if (!k.armed) {
    if (pulse < KICK_OFF) k.armed = true;
    return false;
  }
  if (pulse >= KICK_ON && k.since >= KICK_MIN_GAP) {
    k.armed = false;
    k.since = 0;
    return true;
  }
  return false;
}

/** Tau (s) da soltura do surge: o empurrão dura ~1 batida a 120 BPM. */
export const SURGE_TAU = 0.45;

/** Envelope de pico do pulso: sobe junto, cai com SURGE_TAU. */
export function stepSurge(surge: number, pulse: number, dt: number): number {
  const decayed = dt > 0 ? surge * Math.exp(-dt / SURGE_TAU) : surge;
  const p = pulse > 0 ? (pulse < 1 ? pulse : 1) : 0;
  return p > decayed ? p : decayed;
}

/* ---------- memória do pulso ---------- */

/** Taxa da memória (amostras por segundo de relógio virtual). */
export const HIST_RATE = 30;

export interface PulseHistory {
  buf: Float32Array;
  /** Próxima posição de escrita. */
  head: number;
  /** Tempo acumulado ainda não amostrado (s de relógio). */
  acc: number;
}

/** `seconds` = quanto passado a cena precisa ler. */
export function createPulseHistory(seconds: number): PulseHistory {
  return { buf: new Float32Array(Math.max(2, Math.ceil(seconds * HIST_RATE) + 2)), head: 0, acc: 0 };
}

/** Grava o pulso atual a cada 1/HIST_RATE s de relógio virtual. Delta
    zero ou negativo (Speed = 0) não grava: a memória congela. */
export function pushPulse(h: PulseHistory, pulse: number, dClock: number): void {
  if (!(dClock > 0)) return;
  h.acc += Math.min(dClock, 0.5);
  const step = 1 / HIST_RATE;
  while (h.acc >= step) {
    h.acc -= step;
    h.buf[h.head] = pulse;
    h.head = (h.head + 1) % h.buf.length;
  }
}

/** Pulso de `ago` segundos atrás (interpolado; além da memória = 0). */
export function pulseAgo(h: PulseHistory, ago: number): number {
  const n = h.buf.length;
  const x = Math.max(0, ago) * HIST_RATE;
  const i = Math.floor(x);
  if (i >= n - 1) return 0;
  const f = x - i;
  // head-1 é a amostra mais recente.
  const a = h.buf[(h.head - 1 - i + 2 * n) % n];
  const b = h.buf[(h.head - 2 - i + 2 * n) % n];
  return a + (b - a) * f;
}
