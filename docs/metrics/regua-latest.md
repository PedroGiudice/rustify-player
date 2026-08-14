# Régua do autoplay — medição 2026-08-13

**Veredito: META NÃO batida: skip 90% > 55% (n=90) — revisar tunables do sinal v3 (HALF_LIFE_DAYS, PASSIVE_WEIGHT, thresholds em qdrant_client.rs).**

Eventos pós-sinal-v3 (signal_schema>=3; legado por data): 303. Meta: skip do autoplay <= 55% (CMR-123). Streak de aceitação: média 0.11, max 3 (83 ciclos).

Skip por origin (pós-v3): autoplay 90% (n=90), station 97% (n=95), playlist 100% (n=112), manual 50% (n=4)

Por dispositivo: (legado) skip 99% (n=255), cmrlinuxmachine skip 80% (n=46), s24 skip 0% (n=2)

Autoplay por semana:
- 2026-W33: n=90, skip 90%

Cobertura do motor (faixa sem vetor não é recomendável; sem vibe entra neutra no re-rank):
- MERT (áudio): 1746/1746 (100%)
- Letra: 1410/1410 das alcançáveis (100%); 336 sem letra em lugar nenhum (instrumental/miss).
- Vibe: 1746/1746 (100%)

Histórico completo: docs/metrics/regua-autoplay.jsonl. Medir à mão: `python3 scripts/metrics/autoplay_regua.py`.
