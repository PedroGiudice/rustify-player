# Régua do autoplay — medição 2026-09-25

**Veredito: META NÃO batida: skip 72% > 55% (n=1394) — revisar tunables do sinal v3 (HALF_LIFE_DAYS, PASSIVE_WEIGHT, thresholds em qdrant_client.rs).**

Eventos pós-sinal-v3 (signal_schema>=3; legado por data): 2828. Meta: skip do autoplay <= 55% (CMR-123). Streak de aceitação: média 0.38, max 169 (1029 ciclos).

Skip por origin (pós-v3): autoplay 72% (n=1394), station 82% (n=255), queue 83% (n=6), playlist 86% (n=960), manual 52% (n=107), album_seq 73% (n=90), repeat 33% (n=3)

Por dispositivo: (legado) skip 99% (n=255), cmrlinuxmachine skip 76% (n=1527), s24 skip 73% (n=1046)

Autoplay por semana:
- 2026-W33: n=638, skip 68%
- 2026-W34: n=164, skip 18%
- 2026-W35: n=292, skip 96%
- 2026-W36: n=110, skip 84%
- 2026-W37: n=63, skip 90%
- 2026-W38: n=127, skip 88%

Cobertura do motor (faixa sem vetor não é recomendável; sem vibe entra neutra no re-rank):
- MERT (áudio): 1757/1757 (100%)
- Letra: 1420/1421 das alcançáveis (100%) — faltam 1; 336 sem letra em lugar nenhum (instrumental/miss).
- Vibe: 1746/1757 (99%) — faltam 11 (anotação ainda é batch manual, CMR-178)

Histórico completo: docs/metrics/regua-autoplay.jsonl. Medir à mão: `python3 scripts/metrics/autoplay_regua.py`.
