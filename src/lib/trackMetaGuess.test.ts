import { describe, it, expect } from "vitest";
import { guessFromSoundCloud, cleanTitle, smartCase, looseEq, looksLikeUrl } from "./trackMetaGuess";

const base = { user_permalink: "x", created_at: "2024-12-26T10:00:00Z", release_date: null };

describe("trackMetaGuess", () => {
  it("separa 'TÍTULO - ARTISTA' quando a cauda bate com o perfil", () => {
    const g = guessFromSoundCloud({ ...base, title: "FESTA DO PENTE RALA - DJ ARANA.mp3", user_name: "DJ ARANA OFICIAL" });
    expect(g).toEqual({ artist: "DJ Arana", title: "Festa do Pente Rala", album: "Festa do Pente Rala", year: 2024 });
  });
  it("separa 'ARTISTA - TÍTULO' quando a cabeça bate com o perfil", () => {
    const g = guessFromSoundCloud({ ...base, title: "MC GW e DJ Piu - Bumbum na Nuca", user_name: "DJ PIU" });
    expect(g.artist).toBe("MC GW e DJ Piu");
    expect(g.title).toBe("Bumbum na Nuca");
  });
  it("sem separador usa o nome do perfil e limpa sufixos", () => {
    const g = guessFromSoundCloud({ ...base, title: "QUANDO A VONTADE BATER BRUXARIA (FREE DOWNLOAD)", user_name: "DJ NICOLAS BEAT" });
    expect(g.title).toBe("Quando a Vontade Bater Bruxaria");
    expect(g.artist).toBe("DJ Nicolas Beat");
  });
  it("perfil anônimo 'user-577945535' não vira artista", () => {
    const g = guessFromSoundCloud({ ...base, title: "UM CARA TRANQUILO", user_name: "user-577945535" });
    expect(g.artist).toBe("");
  });
  it("release_date vence created_at no ano", () => {
    const g = guessFromSoundCloud({ ...base, title: "Job", user_name: "Adame DJ", release_date: "2026-03-20T00:00:00Z" });
    expect(g.year).toBe(2026);
  });
  it("smartCase preserva siglas e tokens com dígitos", () => {
    expect(smartCase("MANDELÃO MC MR BIM 150BPM SP")).toBe("Mandelão MC Mr Bim 150BPM SP");
    expect(smartCase("Já em Title Case")).toBe("Já em Title Case");
  });
  it("cleanTitle tira (FREE DOWNLOAD), [FREE DL], .wav, WAV no fim e espaços", () => {
    expect(cleanTitle("X  [FREE DL] .wav")).toBe("X");
    expect(cleanTitle("BRUXARIA DO BECO DA MORTE wav")).toBe("BRUXARIA DO BECO DA MORTE");
  });
  it("looseEq e looksLikeUrl", () => {
    expect(looseEq("DJ ARANA", "Dj Arana Oficial")).toBe(true);
    expect(looseEq("Pe$te & Edge", "PE$TE e Edge")).toBe(true);
    expect(looseEq("DJ K", "DJ Arana")).toBe(false);
    expect(looksLikeUrl("www.ftpdjemilio.com")).toBe(true);
    expect(looksLikeUrl("DJ Anderson do Paraíso")).toBe(false);
  });
});
