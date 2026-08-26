/* ============================================================
   likes.test.ts — estado do like no aparelho (CMR-220).

   O manifest semeia `liked_at`/`like_updated_at` (verdade do
   desktop na hora do export); o gesto local vira um override
   otimista carimbado com `at`. Quem vence é o mais NOVO — o
   mesmo LWW que o desktop aplica em track_enrichments.
   ============================================================ */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveLiked, loadOverrides, saveOverrides } from "./likes";
import type { Track } from "./types";

const KEY = "kv-mobile-likes";

const track = (p: Partial<Track> = {}): Track => ({
  id: "1",
  title: "t",
  artist_name: null,
  album_title: null,
  album_cover_path: null,
  album_year: null,
  duration_ms: 1000,
  path: "/m/t.opus",
  lrc_path: null,
  track_number: null,
  genre_name: null,
  dominant_color: null,
  liked_at: null,
  like_updated_at: null,
  ...p,
});

describe("effectiveLiked", () => {
  it("sem override usa o manifest: liked_at preenchido = curtida", () => {
    expect(effectiveLiked(track({ liked_at: 100, like_updated_at: 100 }), undefined)).toBe(true);
    expect(effectiveLiked(track({ liked_at: null, like_updated_at: 200 }), undefined)).toBe(false);
    expect(effectiveLiked(track(), undefined)).toBe(false);
  });

  it("override mais novo que o manifest vence", () => {
    const t = track({ liked_at: 100, like_updated_at: 100 });
    expect(effectiveLiked(t, { liked: false, at: 101 })).toBe(false);
    expect(effectiveLiked(track(), { liked: true, at: 1 })).toBe(true);
  });

  it("manifest mais novo (like_updated_at) vence override antigo", () => {
    // O desktop descurtiu depois do like local → o export re-semeia e o
    // override velho não pode ressuscitar a curtida.
    const t = track({ liked_at: null, like_updated_at: 500 });
    expect(effectiveLiked(t, { liked: true, at: 400 })).toBe(false);
    // e o inverso: like no desktop depois de um unlike local
    const t2 = track({ liked_at: 600, like_updated_at: 600 });
    expect(effectiveLiked(t2, { liked: false, at: 400 })).toBe(true);
  });

  it("manifest sem like_updated_at compara contra liked_at", () => {
    const t = track({ liked_at: 300, like_updated_at: null });
    expect(effectiveLiked(t, { liked: false, at: 200 })).toBe(true);
    expect(effectiveLiked(t, { liked: false, at: 301 })).toBe(false);
  });
});

describe("loadOverrides / saveOverrides", () => {
  beforeEach(() => localStorage.removeItem(KEY));
  afterEach(() => vi.unstubAllGlobals());

  it("localStorage vazio → {}", () => {
    expect(loadOverrides()).toEqual({});
  });

  it("localStorage corrompido → {} (nunca lança)", () => {
    localStorage.setItem(KEY, "{garbage");
    expect(loadOverrides()).toEqual({});
    localStorage.setItem(KEY, "[1,2]");
    expect(loadOverrides()).toEqual({});
    localStorage.setItem(KEY, JSON.stringify({ a: { liked: "sim", at: "x" }, b: { liked: true, at: 7 } }));
    expect(loadOverrides()).toEqual({ b: { liked: true, at: 7 } });
  });

  it("localStorage indisponível (acessor lança) → {} e save não lança", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    expect(loadOverrides()).toEqual({});
    expect(() => saveOverrides({ x: { liked: true, at: 1 } })).not.toThrow();
  });

  it("round-trip", () => {
    const o = { "18446744073709551615": { liked: true, at: 10 }, "7": { liked: false, at: 11 } };
    saveOverrides(o);
    expect(loadOverrides()).toEqual(o);
  });
});
