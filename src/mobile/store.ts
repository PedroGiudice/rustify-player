/* ============================================================
   store.ts — estado da UI mobile.

   Princípio: a fila e o avanço automático vivem no Kotlin. Este
   store REFLETE o estado do serviço (eventos do plugin + get_state
   + get_queue). Quem manda é sempre o serviço.

   A fila é LIDA do serviço (`get_queue`), não espelhada: o espelho
   em localStorage que existia aqui mentia sempre que o WebView
   reiniciava com o serviço tocando — a tela chegava a mostrar
   "Fila indisponível" com música saindo do alto-falante.

   Não há log de escuta aqui: o journal do service é a verdade.
   ============================================================ */

import { createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as ipc from "./ipc";
import { deriveAlbums, deriveArtists, shuffled } from "./derive";
import {
  effectiveLiked,
  loadOverrides,
  pruneOverrides,
  saveOverrides,
  type LikeOverrides,
} from "./likes";
import { canShuffleUpcoming, remainingMs, resolveQueue, skipReport } from "./queueModel";
import type {
  Folder,
  Origin,
  PlaybackState,
  QueueEntry,
  RepeatMode,
  StationMeta,
  Track,
  TrackContext,
} from "./types";

// ── Biblioteca ────────────────────────────────────────────────

const [tracks, setTracks] = createSignal<Track[]>([]);
const [folders, setFolders] = createSignal<Folder[]>([]);
const [libReady, setLibReady] = createSignal(false);
const [libError, setLibError] = createSignal<string | null>(null);

export { tracks, folders, libReady, libError };

export const albums = createMemo(() => deriveAlbums(tracks()));
export const artists = createMemo(() => deriveArtists(tracks()));

const byId = createMemo(() => {
  const m = new Map<string, Track>();
  for (const t of tracks()) m.set(t.id, t);
  return m;
});

// ── Inteligência local (CMR-190) ──────────────────────────────
// Alimentada pelos artefatos de .rustify/ — sem eles, listas vazias
// e as seções somem da UI. Carga best-effort pós-boot.

const [stations, setStations] = createSignal<StationMeta[]>([]);
const [favorites, setFavorites] = createSignal<Track[]>([]);
/** Shelf "Recently played" (CMR-215) — o que CONTOU como play, do anel de
 *  recentes do Rust. Recarregada a cada troca de faixa, no fim da fila e ao
 *  voltar à tela. */
const [recents, setRecents] = createSignal<Track[]>([]);

export { stations, favorites, recents };

let recentsInflight: Promise<void> | null = null;
/** Alguém chamou durante o voo: a ida em curso pode ter drenado o journal
 *  ANTES do evento que motivou a chamada nova (a faixa fechou depois). */
let recentsDirty = false;

/** Chamadas concorrentes (foco + track_changed + fim de fila chegam juntos)
 *  reaproveitam a promise em voo — cada uma drenaria o journal de novo à toa.
 *  Mas a chamada que chega no meio não se perde: marca dirty e o finally
 *  dispara UMA re-execução (é um bit, não um contador — N chamadas no voo
 *  viram uma ida só). */
export function loadRecents(): Promise<void> {
  if (recentsInflight) {
    recentsDirty = true;
    return recentsInflight;
  }
  recentsInflight = (async () => {
    try {
      setRecents((await ipc.libRecentPlays(8)) ?? []);
    } catch (e) {
      console.warn("[mobile] lib_recent_plays falhou:", e);
    } finally {
      recentsInflight = null;
      if (recentsDirty) {
        recentsDirty = false;
        void loadRecents();
      }
    }
  })();
  return recentsInflight;
}

async function loadIntel() {
  try {
    const [st, fav] = await Promise.all([ipc.libListStations(), ipc.libTastePositives()]);
    setStations(st ?? []);
    setFavorites(fav ?? []);
  } catch (e) {
    console.warn("[mobile] carga de stations/favorites falhou:", e);
  }
  await loadRecents();
}

// ── Playback (espelho do serviço) ─────────────────────────────

const [pb, setPb] = createStore<PlaybackState>({
  status: "idle",
  index: -1,
  trackId: null,
  positionMs: 0,
  durationMs: 0,
  isPlaying: false,
  count: 0,
});

/** Fila do SERVIÇO. Otimista no ato do play, corrigida pelo snapshot. */
const [queueEntries, setQueueEntries] = createSignal<QueueEntry[]>([]);
const [resolved, setResolved] = createSignal<Track | null>(null);

/** Fila resolvida contra o acervo. `null` = faixa que o manifest não
 *  conhece — a posição é preservada para os índices baterem com o serviço. */
export const queue = createMemo(() => resolveQueue({ items: queueEntries(), index: pb.index }, byId()).items);

/** Origem da faixa CORRENTE (o wire é per-item). */
export const queueOrigin = createMemo<Origin>(() => {
  const e = queueEntries()[pb.index];
  return (e?.origin as Origin) ?? "manual";
});

/** Tempo restante da fila (faixa corrente + próximas). */
export const queueRemainingMs = createMemo(() =>
  remainingMs(queueEntries(), pb.index, pb.positionMs),
);

export { pb, queueEntries };

export const current = createMemo<Track | null>(() => {
  const q = queue();
  const i = pb.index;
  const at = i >= 0 && i < q.length ? q[i] : null;
  if (at && (!pb.trackId || at.id === pb.trackId)) return at;
  if (pb.trackId) {
    const inQueue = q.find((t) => t != null && t.id === pb.trackId);
    if (inQueue) return inQueue;
    const inLib = byId().get(pb.trackId);
    if (inLib) return inLib;
  }
  return resolved();
});

export const hasPlayback = createMemo(() => current() != null);

// ── Toast ─────────────────────────────────────────────────────

const [toast, setToast] = createSignal<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export { toast };
export function showToast(msg: string) {
  setToast(msg);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToast(null), 1600);
}

