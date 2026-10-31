import { describe, expect, it } from "vitest";
import { ACTIVITY_LABELS, MOOD_LABELS, activityLabel, moodLabel, queryWordLabel } from "./moodLabels";

// Cópia do vocabulário do Rust (qdrant_client.rs MOOD_VOCAB/ACTIVITY_VOCAB):
// se o Rust ganhar termo novo, este teste lembra de dar rótulo a ele.
const MOOD_VOCAB = [
  "aggressive", "anxious", "bittersweet", "chill", "confident", "dark", "dreamy", "driving",
  "energetic", "ethereal", "focus", "groovy", "intense", "melancholic", "nostalgic", "peaceful",
  "playful", "raw", "rebellious", "romantic", "sensual", "social", "triumphant", "uplifting",
];
const ACTIVITY_VOCAB = [
  "chill", "cleaning", "commute", "cooking", "driving", "focus", "gaming", "meditation",
  "party", "romance", "sleep", "social", "study", "workout",
];

describe("moodLabels", () => {
  it("todo termo do vocabulário tem rótulo", () => {
    expect(Object.keys(MOOD_LABELS).sort()).toEqual([...MOOD_VOCAB].sort());
    expect(Object.keys(ACTIVITY_LABELS).sort()).toEqual([...ACTIVITY_VOCAB].sort());
  });

  it("o mesmo termo muda de sentido entre clima e atividade", () => {
    expect(moodLabel("chill")).toBe("tranquilo");
    expect(activityLabel("chill")).toBe("relaxar");
    expect(moodLabel("driving")).toBe("pé na estrada");
    expect(activityLabel("driving")).toBe("dirigir");
  });

  it("chave desconhecida aparece como veio", () => {
    expect(moodLabel("vaporwave")).toBe("vaporwave");
    expect(activityLabel("surf")).toBe("surf");
  });

  it("palavra da query: clima, depois atividade, depois como veio", () => {
    expect(queryWordLabel("dark")).toBe("sombrio");
    expect(queryWordLabel("workout")).toBe("treino");
    expect(queryWordLabel("Funk")).toBe("Funk");
  });
});
