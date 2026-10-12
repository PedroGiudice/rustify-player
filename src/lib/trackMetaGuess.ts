export interface ScLike { title: string; user_name: string; created_at: string; release_date: string | null }
export interface MetaGuess { artist: string; title: string; album: string; year: number | null }

const KEEP_UPPER = new Set(["DJ", "MC", "BPM", "SP", "RJ", "BH", "ES", "PR", "RS", "EP", "VS", "FT", "FEAT", "LP", "OG", "UK", "US", "BR"]);
const FIXED: Record<string, string> = { MCS: "MCs", DJS: "DJs" };
const SMALL = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "em", "no", "na", "nos", "nas", "com", "pra", "pro", "x"]);

export function looksLikeUrl(s: string): boolean { return /(https?:\/\/|www\.|\.com\b|\.net\b|\.org\b|\.br\b)/i.test(s); }

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " e ").replace(/\band\b/g, " e ").replace(/[^a-z0-9$]+/g, "");
}

/** Igualdade frouxa: idêntico após normalizar, ou um é prefixo do outro com os dois >= 4 caracteres. */
export function looseEq(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (y.startsWith(x) || x.startsWith(y));
}

export function cleanTitle(raw: string): string {
  let s = raw;
  for (;;) {
    const prev = s;
    s = s.replace(/\.(mp3|wav|flac|aiff?)\s*$/i, "");
    s = s.replace(/[\(\[]\s*free\s*(download|dl)(\s+(wav|mp3|flac))?\s*[\)\]]/gi, "");
    s = s.replace(/\bfree\s*(download|dl)\b/gi, "");
    s = s.replace(/\s+(wav|mp3|flac)\s*$/i, "");
    s = s.replace(/\s+/g, " ").replace(/^\s*-\s*/, "").replace(/\s*-\s*$/, "").trim();
    if (s === prev) return s;
  }
}

export function smartCase(s: string): string {
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (!letters || letters !== letters.toUpperCase()) return s.trim();
  let prevCore = "";
  return s.trim().split(/\s+/).map((tok, i) => {
    const m = /^([^A-Za-z0-9À-ÿ$]*)(.*?)([^A-Za-z0-9À-ÿ$]*)$/.exec(tok)!;
    const [, pre, core, post] = m;
    const up = core.toUpperCase(), low = core.toLowerCase();
    let out: string;
    if (FIXED[up]) out = FIXED[up];
    else if (KEEP_UPPER.has(up) || /\d/.test(core)) out = up;
    else if (i > 0 && SMALL.has(low) && !(core.length === 1 && /^(DJ|MC)$/.test(prevCore))) out = low;
    else out = low.charAt(0).toUpperCase() + low.slice(1);
    prevCore = up;
    return pre + out + post;
  }).join(" ");
}

function profileName(user: string): string {
  if (/^user-\d+$/i.test(user) || looksLikeUrl(user)) return "";
  return smartCase(user.replace(/\s+(oficial|official)$/i, "").trim());
}

export function guessFromSoundCloud(t: ScLike): MetaGuess {
  const clean = cleanTitle(t.title);
  const profile = t.user_name.replace(/\s+(oficial|official)$/i, "");
  let artist = profileName(t.user_name);
  let title = clean;
  const parts = clean.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1], first = parts[0];
    if (looseEq(tail, profile)) { artist = smartCase(tail); title = parts.slice(0, -1).join(" - "); }
    // Heurística extra (registrada na spec §3.3): cabeça começando com DJ/MC é artista.
    else if (looseEq(first, profile) || /^(dj|mc)\b/i.test(first)) { artist = smartCase(first); title = parts.slice(1).join(" - "); }
  }
  title = smartCase(title);
  if (looksLikeUrl(artist)) artist = profileName(t.user_name);
  const dateSrc = t.release_date ?? t.created_at;
  const y = /^(\d{4})/.exec(dateSrc ?? "");
  return { artist, title, album: title, year: y ? parseInt(y[1], 10) : null };
}