// ── Leitura da fila real ──────────────────────────────────────

/**
 * Lê a fila do serviço. Chamada no boot, ao voltar do background e a
 * cada troca de faixa — os três momentos em que o que a UI acha pode
 * ter divergido do que o ExoPlayer está tocando.
 */
export async function syncQueue() {
  try {
    const snap = await ipc.playerGetQueue();
    setQueueEntries(snap?.items ?? []);
    if (typeof snap?.index === "number") setPb("index", snap.index);
  } catch (e) {
    // Fila indisponível não zera o que já está na tela: melhor mostrar o
    // último estado conhecido do que esvaziar a fila por um erro de IPC.
    console.warn("[mobile] get_queue falhou:", e);
  }
}

// ── Aplicação de estado vindo do serviço ──────────────────────

let resolving: string | null = null;

function applyState(s: Partial<PlaybackState> | null | undefined) {
  if (!s) return;
  // Merge por chave PRESENTE: os eventos são best-effort e o tick de
  // `position` pode chegar enxuto. Preencher o que falta com default
  // zeraria índice/faixa 2x por segundo.
  const patch: Partial<PlaybackState> = {};
  if (typeof s.status === "string") patch.status = s.status;
  if (typeof s.index === "number") patch.index = s.index;
  if (s.trackId !== undefined) patch.trackId = s.trackId ?? null;
  if (typeof s.positionMs === "number") patch.positionMs = s.positionMs;
  if (typeof s.durationMs === "number") patch.durationMs = s.durationMs;
  if (typeof s.isPlaying === "boolean") patch.isPlaying = s.isPlaying;
  if (typeof s.count === "number") patch.count = s.count;
  setPb(patch);

  // WebView reiniciou com o serviço tocando: o espelho pode não ter a
  // faixa. Resolve pelo id para o mini player não ficar mudo.
  const id = s.trackId;
  if (id && !queue().some((t) => t.id === id) && !byId().has(id) && resolving !== id) {
    resolving = id;
    ipc
      .libGetTracksByIds([id])
      .then((list) => {
        if (list && list[0]) setResolved(list[0]);
      })
      .catch(() => {})
      .finally(() => {
        resolving = null;
      });
  }
}

export async function syncState() {
  try {
    applyState(await ipc.playerGetState());
  } catch (e) {
    console.warn("[mobile] get_state falhou:", e);
  }
}

// ── Ações ─────────────────────────────────────────────────────

/** Como a fila se auto-abastece quando acabar (epic B). */
type Continuity = { mode: "off" | "radio" | "station"; stationId?: string };

