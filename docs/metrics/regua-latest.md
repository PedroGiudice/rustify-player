# Régua do autoplay — medição 2026-08-27

**Veredito: META NÃO batida: skip 60% > 55% (n=869) — revisar tunables do sinal v3 (HALF_LIFE_DAYS, PASSIVE_WEIGHT, thresholds em qdrant_client.rs).**

Eventos pós-sinal-v3 (signal_schema>=3; legado por data): 1513. Meta: skip do autoplay <= 55% (CMR-123). Streak de aceitação: média 0.65, max 169 (536 ciclos).

Skip por origin (pós-v3): autoplay 60% (n=869), station 84% (n=210), queue 75% (n=4), playlist 86% (n=309), manual 47% (n=75), album_seq 49% (n=35), repeat 33% (n=3)

Por dispositivo: (legado) skip 99% (n=255), cmrlinuxmachine skip 67% (n=833), s24 skip 50% (n=425)

Autoplay por semana:
- 2026-W33: n=638, skip 68%
- 2026-W34: n=164, skip 18%
- 2026-W35: n=67, skip 91%

Cobertura do motor (faixa sem vetor não é recomendável; sem vibe entra neutra no re-rank):
- MERT (áudio): 1756/1756 (100%)
- Letra: 1420/1420 das alcançáveis (100%); 336 sem letra em lugar nenhum (instrumental/miss).
- Vibe: 1746/1756 (99%) — faltam 10 (anotação ainda é batch manual, CMR-178)

Histórico completo: docs/metrics/regua-autoplay.jsonl. Medir à mão: `python3 scripts/metrics/autoplay_regua.py`.
