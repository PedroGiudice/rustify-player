# Retomada: qualidade do SoundCloud no Crate (e o que ficou da sessão de 14-15/10)

<session_metadata>
branch: feat/crate-soundcloud
last_commit: b65bf10 (+ docs de retomada)
releases: 0.2.91 instalada na cmr-auto; 0.2.92 publicada, não instalada
servicos_vm: tmux telemetria (fila Tidal, subir com uv run --with tidalapi --with mutagen), rustify-lyrics.timer 08:30, rustify-regua.timer 09:00
issues: CMR-123 (autoplay), CMR-297, CMR-299, CMR-300, CMR-301, CMR-302
</session_metadata>

## Contexto rápido

Rustify Player (Tauri 2.11 + Rust + SolidJS; app na cmr-auto, dev na VM, S24). Na sessão de 14-15/10 saíram:
busca por texto da Tidal com prévia (0.2.91), seleção múltipla nas listas (0.2.91), separação do rap brasileiro
(187 faixas) e do funk (68) com auditoria sem perdas, a medição que mostrou que o vetor de som não explica os
pulos do autoplay, e a familiaridade no autoplay (0.2.92, publicada e ainda não instalada).

O foco agora, pedido pelo CEO, é o **SoundCloud no Crate, especialmente qualidade**. O caminho existe desde a
0.2.87 (fase 1: busca, probe, download do ORIGINAL logado, conversão para FLAC, tags, capa). O levantamento de
15/10 achou problemas concretos de qualidade: faixas MP3 gravadas como FLAC 24 bit (parecem hi-res), rips de
stream de terceiros (lucida.to) no acervo, e um filtro de entrada que confia na extensão do arquivo.

Leia antes de agir: `docs/contexto/15102026-tidal-busca-selecao-generos-autoplay.md` (seção "Achado para a
próxima sessão"), a spec `docs/superpowers/specs/2026-10-12-crate-fontes-soundcloud-bandcamp-design.md`, e no
`CLAUDE.md` "Crate" > "Fontes por job (fase 1, v0.2.87)" e "Aquisicao Bandcamp + SoundCloud".

## Arquivos principais

- `src-tauri/src/slsk/mod.rs` -- `probe_verdict` (política de formato), commands `crate_sc_*`
- `src-tauri/src/slsk/sc_worker.rs` -- worker do SoundCloud (download do original, `MIN_MP3_KBPS`)
- `src-tauri/crates/library-indexer/src/transcode.rs` -- `probe_media`, `to_flac` (sem `-sample_fmt`)
- `src-tauri/crates/library-indexer/src/tagwrite.rs` -- COMMENT `source: lossy mp3`
- `src-tauri/crates/soundcloud-client/` -- API v2 (downloadable, has_downloads_left, purchase_url)
- `scripts/curator/normalize_release.py` -- caminho por script (`--allow-lossy`)
- `docs/superpowers/plans/2026-10-12-crate-soundcloud-fase1.md` -- plano da fase 1 (concluída)

## Próximos passos (por prioridade)

### 1. Medir a qualidade real do que entra pelo SoundCloud (antes de mudar código)
**Onde:** script novo `scripts/curator/quality_audit.py`, rodando na cmr-auto (ffmpeg lá) ou na VM sobre cópias.
**O que:** para cada FLAC do acervo, (a) bit depth/sample rate declarados, (b) COMMENT de origem, (c) corte
espectral: frequência acima da qual a energia cai (MP3 320 corta ~19-20 kHz, 128 ~16 kHz, lossless real vai
até ~22 kHz). Classificar: lossless provável / lossy declarado / **lossy disfarçado** (sem marca, com corte de
MP3). Começar por `Funk Brasileiro` e pelas faixas com COMMENT de soundcloud/lucida.to/bandcamp.
**Por que:** o CEO quer qualidade; hoje não sabemos quantas faixas "FLAC" do acervo são MP3 por dentro. Sem
número, qualquer política é chute.
**Verificar:** relatório com contagens por classe e a lista dos disfarçados; validar o detector em 3 arquivos
de referência conhecidos (um Tidal hi-res, um `source: lossy mp3`, um MP3 128 convertido).

### 2. Parar de gravar MP3 como FLAC 24 bit
**Onde:** `transcode.rs` `to_flac` (e o caminho equivalente do `normalize_release.py`).
**O que:** quando a origem é lossy, gravar FLAC 16 bit (`-sample_fmt s16`, com dither padrão do ffmpeg) e manter
`source: lossy mp3`; origem lossless mantém a profundidade original. Decidir com o CEO se as 6 faixas já
gravadas em 24 bit são regravadas (mudar o arquivo muda mtime, não o id; o reingest preserva letra/vetores).
**Por que:** o arquivo 24 bit finge hi-res e engana o selo Hi-Res e a futura troca por qualidade (CMR-297).
**Verificar:** teste em `transcode.rs` com MP3 sintético -> FLAC sai com `bits_per_raw_sample` 16.

### 3. Checagem espectral no probe do SoundCloud (decisão do CEO antes)
**Onde:** `sc_worker.rs` depois do download, antes do staging; reaproveitar o detector do passo 1.
**O que:** "original" WAV/FLAC com corte de MP3 entra marcado como `source: lossy (corte X kHz)` ou é recusado.
Levar ao CEO a escolha (marcar x recusar) com os números do passo 1.
**Por que:** produtor às vezes exporta WAV a partir de MP3; hoje entra como lossless sem checagem.
**Verificar:** QA no app pela ponte com 1 faixa real do SoundCloud.

### 4. Pendências da sessão anterior (quando o CEO puder)
1. Conferir a 0.2.92 instalada: `dpkg -l rustify-player` na cmr-auto = 0.2.92; no log do app, a familiaridade
   aqueceu (grep `familiar`), sem travamento ao clicar logo após abrir.
2. S24 por USB na cmr-auto: encode + `scripts/android/export_manifest.py --deploy` + `phone_push_retry.sh`;
   investigar os 80 pulos de 0 ms (faixas que não tocam no celular?).
3. Correções do CEO nas playlists: comparar com `docs/contexto/14102026-{rap-br,funk}-lote-executado.json`.

## Como verificar

```bash
cd /home/opc/rustify-player && git status --short && git log --oneline -3
```
```bash
ssh cmr-auto@100.102.249.9 'dpkg -l rustify-player | tail -1; ps -o etime=,cmd= -C rustify-player | head -1; ss -tlnp | grep rustify'
```
```bash
curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:16333/collections/rustify_tracks || ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
```
```bash
cd /home/opc/rustify-player && npm run typecheck && cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | grep "^test result"
```

## Restrições

- NUNCA mover faixa à mão (`mv`): só pelo `lib_move_tracks` (ponte: lotes de até 40 faixas por chamada; a
  chamada da ponte tem timeout curto e o laço segue rodando no app se estourar: não disparar de novo, conferir
  pelo log). Auditar com `move_audit.py`.
- `pkill -f`/`pgrep -f` via shell: o padrão casa com a própria linha de comando; checar por pid.
- Segredos (`~/.secrets/*`, inclusive `soundcloud-oauth.txt`) nunca em log, chat ou commit.
- Subagentes com `model` e `effort` explícitos e "REGRA ZERO: você executa, não delega"; worktrees partem de
  commit antigo: começar com `/usr/bin/git reset --hard feat/crate-soundcloud` e trazer por cherry-pick.
- Release: bump antes, uma release por leva, `release.sh` agora roda `test_autoplay_regua.py` antes do build.
- `docs/metrics/regua-*` são do timer: não commitar à mão.