/**
 * Único caminho para começar a tocar. `origin` vai cru para o
 * contrato — os nomes são os que o motor de sinal entende.
 *
 * `headOrigin`: origem SÓ da faixa em `startIndex` (o wire é por item). É o
 * que separa "a faixa que o usuário escolheu" da cauda que o Kotlin
 * auto-avança — a linha tocada numa playlist é `manual`, o resto `playlist`.
 */
export async function playList(
  list: Track[],
  startIndex: number,
  origin: Origin,
  contextId: string | null = null,
  continuity: Continuity = { mode: "radio" },
  headOrigin: Origin | null = null,
) {
  if (!list.length) {
    showToast("Nada para tocar aqui");
    return;
  }
  const start = Math.max(0, Math.min(startIndex, list.length - 1));
  const originAt = (i: number) => (headOrigin != null && i === start ? headOrigin : origin);
  // Otimista: a tela responde no ato. O snapshot do serviço confirma logo
  // depois — e é ele quem manda se divergirem.
  setQueueEntries(
    list.map((t, i) => ({
      trackId: t.id,
      origin: originAt(i),
      contextId,
      durationMs: t.duration_ms,
    })),
  );
  setPb({ index: start, trackId: list[start].id, positionMs: 0, durationMs: list[start].duration_ms, isPlaying: true });
  const items = ipc.toQueueItems(list);
  // O metaMap do Kotlin NÃO herda o contextId da fila num item com origin
  // próprio: o contexto vai explícito no item, senão a faixa escolhida
  // logaria sem a pasta.
  if (headOrigin != null) items[start] = { ...items[start], origin: headOrigin, contextId };
  try {
    await ipc.playerSetQueue({
      items,
      startIndex: start,
      origin,
      contextId,
      playNow: true,
    });
    await syncQueue();
    // Arma DEPOIS do set_queue: o tender só deve reabastecer a fila nova.
    await ipc
      .continuityArm({
        mode: continuity.mode,
        stationId: continuity.stationId ?? null,
        seedTrackId: list[start].id,
      })
      .catch((e) => console.warn("[mobile] continuity_arm falhou:", e));
  } catch (e) {
    console.error("[mobile] set_queue falhou:", e);
    showToast("Falha ao iniciar a reprodução");
    await syncState();
    await syncQueue();
  }
}

// Regra de continuidade (decisão do CEO, 2026-08-17): ligada por padrão em
// qualquer fila, com duas exceções — a playlist, que é coleção curada com
// começo e fim e deve TERMINAR, e a station, que já tem o modo de continuação
// dela (o pool próprio, não um rádio semeado).
export const playTrackFrom = (list: Track[], index: number) => playList(list, index, "manual");
export const playFolder = (list: Track[], name: string) =>
  playList(list, 0, "playlist", name, { mode: "off" });
/** Linha tocada (e "Tocar agora" da sheet) DENTRO de uma playlist: a fila é
 *  a pasta inteira a partir daquele índice e herda a exceção do Play — pasta
 *  como contexto, continuidade OFF. Com o default do playTrackFrom (radio, sem
 *  contexto) a playlist não terminava: o tender anexava lotes do acervo a 2
 *  posições do fim (CMR-211, o último caminho que faltava).
 *
 *  Origem POR ITEM: só a faixa escolhida é `manual`; a cauda que o Kotlin
 *  auto-avança é `playlist` (escuta passiva, desconto 0.6 no sinal v3) — é o
 *  mesmo que o desktop faz (head manual + continuações playlist). A fila
 *  inteira como `manual` dava peso cheio a faixas que ninguém escolheu. */
export const playFolderFrom = (list: Track[], index: number, name: string) =>
  playList(list, index, "playlist", name, { mode: "off" }, "manual");
