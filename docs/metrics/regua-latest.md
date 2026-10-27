# Régua do autoplay — medição 2026-10-27

**Veredito: META NÃO batida: skip 77% > 55% (n=1885) — revisar tunables do sinal v3 (HALF_LIFE_DAYS, PASSIVE_WEIGHT, thresholds em qdrant_client.rs).**

Eventos pós-sinal-v3 (signal_schema>=3; legado por data): 4473. Meta: skip do autoplay <= 55% (CMR-123). Streak de aceitação: média 0.3, max 169 (1477 ciclos).

Skip por origin (pós-v3): autoplay 77% (n=1885), station 82% (n=286), queue 96% (n=86), playlist 89% (n=1958), manual 58% (n=132), album_seq 73% (n=95), repeat 33% (n=3)

Por dispositivo: (legado) skip 99% (n=255), cmrlinuxmachine skip 84% (n=3172), s24 skip 73% (n=1046)

Recortes do autoplay (não mudam o veredito): sem os pulos de até 5 s, skip 39% (n=723); desde a v0.2.92 (mistura conhecida/descoberta), skip 88% (n=303); desde a v0.2.92 sem os pulos de até 5 s, skip 60% (n=88).

Autoplay por semana:
- 2026-W33: n=638, skip 68%
- 2026-W34: n=164, skip 18%
- 2026-W35: n=292, skip 96%
- 2026-W36: n=110, skip 84%
- 2026-W37: n=63, skip 90%
- 2026-W38: n=127, skip 88%
- 2026-W39: n=125, skip 90%
- 2026-W41: n=63, skip 94%
- 2026-W42: n=181, skip 86%
- 2026-W43: n=122, skip 93%

Cobertura do motor (faixa sem vetor não é recomendável; sem vibe entra neutra no re-rank):
- MERT (áudio): 2203/2203 (100%)
- Letra: 1690/1675 das alcançáveis (101%); 528 sem letra em lugar nenhum (instrumental/miss).
- Vibe: 2164/2203 (98%) — faltam 39 (anotação ainda é batch manual, CMR-178)

Histórico completo: docs/metrics/regua-autoplay.jsonl. Medir à mão: `python3 scripts/metrics/autoplay_regua.py`.
