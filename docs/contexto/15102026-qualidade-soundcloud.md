# Qualidade real do acervo: quantos "FLAC" são lossy por dentro (15/10/2026)

**Pergunta:** quantas faixas do acervo são MP3/AAC disfarçadas de FLAC, e de onde vêm.
**Ferramenta:** `scripts/curator/quality_audit.py` (testes: `test_quality_audit.py`).
**Dados brutos:** `docs/contexto/15102026-qualidade-auditoria.jsonl` (uma linha por faixa, 2.202 faixas,
medido na cmr-auto em 15/10, 45 min com `nice -n 19` e 2 processos).

## Método

Codificador lossy (MP3, AAC, Opus) joga fora tudo acima de um passa-baixa. O degrau sobrevive à conversão para
FLAC. O detector mede 3 janelas de 20 s (20%, 45% e 70% da faixa), L+R somados, espectro por quadro em dB
relativo aos 2-8 kHz do próprio quadro, quadros de silêncio fora, e procura o maior degrau acima de 10 kHz
(média de 500 Hz abaixo menos média de 500 Hz acima, com folga de 100 Hz) na MEDIANA e no PERCENTIL 10 dos
quadros. Degrau >= 20 dB conta.

Por que mediana e percentil 10, não a média: em master no talo (funk), o MP3 decodificado satura e os quadros
saturados espalham ruído largo acima do corte; a média apagava o degrau (um MP3 128 de funk passava como
lossless na 1ª versão). O LAME zera o que passa de 16 kHz nos quadros calmos até em 320 kbps, então o corte
NÃO revela o bitrate: as classes falam de evidência, não de kbps.

Classes: `sem_corte` (sem degrau, ou degrau >= 20,6 kHz = filtro do conversor); `lossy` (corte < 19,5 kHz);
`provavel_lossy` (19,5-20,6 kHz: MP3 320, Opus, AAC alto; raro: resampler); `hires_de_cd` (taxa > 48 kHz com
corte entre 20,6 e 24,5 kHz = upsample de CD); `lossy_declarado` (COMMENT com "lossy").

FLAC que o ffmpeg não decodifica (lixo antes do primeiro quadro, 37 faixas, 36 de um álbum do DJ Arana) é
lido pelo GStreamer, que resincroniza (mesmo caso do `phone_sync_encode.py`; o app toca essas faixas).

## Calibração (VM, arquivos de verdade conhecida)

| Conjunto | Resultado |
|---|---|
| 11 lossless conhecidos (Tidal fora do funk, rips de CD inclusive Californication, hi-res de jazz 96k) | 11/11 `sem_corte` |
| 16 encodes de fonte limpa (2 faixas eletrônicas da Tidal x MP3 128/192/256/320/V0, AAC 160/256, Opus 160) | 14/16 pegos; escapam MP3 V0 e AAC 256 (limite conhecido) |
| 3 MP3 declarados (`source: lossy mp3`) | 3/3 com corte |
| Maior degrau de lossless abaixo de 20,6 kHz | 14,7 dB (limiar 20) |

## Resultado (2.202 faixas)

| Classe | Faixas | % |
|---|---|---|
| sem corte | 2.010 | 91,3 |
| lossy (corte < 19,5 kHz) | 122 | 5,5 |
| provável lossy (19,5-20,6 kHz) | 39 | 1,8 |
| lossy declarado | 6 | 0,3 |
| hi-res de CD (upsample) | 25 | 1,1 |

Cortes concentrados em 15,5-16,5 kHz (91 faixas: MP3 128 / stream) e 20,0-20,5 kHz (29: MP3 320).

**Funk Brasileiro por origem** (377 faixas, 103 com corte = 27%):

| Origem | Faixas | Com corte | % |
|---|---|---|---|
| Soulseek e outras | 174 | 74 | 43 |
| Tidal | 137 | 20 | 15 |
| SoundCloud/Bandcamp desde 11/10 (sem marca de lossy) | 60 | 3 | 5 |
| MP3 declarado (Crate, `source: lossy mp3`) | 6 | 6 | - |

- A Tidal vende funk lossy por dentro: 16 "LOSSLESS" e 4 "HI_RES_LOSSLESS" (24 bit) do Funk Brasileiro têm corte de lossy
  (ex.: Dave Nunes "Socadinha", 24 bit, corte em 16 kHz). Fora do funk a Tidal sai limpa (Jazz hi-res 57/58).
- 53 faixas são 24 bit com corte de lossy (falso hi-res): 32 Soulseek, 14 Tidal, 6 nossas (MP3 do Crate), 1 Bandcamp.
- Das 6 MP3 "320" que entraram pelo Crate, **4 têm corte em 16 kHz**: MP3 128 regravado como 320. O filtro
  de entrada (`MIN_MP3_KBPS`, 300) lê o bitrate do arquivo e não percebe.