export const playAlbum = (list: Track[], key: string) => playList(list, 0, "album_seq", key);
// `autoplay`, não "shuffle": a sequência foi escolhida pela máquina, e é assim
// que o sinal v3 a conhece (desconto de origem passiva). "shuffle" estava fora
// do vocabulário do motor e entrava com peso CHEIO no saldo — decisão do CEO
// no plano de paridade: mapear aqui, sem mexer em dado já gravado.
export const shuffleList = (
  list: Track[],
  contextId: string | null = null,
  continuity: Continuity = { mode: "radio" },
) => playList(shuffled(list), 0, "autoplay", contextId, continuity);
export const shuffleAll = () => shuffleList(tracks());
/** Shuffle da playlist herda a exceção do Play: a pasta como contexto e
 *  continuidade OFF. Com o default (`radio`) o tender anexava lotes do acervo
 *  inteiro a 2 posições do fim e a sessão virava "shuffle geral" (CMR-211). */
export const shuffleFolder = (list: Track[], name: string) =>
  shuffleList(list, name, { mode: "off" });
/** "Tocar a partir daqui" da sheet: a faixa segurada abre a fila e o que
 *  vinha depois dela entra embaralhado — cauda escolhida pela máquina, origin
 *  `autoplay`. Dentro de uma playlist herda a exceção do Play (pasta como
 *  contexto, continuidade OFF): sem isso a sessão virava "shuffle geral" pelo
 *  mesmo mecanismo do shuffleFolder (CMR-211, outro caminho). */
export const playFromHere = (ctx: TrackContext) => {
  const head = ctx.list[ctx.index];
  if (!head) return playList([], 0, "autoplay");
  const list = [head, ...shuffled(ctx.list.slice(ctx.index + 1))];
  return ctx.playlist != null
    ? playList(list, 0, "autoplay", ctx.playlist, { mode: "off" })
    : playList(list, 0, "autoplay");
};

/** Toca uma station: lote do pool precomputado + re-rank local.
 *  origin `station` — o sinal v3 desconta origem passiva. */
export async function playStation(st: StationMeta) {
  try {
    const batch = await ipc.libPlayStation(st.id, 40);
    if (!batch.length) {
      showToast("Station sem faixas no acervo");
      return;
    }
    await playList(batch, 0, "station", st.id, { mode: "station", stationId: st.id });
  } catch (e) {
    console.error("[mobile] lib_play_station falhou:", e);
    showToast("Falha ao iniciar a station");
  }
}

/**
 * Rádio da faixa. Toca SEMPRE que houver acervo: faixa recém-chegada, ainda
 * sem vetor, cai pra artista/pasta e, no limite, pro acervo inteiro. O toast
 * diz em que modo está — antes ele acusava "sem vetores, rode o export", o que
 * culpava a configuração por uma faixa que só era nova.
 *
 * `origin: autoplay` (não `station`): quem escolheu foi o motor, e só a
 * station real deve contar como station na régua. `contextId` segue a mesma
 * convenção do tender (`radio:<seed>:<epoch>`) para os dois lados agruparem
 * a mesma rodada.
 */
export async function playSimilar(track: Track) {
  try {
    const { tracks: lote, layer } = await ipc.libRadioStart(track.id, 30);
    if (!lote.length) {
      showToast("Acervo vazio");
      return;
    }
    await playList(lote, 0, "autoplay", `radio:${track.id}:${Date.now()}`, {
      mode: "radio",
    });
    showToast(
      layer === "vector"
        ? `Rádio: ${track.title}`
        : layer === "artistFolder"
          ? `Rádio por artista — ${track.title} ainda sem análise`
          : `Rádio do acervo — ${track.title} ainda sem análise`,
    );
  } catch (e) {
    console.error("[mobile] lib_radio_start falhou:", e);
    showToast("Falha ao montar o rádio");
  }
}

/**
 * Enfileira uma faixa sem interromper o que toca.
 *
 * `origin: "manual"` mesmo dentro de uma station: pôr a faixa na fila é
 * escolha EXPLÍCITA do usuário e o sinal v3 dá peso cheio a isso — herdar
 * `station` marcaria como escuta passiva e o motor aprenderia errado. A
 * origem viaja por item (o desktop ainda carimba por fila; divergência
 * consciente, registrada no plano).
 */
