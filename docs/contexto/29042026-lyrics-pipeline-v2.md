# Contexto: Pipeline de Lyrics v2 — Separação + Transcrição + Avaliação

**Data:** 2026-04-29
**Sessão:** main (sem branch dedicado)
**Duração:** ~3h

---

## O que foi feito

### 1. Download dos LRCs do Modal para o repo

922 LRCs gerados pelo Whisper (pipeline v1: Demucs + Whisper large-v3 via vLLM) baixados do volume Modal `rustify-lyrics-data` para `data/lyrics-whisper/`. Naming: `ID.lrc`. Todos com timestamps.

Lyrics curadas do lrclib.net mantidas separadas em `data/lyrics/` (574 arquivos, naming: `ID__trackname.lrc`). 471 com timestamps, 102 plain text sem sync (candidatas a reprocessamento).

### 2. Teste comparativo de separadores vocais

Track de teste: **187 — Black Friday II** (Kendrick Lamar + J. Cole, 7:08).
Ground truth criado manualmente: `data/lyrics/Black_FridayII_real_lyrics.txt` (fonte: Genius).

Separadores testados localmente (`/tmp/audio-sep-venv/`, pacote `audio-separator`):

| Separador | Modelo | Resultado |
|-----------|--------|-----------|
| Demucs htdemucs_ft | 4 stems (bass, drums, other, vocals) | Baseline |
| BS-Roformer | model_bs_roformer_ep_317_sdr_12.9755 | **Vencedor** — melhor isolamento vocal |
| MDX-Net | Kim_Vocal_2 | Marginal vs Demucs |

### 3. Teste comparativo de transcritores

Cada transcritor rodado sobre stems dos 3 separadores:

| Transcritor | Plataforma | Resultado |
|-------------|-----------|-----------|
| SenseVoice Small (FunASR) | VM CPU, chunks 30s | Inadequado pra rap — vocabulário insuficiente |
| Whisper large-v3 (vLLM) | Modal H100 | **Vencedor** — melhor texto, timestamps |
| ACE-Step (Qwen2.5-Omni-7B) | Modal A100-40GB | Estrutura excelente (section tags), texto pior que Whisper, truncou em tracks longas |

### 4. Decisão: BS-Roformer substitui Demucs

Whisper + BS-Roformer vs Whisper + Demucs no Black Friday II:
- Intro: garbled → quase perfeito ("Rottweiler / Can you handle it")
- Seção J. Cole: garbled → correto ("Rollercoaster ride / How much do it cost")
- Texto geral: mais coerente, menos alucinações

### 5. Decisão: Pipeline v2 definido

1. **BS-Roformer** (Modal GPU) — separação vocal
2. **Whisper large-v3 2-pass** (Modal GPU) — 1ª passada normal, 2ª usa output do chunk anterior como prompt
3. **wav2vec2 MMS** (VM local, CPU) — forced alignment pra timestamps

### 6. Script ACE-Step criado e testado

`scripts/modal_acestep_transcriber.py` — app Modal para ACE-Step transcriber. A100-40GB, FA2, sem snapshot (carrega direto na GPU). Output: lyrics estruturadas com section tags.

Conclusão: ACE-Step é complementar (estrutura), não substituto (texto). Pipeline v2 usa Whisper como transcritor primário.

### 7. Levantamento de cobertura

| Fonte | Tracks |
|-------|--------|
| Total na biblioteca | 983 |
| lrclib.net com timestamps | 471 |
| Precisam do novo pipeline | 512 |
| Sem lyrics nenhuma (52) | DJ Piu (17), DJ Arana (16), Psytrance instrumental (17), Outros (2) |

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `data/lyrics/` | Existente | 574 LRCs lrclib.net (471 c/ timestamps, 102 plain text pendentes) |
| `data/lyrics-whisper/` | Criado | 922 LRCs Whisper v1 (todos c/ timestamps) |
| `data/lyrics/Black_FridayII_real_lyrics.txt` | Criado | Ground truth Genius, c/ section tags |
| `data/separation-test/` | Criado | Stems + JSONs de todos os testes comparativos |
| `scripts/modal_acestep_transcriber.py` | Criado | App Modal ACE-Step (A100-40GB, FA2, sem snapshot) |
| `scripts/modal_lyrics_aligner.py` | Existente, não commitado | Pipeline v1 (Demucs + Whisper). Precisa ser reescrito pra v2 |

## Commits desta sessão

Nenhum commit nesta sessão. Todos os arquivos são untracked ou existentes.

## Decisões tomadas

- **BS-Roformer > Demucs**: Melhoria significativa em isolamento vocal, especialmente transições entre artistas e rap denso. Modelo: `model_bs_roformer_ep_317_sdr_12.9755`.
- **Whisper 2-pass > single pass**: Segunda passada usa output do chunk anterior como prompt (224 tokens). Refinamento sem custo de pipeline adicional.
- **ACE-Step é complementar, não substituto**: Section tags úteis, texto inferior ao Whisper pra rap.
- **wav2vec2 MMS local pra timestamps**: Roda em CPU na VM, forced alignment é trivial dado texto correto.
- **Não reprocessar lrclib c/ timestamps**: 471 tracks curadas manualmente são melhores que qualquer pipeline.
- **Pipeline v2 roda nas 512 tracks sem cobertura lrclib**: Inclui instrumentais (auto-filtradas — stem vazio).

## Métricas

| Métrica | Valor |
|---------|-------|
| RTF Whisper+BS-Roformer (H100) | 0.092 (39s pra 428s de áudio) |
| RTF ACE-Step (A100-40GB, FA2) | 0.184 (79s pra 428s de áudio) |
| ACE-Step L4 | Inviável (>10min pra 7min de áudio) |
| Tracks pendentes pipeline v2 | 512 |
| Tracks cobertas lrclib timestamps | 471 |

## Pendências identificadas

1. **Reescrever `modal_lyrics_aligner.py` pra pipeline v2** (alta) — trocar Demucs por BS-Roformer, implementar Whisper 2-pass, filtrar 512 tracks sem lrclib
2. **Adicionar skip-if-exists no download de LRCs** (média) — evitar reprocessamento conforme biblioteca cresce
3. **Cachear pesos do ACE-Step em volume Modal** (baixa) — cold start mais rápido
4. **Investigar vLLM GPU snapshot VRAM** (baixa) — snapshot captura com 95% VRAM alocada, torna restore lento
5. **Copiar lyrics pra cmr-auto** (baixa) — pedido original, deferido até pipeline v2 completo
6. **BGE-M3 embeddings das lyrics** (baixa) — TEI local porta 8080, strip timestamps antes de embedar
7. **Diminuir concurrency do Whisper vLLM** (baixa) — engasgando levemente
