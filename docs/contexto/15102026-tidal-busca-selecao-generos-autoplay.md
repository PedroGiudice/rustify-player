# Contexto: busca da Tidal, seleção múltipla, separação de gêneros, vetor de som e familiaridade no autoplay

**Data:** 2026-10-14 a 2026-10-15
**Sessão:** branch `feat/crate-soundcloud` (continuação de `docs/contexto/13102026-tidal-fila-mover-funk.md`)
**Duração:** ~26 h de relógio, 15 subagentes (implementadores, revisores, analistas), 37 commits (`769f41b..b65bf10`)

Baseline não repetido aqui: `CLAUDE.md` (seções "Aquisicao Tidal" > "Fila: como subir", "Crate" > "Busca por
texto na aba Tidal", "Mover para playlist (CMR-298)" > auditoria e seleção múltipla, "Motor de inteligencia" >
vetor de som, forense e familiaridade).

---

## O que foi feito

### 1. QA do mover (0.2.90) e auditoria externa
- CEO testou o mover (Hilight Tribe "Wind Raker", Trance -> Ambient -> Trance): voltou com mesmo id, `mert`,
  like/vibe e 23 plays. Aprovado.
- `scripts/curator/move_audit.py` (`snapshot` antes, `verify` depois; exit != 0 se falhar). Conta só
  `track_id` inteiro: há 11 eventos legados (`search_click`/`queue_add`, sem `device_id`) com `track_id` em
  texto que o mover não reaponta e que geraram falso alarme no lote do rap (8b5464b).

### 2. Separação de gêneros executada (CMR-299, CMR-300)
- **Rap & Trap Brasileiro** (decisão do CEO: uma pasta só, rap gringo fica em `Rap & Hip-Hop`). Proposta por
  idioma da letra + país no MusicBrainz, decidida por ARTISTA (a 1ª versão por faixa partia Orochi/teto/Matuê).
  CEO revisou os casos sem sinal: "todos vão menos Look Alive". **187 faixas movidas** (app 0.2.90, ~15 s),
  auditoria 187/187. Registro: `docs/contexto/14102026-rap-br-lote-executado.json`.
- **Funk**: proposta por nome (bruxaria = Funk Brasileiro), confiança média+: Eletrofunk 40, Techfunk 12, Mega
  Funk 10, Eletrônica 3, MPB 1, Rap & Trap Brasileiro 2 (Drae Da Skimask, VEIGH). **68 movidas** (app 0.2.91),
  auditoria 68/68. Ficaram 374 em Funk Brasileiro (inclui as 40 linhas de confiança baixa). Registro:
  `docs/contexto/14102026-funk-lote-executado.json`.
- Chave para comparar com as correções do CEO: caminho relativo SEM a pasta de 1º nível.
- `funk_split_plan.py` generalizado (`--src`, linhas `file` > `album_dir` > `artist_dir`).

### 3. Vetor de som (CMR-302)
- Classificação do funk por vizinhança MERT falhou (35% leave-one-artist-out). Causa medida
  (`mert_layer_probe.py`, 581 faixas, 13 camadas, fidelidade da camada 12 vs Qdrant mediana 0,9996): o
  container devolve a ÚLTIMA camada (pior para estilo: playlists 0,457 vs camada 6 0,620) e a janela é 15-45 s
  (`decode_flac` para em 60 s). Subgênero do funk não separa em camada nenhuma.
- Teste offline nas escolhas reais do autoplay (`mert_autoplay_eval.py`, 2199 faixas, ~1 h 47): desde a
  v0.2.75 o vetor do app prevê aceite como chute (AUC 0,520); camada 7 + janela central 0,587, IC sobreposto
  (63 aceites). **Veredito: app não muda.** Vetores guardados em
  `~/.local/share/rustify-curator/mert-layers-20261014/` (VM).

### 4. Forense do autoplay e familiaridade (CMR-123, 0.2.92)
- Forense (`scripts/metrics/autoplay_forense.py`): desde a v0.2.75, 806 escolhas, 92% de pulo. Separa aceite
  de pulo: vezes ouvida até o fim (AUC 0,72), like (72% x 94% de pulo), mesma playlist (fraco). Não separa:
  som, energia/valência, duração, aparelho, repetição. 77% dos pulos em até 5 s (rajadas).
- 0.2.92: familiaridade (`library-indexer/src/familiarity.rs`), mistura 2:1 conhecida/descoberta
  (`autoplay_mix`), filtro de nunca-termina; régua com linhas "sem pulos de até 5 s" e "desde a v0.2.92".
  Simulação previa pulo ~87% (de 92%). Revisão Opus pediu: varredura fora do lock (travava UI), dedup por id
  do ponto (replay do S24), nunca-termina só com `listen_pct < 0.5`. Tudo corrigido.

### 5. Busca por texto da Tidal com prévia (0.2.91)
- Spec `docs/superpowers/specs/2026-10-14-crate-tidal-busca-design.md`. Fila da VM ganhou `busca`, `artista`,
  `previa`, POST com `faixas` (máx. 200), `reenviar`; baixador `--ids`. Tela em `src/views/crate/TidalTab.tsx`.
  Medido: busca 295 ms (0,75 s pela tailnet), artista 541 ms, prévia de rádio 188 ms.