async function enqueue(track: Track, mode: "next" | "end") {
  try {
    const snap = await ipc.playerAddItems({
      items: [{ ...ipc.toQueueItem(track), origin: "manual", contextId: null }],
      origin: "manual",
      mode,
    });
    // Aplica o que o serviço devolveu — nunca o que a UI supôs.
    setQueueEntries(snap?.items ?? []);
    if (typeof snap?.index === "number") setPb("index", snap.index);
    showToast(mode === "next" ? "Toca em seguida" : "Adicionada ao fim da fila");
  } catch (e) {
    console.error("[mobile] add_items falhou:", e);
    showToast("Falha ao enfileirar");
    await syncQueue();
  }
}

export const enqueueNext = (t: Track) => enqueue(t, "next");
export const enqueueEnd = (t: Track) => enqueue(t, "end");

/**
 * "Embaralhar o restante" (CMR-218): ação one-shot sobre a cauda ainda não
 * tocada — repetível, sem estado de "shuffle ligado" nem restauração da
 * ordem. A permutação acontece no Kotlin (`replaceMediaItems`, atômico frente
 * ao tender e ao auto-advance); a UI NUNCA reordena otimista — aplica só o
 * snapshot devolvido, senão a tela mostraria uma ordem que o serviço não tem.
 * Não é origin: a fila mantém a origem por item.
 */
export async function shuffleUpcoming() {
  if (!canShuffleUpcoming(queueEntries(), pb.index)) {
    showToast("Nada a embaralhar");
    return;
  }
  try {
    const snap = await ipc.playerShuffleUpcoming();
    setQueueEntries(snap?.items ?? []);
    if (typeof snap?.index === "number") setPb("index", snap.index);
    showToast("Restante embaralhado");
  } catch (e) {
    console.warn("[mobile] shuffle_upcoming falhou:", e);
    await syncQueue();
  }
}

// ── Continuidade ──────────────────────────────────────────────

const CONTINUITY_KEY = "kv-mobile-continuity";
const [continuityOn, setContinuityOn] = createSignal(
  localStorage.getItem(CONTINUITY_KEY) !== "off",
);
export { continuityOn };

export async function setContinuity(on: boolean) {
  setContinuityOn(on);
  localStorage.setItem(CONTINUITY_KEY, on ? "on" : "off");
  try {
    await ipc.continuitySetEnabled(on);
    showToast(on ? "Continuar tocando ligado" : "A fila vai acabar sozinha");
  } catch (e) {
    console.warn("[mobile] continuity_set_enabled falhou:", e);
  }
}

// ── Like (CMR-220) ────────────────────────────────────────────
// O manifest semeia `liked_at`/`like_updated_at`; o gesto vira override
// otimista (kv-mobile-likes) e uma linha `like`/`unlike` no journal, que o
// sync leva ao desktop. Efetivo = o mais NOVO dos dois (`effectiveLiked`).
// Carregado no import: o store é módulo e o boot (bootStore) roda depois —
// ler aqui evita o coração piscar "não curtida" até o boot terminar.

const [likeOverrides, setLikeOverrides] = createSignal<LikeOverrides>(loadOverrides());

/** Estado efetivo do like de uma faixa (manifest x override, LWW). */
export const isLiked = (t: Track) => effectiveLiked(t, likeOverrides()[t.id]);

export async function toggleLike(t: Track) {
  const liked = !isLiked(t);
  const before = likeOverrides()[t.id];
  const at = Math.floor(Date.now() / 1000);
  // Otimista: o coração responde no ato; o journal é a verdade do gesto e o
  // desktop faz o LWW — falha do IPC desfaz o que a UI supôs.
  const mine = { liked, at };
  const next = { ...likeOverrides(), [t.id]: mine };
  setLikeOverrides(next);
  saveOverrides(next);
  try {
    await ipc.playerSetLike(t.id, liked);
    showToast(liked ? "Curtida" : "Curtida removida");
  } catch (e) {
    console.warn("[mobile] set_like falhou:", e);
    showToast("Falha ao registrar a curtida");
    // Reverte SÓ se o override vivo ainda é o desta chamada: dois toques
    // rápidos com o 1º falhando tarde não podem apagar o gesto do 2º (que o
    // journal já tem) — coração e LWW mentiriam.
    if (likeOverrides()[t.id] !== mine) return;
    const reverted = { ...likeOverrides() };
    if (before) reverted[t.id] = before;
    else delete reverted[t.id];
    setLikeOverrides(reverted);
    saveOverrides(reverted);
  }
}

