# Retomada: Pipeline de Lyrics v2 — Integração BS-Roformer + Whisper 2-pass

## Contexto rápido

Sessão anterior avaliou separadores vocais (Demucs, BS-Roformer, MDX-Net) e transcritores (Whisper, SenseVoice, ACE-Step) para melhorar a qualidade das lyrics geradas automaticamente. Resultado: **BS-Roformer substitui Demucs** na separação vocal, e **Whisper faz 2 passadas** (segunda usa output do chunk anterior como prompt de 224 tokens) pra refinar transcrição. Forced alignment via wav2vec2 MMS roda local na VM em CPU.

Pipeline v1 (Demucs + Whisper single-pass) gerou 922 LRCs armazenados em `data/lyrics-whisper/`. Desses, 471 tracks já têm lyrics curadas do lrclib.net com timestamps e não precisam ser reprocessadas. **512 tracks precisam do pipeline v2.**

O script `scripts/modal_lyrics_aligner.py` contém o pipeline v1 e precisa ser reescrito para v2.

## Arquivos principais

- `scripts/modal_lyrics_aligner.py` — pipeline v1, precisa ser reescrito (BS-Roformer + Whisper 2-pass)
- `scripts/modal_acestep_transcriber.py` — app Modal ACE-Step, funcional mas complementar (não é o transcritor primário)
- `data/lyrics/` — 574 LRCs lrclib.net (471 c/ timestamps = intocáveis, 102 plain text = pendentes)
- `data/lyrics-whisper/` — 922 LRCs Whisper v1
- `data/separation-test/` — todos os testes comparativos (stems, JSONs)
- `data/lyrics/Black_FridayII_real_lyrics.txt` — ground truth Genius (track 187)
- `docs/contexto/29042026-lyrics-pipeline-v2.md` — contexto detalhado desta sessão

## Próximos passos (por prioridade)

### 1. Reescrever pipeline v2 em `modal_lyrics_aligner.py`

**Onde:** `scripts/modal_lyrics_aligner.py`, classes `DemucsWorker` e `LyricsAligner`
**O que:**
- Trocar Demucs por BS-Roformer (`model_bs_roformer_ep_317_sdr_12.9755`) na separação vocal
- No `_do_transcribe` (linha ~501), implementar 2-pass: primeira passada normal, segunda passada envia output do chunk N-1 como `prompt` no POST data (campo suportado pelo vLLM)
- Aceitar lista de IDs a processar (as 512 sem lrclib timestamps)
- Adicionar skip-if-exists pra não reprocessar

**Por que:** Pipeline v1 usa Demucs (inferior) e single-pass Whisper (mais erros em rap denso)
**Verificar:** Rodar na track 187, comparar output com `data/separation-test/whisper_bs-roformer.json` e ground truth

### 2. Gerar lista das 512 tracks pendentes

**Onde:** Arquivo CSV ou lista de IDs
**O que:** Cruzar IDs do DB (`~/.local/share/rustify-player/library.db` na cmr-auto, 983 tracks) com IDs em `data/lyrics/` que têm timestamps. Lista já foi gerada em `/tmp/needs_pipeline.txt` mas é volátil.
**Por que:** Pipeline v2 roda só nas pendentes, não nas 471 já cobertas pelo lrclib
**Verificar:** `wc -l` = 512

### 3. Rodar pipeline v2 nas 512 tracks

**Onde:** Modal, volume `rustify-lyrics-data`
**O que:** Deploy e execução batch
**Por que:** Gerar lyrics de qualidade pra toda a biblioteca
**Verificar:** 512 novos LRCs em `data/lyrics-whisper/`, spot-check em tracks de rap

### 4. Copiar lyrics pra cmr-auto

**Onde:** `data/lyrics/` e `data/lyrics-whisper/` → cmr-auto
**O que:** rsync ou tar|ssh (preferir tar|ssh pra bulk, ref: memória `feedback_bulk_transfer.md`)
**Por que:** Pedido original do usuário
**Verificar:** Contagem de arquivos na cmr-auto

## Referências técnicas

- **BS-Roformer**: pacote `audio-separator`, modelo `model_bs_roformer_ep_317_sdr_12.9755`. Testado em `/tmp/audio-sep-venv/`.
- **Whisper prompt**: campo `prompt` no POST `/v1/audio/transcriptions`. Max 224 tokens. Guia: https://developers.openai.com/cookbook/examples/whisper_prompting_guide
- **wav2vec2 MMS**: `torchaudio.pipelines.MMS_FA`, CPU, ~300MB. Já no pipeline v1.
- **vLLM Whisper**: `openai/whisper-large-v3`, H100, gpu_memory_utilization=0.95. Snapshot via sleep/wake.
- **Decisão VRAM snapshot**: gpu_memory_utilization=0.95 durante snapshot torna cold start lento. Investigar redução.

## Como verificar

```bash
# Pipeline v1 ainda funcional
python3 -c "import modal; s = modal.Cls.from_name('rustify-lyrics-aligner', 'LyricsAligner')(); print('OK')"

# ACE-Step funcional
python3 -c "import modal; s = modal.Cls.from_name('rustify-acestep-transcriber', 'Transcriber')(); print('OK')"

# Dados locais
ls data/lyrics-whisper/ | wc -l    # 922
ls data/lyrics/*.lrc | wc -l      # 574
ls data/separation-test/           # stems + JSONs comparativos
```

<session_metadata>
branch: main
last_commit: 81d7048
pending_pipeline_tracks: 512
lrclib_timestamped: 471
whisper_v1_lrcs: 922
total_tracks: 983
</session_metadata>