- Revisão achou 3 médios (lock sem timeout, teto de 200 invisível, "no acervo" com falso positivo de remix/ao
  vivo): corrigidos. A chave "já no acervo" tem duas cópias que precisam ficar iguais (`title_key` no
  baixador, `titleKey` na tela).
- A fila precisa subir com `uv run --with tidalapi --with mutagen` (reiniciada em 14/10; o tmux `telemetria`
  foi recriado como zsh porque Ctrl+C na sessão antiga a matou).

### 6. Seleção múltipla (0.2.91)
- Ctrl/Shift+clique, Ctrl+A, Esc, Shift+Espaço; barra Mover / Tocar a seguir / Adicionar à fila. Revisão
  achou seleção invisível sobrevivendo à troca de aba (podia mover o acervo inteiro sem ver) e gapless
  desalinhado no "Tocar a seguir": corrigidos.

## Estado das versões

| Versão | O que traz | Estado |
|---|---|---|
| 0.2.91 | busca Tidal + seleção múltipla | instalada na cmr-auto (em uso) |
| 0.2.92 | familiaridade no autoplay | **publicada, NÃO instalada** (cmr-auto em 0.2.91 em 15/10) |
| S24 | nada desta sessão | manifest de 11/09; lotes de rap/funk não sincronizados |

## Decisões tomadas

- **Rap brasileiro = uma pasta** (`Rap & Trap Brasileiro`), decidido por artista, idioma + país. Descartado:
  separar trap de rap (CEO), decidir por faixa (partia artistas), usar o vetor de som (não separa estilo).
- **Funk executado pela proposta por nome**; as correções do CEO no uso viram rótulos. Descartado: médias de
  embeddings (medido: nenhuma camada separa subgênero). Próximo sinal candidato: ritmo/BPM.
- **Vetor do rádio não muda** (teste offline sem diferença clara). Descartado: reprocessar o acervo na camada 7.
- **Busca da Tidal pela API (tidalapi) na fila da VM.** Descartado: Playwright (lento, frágil, risco de conta,
  mesmos dados).
- **Familiaridade só no desktop primeiro**; S24 depois. Publicada mesmo com simulação modesta (~87%) porque o
  risco é baixo e a régua mede.
- **CMR-301** (faixa inserida à mão em fila de rádio vira `autoplay`) ficou fora da 0.2.91.

## Métricas

| Métrica | Valor |
|---|---|
| Faixas movidas com auditoria | 255 (rap 187 + funk 68), 0 perdas |
| Pulo do autoplay desde v0.2.75 | 92% (806 escolhas, 21 sessões); sem pulos <= 5 s: 72% |
| AUC vezes ouvida até o fim -> aceite | 0,72 (0,79 sem 5 sessões dominantes) |
| AUC vetor do app semente->faixa | 0,520 |
| Familiaridade: montagem do índice | 119 ms (10.273 eventos), caminho quente ~0,1 ms |
| Gates finais | vitest 1057, cargo app 287, library-indexer 263, régua 7 |

## Achado para a próxima sessão: qualidade do SoundCloud (levantado em 15/10, cmr-auto)

- 6 faixas com COMMENT `source: lossy mp3` estão gravadas como **FLAC 24 bit** (44,1/48 kHz): DJ Arana (2),
  DJ Rogerinho do Querô, DJ Gui Marques, DJ Blakes, Adame DJ, todas em `Funk Brasileiro`. Causa provável:
  `library-indexer/src/transcode.rs` `to_flac` não fixa `-sample_fmt`; o decoder MP3 sai em float e o encoder
  FLAC escolhe s32 (24 bit). O arquivo parece hi-res sem ser, e qualquer lógica que compare bit depth (selo
  Hi-Res, CMR-297) o trata como melhor que um 16 bit lossless real.
- Arquivos de terceiros com cara de rip de stream: "downloaded from lucida.to: https://soundcloud.com/djcarlozs/..."
  (DJ CARLOZS), e o álbum `Funk Brasileiro/Humildes/2023 - HUMILDES DO SOUNDCLOUD VOL. 2` (18 faixas, 16/44,1,
  origem desconhecida).
- `probe_verdict` (`src-tauri/src/slsk/mod.rs`) decide pelo formato/extensão e kbps estimado: WAV/FLAC/AIFF
  sempre entram. Um "original" WAV que o produtor exportou de um MP3 entra como lossless sem checagem.

## Pendências

1. **Qualidade do SoundCloud** (alta, foco pedido pelo CEO) -- ver prompt de retomada.
2. **CEO instalar 0.2.92** (alta) -- depois conferir no log que a familiaridade aqueceu e o tempo.
3. **S24** (alta, depende do CEO ligar por USB): encode + `export_manifest.py --deploy` + push; conferir os 80
   pulos de 0 ms (suspeita: faixas que não tocam no celular).
4. **Correções do CEO nas playlists** (média, no ritmo dele) -- comparar com os registros dos lotes.
5. **Familiaridade no S24** (média) -- motor próprio em `mobile_intel.rs`.
6. **Régua em 2-3 semanas** (média) -- linha "desde a v0.2.92"; se perto de 87%, propor gesto de "mudar a vibe".
7. **CMR-301** (média), **CMR-297** (média; depende de resolver o 24 bit falso), **tabela de apelidos old_id ->
   new_id** (média), **CMR-296** (média).