/** Manifest novo chegou (boot/rescan): override que ele já absorveu (carimbo
 *  >= gesto) ou de faixa que sumiu do acervo é lixo — sem poda, o
 *  kv-mobile-likes só cresce. Poda só remove: contagem de chaves basta pra
 *  saber se mudou. */
function pruneLikeOverrides() {
  const before = likeOverrides();
  const after = pruneOverrides(before, tracks());
  if (Object.keys(after).length === Object.keys(before).length) return;
  setLikeOverrides(after);
  saveOverrides(after);
}

// ── Repeat ────────────────────────────────────────────────────
// Estado de SESSAO do player (ExoPlayer), persistido como preferencia.
// `one` faz o service carimbar origin `repeat` nas re-escutas — o sinal v3
// trata isso como positivo pleno, e ate agora o celular nao emitia nenhum.

const REPEAT_KEY = "kv-mobile-repeat";
const [repeat, setRepeat] = createSignal<RepeatMode>(
  (localStorage.getItem(REPEAT_KEY) as RepeatMode | null) ?? "off",
);
export { repeat };

const REPEAT_CYCLE: RepeatMode[] = ["off", "all", "one"];

export async function cycleRepeat() {
  const nextMode = REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(repeat()) + 1) % REPEAT_CYCLE.length];
  setRepeat(nextMode);
  localStorage.setItem(REPEAT_KEY, nextMode);
  try {
    await ipc.playerSetRepeatMode(nextMode);
    showToast(
      nextMode === "off" ? "Repetir desligado" : nextMode === "all" ? "Repetir fila" : "Repetir faixa",
    );
  } catch (e) {
    console.warn("[mobile] set_repeat_mode falhou:", e);
  }
}

/** Reaplica a preferência ao serviço (boot e reconexão). */
export async function applyRepeat() {
  try {
    await ipc.playerSetRepeatMode(repeat());
  } catch (e) {
    console.warn("[mobile] applyRepeat falhou:", e);
  }
}

export async function toggle() {
  try {
    if (pb.isPlaying) await ipc.playerPause();
    else await ipc.playerPlay();
    setPb("isPlaying", !pb.isPlaying);
  } catch (e) {
    console.warn("[mobile] play/pause falhou:", e);
    await syncState();
  }
}

/** Reporta a rejeição ANTES de sair da faixa — depois do skip o pb já mudou. */
async function reportSkip(target?: number) {
  const r = skipReport(pb, target);
  if (!r) return;
  try {
    await ipc.continuityNoteSkip(r.trackId, r.positionMs, r.durationMs);
  } catch (e) {
    // O journal cobre este skip no próximo ciclo — perder o atalho de
    // latência não perde o sinal.
    console.warn("[mobile] note_skip falhou:", e);
  }
}

export async function next() {
  void reportSkip();
  try {
    const r = await ipc.playerNext();
    // Fim da fila com continuidade desligada: o serviço apenas para.
    if (r && r.moved === false) showToast("Fim da fila");
  } catch (e) {
    console.warn("[mobile] next falhou:", e);
    showToast("Falha ao avançar");
  }
}

export async function previous() {
  try {
    await ipc.playerPrevious();
  } catch (e) {
    console.warn("[mobile] previous falhou:", e);
  }
}

export async function seek(positionMs: number) {
  const ms = Math.max(0, Math.round(positionMs));
  setPb("positionMs", ms);
  try {
    await ipc.playerSeekTo(ms);
  } catch (e) {
    console.warn("[mobile] seek_to falhou:", e);
    await syncState();
  }
}

export async function skipToIndex(index: number) {
  void reportSkip(index);
  setPb("index", index);
  try {
    await ipc.playerSkipToIndex(index);
  } catch (e) {
    console.warn("[mobile] skip_to_index falhou:", e);
    await syncState();
  }
}

const [rescanning, setRescanning] = createSignal(false);
export { rescanning };

export async function rescan() {
  if (rescanning()) return;
  setRescanning(true);
  try {
    const count = await ipc.libRescan();
    await loadLibrary();
    await loadIntel();
    showToast(`Biblioteca re-indexada · ${count} faixas`);
  } catch (e) {
    console.error("[mobile] lib_rescan falhou:", e);
    showToast("Falha ao re-indexar");
  } finally {
    setRescanning(false);
  }
}