- Desde 11/10 entraram 91 faixas fora da Tidal (SoundCloud/Bandcamp, script e Crate; 90 medidas): 80 limpas, 6 MP3
  declaradas, 4 "originais" FLAC/WAV com corte (3 funk + 1 remix no Eletrofunk), todas 24 bit.
- "Humildes do SoundCloud" (21 faixas): 20 limpas, 1 com corte. O rip do lucida.to do DJ CARLOZS tem corte
  de 17 kHz (stream do SoundCloud); as outras 5 faixas com marca do lucida saem limpas.
- Hi-res de CD: 24, quase todas Soulseek (ex.: J. Cole "KOD" 96 kHz com corte em 21,9 kHz).

### Faixas novas (desde 11/10, fora da Tidal) com corte

| Classe | Corte kHz | Bits | Caminho |
|---|---|---|---|
| lossy | 15,3 | 24 | Eletrofunk/PinkPantheress/2025 - Fancy Some More?/17 - Stars (DJ Caio Prince & Adame DJ remix).flac |
| lossy_declarado | 20,1 | 24 | Funk Brasileiro/Adame DJ/Job/01 Job.flac |
| lossy | 16,1 | 24 | Funk Brasileiro/D.A.N.V, DJ Kingdom, VKKramer/A Baile, Vol. 1/09 Dança, Dança, Dança (feat. MC 2D).flac |
| lossy_declarado | 16,1 | 24 | Funk Brasileiro/DJ Arana/Festa do Pente Rala/01 Festa do Pente Rala.flac |
| lossy_declarado | 16,1 | 24 | Funk Brasileiro/DJ Arana/Um Cara Tranquilo/01 Um Cara Tranquilo.flac |
| lossy_declarado | 20,2 | 24 | Funk Brasileiro/DJ Blakes/Montagem Iraque - Netflix Que Nada/01 Montagem Iraque - Netflix Que Nada.flac |
| lossy_declarado | 16,1 | 24 | Funk Brasileiro/DJ Gui Marques/Mandelão MC Mr Bim (Gui Marques & Vitn MPC)/01 ….flac |
| lossy_declarado | 16,1 | 24 | Funk Brasileiro/DJ Rogerinho do Querô/Sequência do Vapo Vapo vs Brega Funk/01 ….flac |
| lossy | 16,1 | 24 | Funk Brasileiro/MAC10TA/Bruxaria do Beco da Morte/01 Bruxaria do Beco da Morte.flac |
| lossy | 15,9 | 24 | Funk Brasileiro/OO Rubinho/HARDFUNK/02 COMBAL.flac |

## Correção aplicada (commit 50caf3e)

`transcode.rs` `to_flac` e `normalize_release.py` gravavam MP3/AAC como FLAC 24 bit (o decodificador entrega
float e o encoder FLAC escolhia s32). Agora origem lossy sai em 16 bit com dither triangular; PCM mantém a
profundidade. As faixas já gravadas não foram tocadas.

## Consequências

- CMR-297 (troca por versão melhor) não pode comparar por profundidade de bits: um 24 bit da Tidal pode ser MP3
  por dentro e um 16 bit do Soulseek pode ser lossless de verdade. A comparação tem que usar a classe espectral.
- O caminho SoundCloud/Bandcamp é a melhor fonte de funk em qualidade (5% com corte, contra 15% na Tidal e 43%
  no Soulseek).

## Decisão do CEO (15/10/2026) e o que foi implementado

"Qualquer coisa menos que FLAC 16 bit/44,1 kHz não vale a pena." Correções registradas na conversa: a
etiqueta mente (o piso se mede pelo conteúdo), e MP3 320 não é pior de ouvido em teste cego (excluir é
higiene do acervo, não audição). Regra: só lossless de verdade, nas quatro portas; nada do acervo atual é
apagado, a qualidade real é marcada e aparece no player.

- Crate (Soulseek e SoundCloud): MP3 recusado no card e no worker; FLAC com corte recusado no `stage_file`.
- Scripts: `normalize_release.py` sem `--allow-lossy`, mede cada faixa; `tidal_mix_dl.py` mede antes do
  rename final, cache `recusadas.json`, recusada não é falha; fila com `--with numpy` (reiniciada 15/10).
- Acervo: `quality_class`/`quality_cutoff_hz` no Qdrant (2.202 faixas semeadas da auditoria); barra e Now
  Playing mostram "Lossy 16,1 kHz" / "CD em 24/96".
- Detector em Rust (`spectral.rs`) com paridade travada por fixture: 51/51 referências iguais ao Python.
