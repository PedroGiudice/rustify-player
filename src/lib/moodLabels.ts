// src/lib/moodLabels.ts — rótulo em PT-BR das fichas de clima e atividade
// da Stations (A50/CL-1, varredura de 31/10/2026).
//
// A CHAVE continua em inglês: é o token que o Rust devolve em
// `lib_mood_vocabulary` (MOOD_VOCAB / ACTIVITY_VOCAB em qdrant_client.rs) e
// que casa exato com o payload de `track_enrichments`. Traduzir a chave
// esvaziaria a station. Só o texto exibido passa por aqui; chave sem
// tradução aparece como veio.

/** Clima (MOOD_VOCAB, 24 termos). */
export const MOOD_LABELS: Readonly<Record<string, string>> = {
  aggressive: "agressivo",
  anxious: "ansioso",
  bittersweet: "agridoce",
  chill: "tranquilo",
  confident: "confiante",
  dark: "sombrio",
  dreamy: "sonhador",
  driving: "pé na estrada",
  energetic: "enérgico",
  ethereal: "etéreo",
  focus: "foco",
  groovy: "suingado",
  intense: "intenso",
  melancholic: "melancólico",
  nostalgic: "nostálgico",
  peaceful: "sereno",
  playful: "brincalhão",
  raw: "cru",
  rebellious: "rebelde",
  romantic: "romântico",
  sensual: "sensual",
  social: "social",
  triumphant: "triunfante",
  uplifting: "inspirador",
};

/** Atividade (ACTIVITY_VOCAB, 14 termos). "chill", "driving", "focus" e
    "social" existem nos dois grupos com sentidos diferentes. */
export const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  chill: "relaxar",
  cleaning: "faxina",
  commute: "trajeto",
  cooking: "cozinhar",
  driving: "dirigir",
  focus: "concentração",
  gaming: "jogar",
  meditation: "meditar",
  party: "festa",
  romance: "romance",
  sleep: "dormir",
  social: "reunir amigos",
  study: "estudar",
  workout: "treino",
};

/** Rótulo de uma ficha de clima; a chave crua se faltar tradução. */
export function moodLabel(key: string): string {
  return MOOD_LABELS[key.toLowerCase()] ?? key;
}

/** Rótulo de uma ficha de atividade; a chave crua se faltar tradução. */
export function activityLabel(key: string): string {
  return ACTIVITY_LABELS[key.toLowerCase()] ?? key;
}

/** Palavra solta da query de uma station por clima (o card não sabe de
    que grupo ela veio): clima primeiro, depois atividade, depois como
    veio (gênero, nome próprio). */
export function queryWordLabel(word: string): string {
  const k = word.toLowerCase();
  return MOOD_LABELS[k] ?? ACTIVITY_LABELS[k] ?? word;
}