// ── Boot ──────────────────────────────────────────────────────

async function loadLibrary() {
  const [t, f] = await Promise.all([ipc.libListTracks(), ipc.libListFolders()]);
  setTracks(t ?? []);
  setFolders(f ?? []);
  pruneLikeOverrides();
}

// Invoke disparado no boot frio pode se perder antes de a bridge nativa do
// WebView anexar — a promise nunca liquida e pendura o boot inteiro
// (visto no S24 em 14/08: "Carregando biblioteca…" eterno; reload quente
// funcionava). Corrida com timeout + retry resolve os dois casos: mensagem
// perdida (re-invoca) e lentidão real (segunda chance).
async function bootCall<T>(
  label: string,
  call: () => Promise<T>,
  timeoutMs: number,
  tries = 3,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`${label}: timeout ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
    } catch (e) {
      if (i >= tries) throw e;
      console.warn(`[mobile] ${label} tentativa ${i}:`, e);
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

export async function bootStore() {
  // initialize PRECISA vir antes de qualquer outra chamada ao plugin.
  try {
    await bootCall("initialize", () => ipc.playerInitialize(), 3000);
  } catch (e) {
    console.error("[mobile] initialize falhou:", e);
  }

  try {
    await bootCall("loadLibrary", loadLibrary, 6000);
    setLibError(null);
  } catch (e) {
    console.error("[mobile] carga da biblioteca falhou:", e);
    setLibError(String(e));
  } finally {
    setLibReady(true);
  }

  await syncState();
  // A fila vem do serviço — inclusive quando o WebView reiniciou sozinho
  // e o playback nunca parou.
  await bootCall("syncQueue", syncQueue, 4000).catch((e) =>
    console.warn("[mobile] carga da fila falhou:", e),
  );
  void applyRepeat();
  void ipc.continuitySetEnabled(continuityOn()).catch(() => {});
  void loadIntel();

  // O tender anexou um lote: redesenha a fila se a UI estiver acordada.
  // Dormindo, o evento se perde e o syncQueue do resume cobre.
  void import("@tauri-apps/api/event")
    .then((m) => m.listen("rustify://queue-changed", () => void syncQueue()))
    .catch((e) => console.warn("[mobile] listener queue-changed:", e));

  ipc
    .onStateChanged((s) => {
      applyState(s);
      // Fim da fila não emite track_changed: a última faixa fecha no
      // journal (o service appenda antes de emitir) e só `ended` avisa.
      if (s.status === "ended") void loadRecents();
    })
    .catch((e) => console.warn("[mobile] listener state_changed:", e));
  ipc
    .onTrackChanged((s) => {
      applyState(s);
      // A fila pode ter mudado junto com a faixa (enfileirar, autoplay).
      void syncQueue();
      // A faixa que acabou de fechar já está no journal (o service appenda
      // antes de emitir): a shelf de recentes sobe na hora.
      void loadRecents();
    })
    .catch((e) => console.warn("[mobile] listener track_changed:", e));
  ipc.onPosition(applyState).catch((e) => console.warn("[mobile] listener position:", e));

  // O WebView do Android é suspenso em background: ao voltar, o estado
  // pode ter andado (a fila avançou sozinha). Re-sincroniza.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void syncState();
      void syncQueue();
      void loadRecents();
    }
  });
  window.addEventListener("focus", () => {
    void syncState();
    void syncQueue();
    void loadRecents();
  });

  // Hook de smoke via CDP: os testes no aparelho precisam exercitar o CAMINHO
  // REAL do store (a decisão de continuidade vive em playFolder/playFolderFrom/
  // playAlbum/playStation/shuffleFolder/playFromHere), não re-invocar os
  // commands na mão. Sem isso cada smoke valida só o backend e a regra do store fica no
  // escuro.
  (window as unknown as Record<string, unknown>).__mobileStore = {
    playList,
    playFolder,
    playFolderFrom,
    playAlbum,
    playStation,
    playSimilar,
    shuffleList,
    shuffleFolder,
    playFromHere,
    shuffleUpcoming,
    toggleLike,
    isLiked,
    next,
    skipToIndex,
    loadRecents,
  };
}
