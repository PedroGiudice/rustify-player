import { describe, it, expect } from "vitest";
import { guessFromSoundCloud, cleanTitle, smartCase, looseEq, looksLikeUrl } from "./trackMetaGuess";

const base = { created_at: "2024-12-26T10:00:00Z", release_date: null };

describe("trackMetaGuess", () => {
  it("separa 'TÍTULO - ARTISTA' quando a cauda bate com o perfil", () => {
    const g = guessFromSoundCloud({ ...base, title: "FESTA DO PENTE RALA - DJ ARANA.mp3", user_name: "DJ ARANA OFICIAL" });
    expect(g).toEqual({ artist: "DJ Arana", title: "Festa do Pente Rala", album: "Festa do Pente Rala", year: 2024 });
  });
  it("heurística DJ/MC: cabeça com prefixo DJ/MC vira artista", () => {
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
  it("cabeça bate com o perfil por looseEq, sem prefixo DJ/MC", () => {
    const g = guessFromSoundCloud({ ...base, title: "Adame - Job", user_name: "Adame DJ" });
    expect(g).toEqual({ artist: "Adame", title: "Job", album: "Job", year: 2024 });
  });
  it("título de 3 partes: partições complementares", () => {
    expect(guessFromSoundCloud({ ...base, title: "DJ ARANA - FESTA DO PENTE - REMIX", user_name: "Funk Hits" }))
      .toEqual({ artist: "DJ Arana", title: "Festa do Pente - Remix", album: "Festa do Pente - Remix", year: 2024 });
    expect(guessFromSoundCloud({ ...base, title: "MC A - MC B - MÚSICA", user_name: "MC A" }))
      .toEqual({ artist: "MC A", title: "MC B - Música", album: "MC B - Música", year: 2024 });
  });
  it("artista com cara de URL cai no nome do perfil", () => {
    const g = guessFromSoundCloud({ ...base, title: "DJ EMILIO WWW.FTPDJEMILIO.COM - FESTA", user_name: "Canal" });
    expect(g.artist).toBe("Canal");
    expect(guessFromSoundCloud({ ...base, title: "FESTA", user_name: "www.x.com" }).artist).toBe("");
    expect(guessFromSoundCloud({ ...base, title: "FESTA - www.ftpdjemilio.com", user_name: "www.ftpdjemilio.com" }).artist).toBe("");
  });
  it("cleanTitle remove combinações até estabilizar", () => {
    expect(cleanTitle("FESTA FREE DOWNLOAD")).toBe("FESTA");
    expect(cleanTitle("FESTA.mp3 (FREE DOWNLOAD)")).toBe("FESTA");
    expect(cleanTitle("FESTA [FREE DOWNLOAD WAV]")).toBe("FESTA");
    expect(cleanTitle("(FREE DOWNLOAD) - FESTA")).toBe("FESTA");
    expect(guessFromSoundCloud({ ...base, title: "FREE DOWNLOAD - DJ ARANA - FESTA", user_name: "x y z" }).artist).toBe("DJ Arana");
  });
  it("smartCase preserva sigla grudada em pontuação e nome de uma letra", () => {
    expect(smartCase("FESTA (SP)")).toBe("Festa (SP)");
    expect(smartCase("EVERON (BR)")).toBe("Everon (BR)");
    expect(smartCase("FESTA (MC GW)")).toBe("Festa (MC Gw)");
    expect(smartCase("OS MCS DA ZN")).toBe("Os MCs da Zn");
    expect(smartCase("DJ X E MC A")).toBe("DJ X e MC A");
  });
  it("looseEq: prefixo exige os dois lados >= 4 e normaliza Unicode", () => {
    expect(looseEq("DJ Arana", "DJ")).toBe(false);
    expect(looseEq("DJ", "DJ Arana")).toBe(false);
    expect(looseEq("JOSÉ", "Jose\u0301".normalize("NFD"))).toBe(true);
    expect(looseEq("ARANA BEATS", "Arana")).toBe(true);
  });
});
