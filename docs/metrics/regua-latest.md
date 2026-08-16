# Régua do autoplay — medição 2026-08-15

**Veredito: META BATIDA: skip 54% <= 55% (n=424).**

Eventos pós-sinal-v3 (signal_schema>=3; legado por data): 731. Meta: skip do autoplay <= 55% (CMR-123). Streak de aceitação: média 0.83, max 169 (234 ciclos).

Skip por origin (pós-v3): autoplay 54% (n=424), station 97% (n=95), queue 75% (n=4), playlist 91% (n=189), manual 67% (n=12)

Por dispositivo: (legado) skip 99% (n=255), cmrlinuxmachine skip 54% (n=474), s24 skip 0% (n=2)

Autoplay por semana:
- 2026-W33: n=424, skip 54%

Cobertura do motor (faixa sem vetor não é recomendável; sem vibe entra neutra no re-rank):
- MERT (áudio): 1756/1756 (100%)
- Letra: 1420/1420 das alcançáveis (100%); 336 sem letra em lugar nenhum (instrumental/miss).
- Vibe: 1746/1756 (99%) — faltam 10 (anotação ainda é batch manual, CMR-178)

Histórico completo: docs/metrics/regua-autoplay.jsonl. Medir à mão: `python3 scripts/metrics/autoplay_regua.py`.
