export interface ScLike { title: string; user_name: string; user_permalink: string; created_at: string; release_date: string | null }
export interface MetaGuess { artist: string; title: string; album: string; year: number | null }

const KEEP_UPPER = new Set(["DJ", "MC", "MCS", "BPM", "SP", "RJ", "BH", "ES", "PR", "RS", "EP", "VS", "FT", "FEAT", "LP", "OG", "UK", "US"]);
const SMALL = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "em", "no", "na", "nos", "nas", "com", "pra", "pro", "x", "vs"]);

export function looksLikeUrl(s: string): boolean { return /(https?:\/\/|www\.|\.com\b|\.net\b|\.org\b|\.br\b)/i.test(s); }

export function looseEq(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/&/g, " e ").replace(/\band\b/g, " e ").replace(/[^a-z0-9à-ÿ]+/g, "");
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && (y.startsWith(x) || x.startsWith(y)));
}

export function cleanTitle(raw: string): string {
  let s = raw.replace(/\.(mp3|wav|flac|aiff?)$/i, "");
  s = s.replace(/[\(\[]\s*free\s*(download|dl)\s*[\)\]]/gi, "");
  s = s.replace(/\b(free\s*(download|dl))\b/gi, "");
  s = s.replace(/\s+(wav|mp3|flac)\s*$/i, "");
  return s.replace(/\s+/g, " ").replace(/\s*-\s*$/, "").trim();
}

export function smartCase(s: string): string {
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (!letters || letters !== letters.toUpperCase()) return s.trim();
  return s.toLowerCase().split(/\s+/).map((w, i) => {
    const up = w.toUpperCase();
    if (KEEP_UPPER.has(up) || /\d/.test(w)) return up;
    if (i > 0 && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
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
    const head = parts.slice(0, -1).join(" - "), tail = parts[parts.length - 1];
    if (looseEq(tail, profile)) { artist = smartCase(tail); title = head; }
    else if (looseEq(head, profile) || /^(dj|mc)\b/i.test(head)) { artist = smartCase(head); title = parts.slice(1).join(" - "); }
  }
  title = smartCase(title);
  if (looksLikeUrl(artist)) artist = "";
  const dateSrc = t.release_date ?? t.created_at;
  const y = /^(\d{4})/.exec(dateSrc ?? "");
  return { artist, title, album: title, year: y ? parseInt(y[1], 10) : null };
}
