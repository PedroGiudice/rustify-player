# Self-review: rustify-player vs o mundo (pré-Reddit)

Data: 2026-07-05. Método: 16 agentes — 4 inventariaram o codebase, 5 varreram o
mercado, 1 destilou 6 claims de unicidade falsificáveis, 6 refutadores hostis
("comentarista bem-informado do r/musichoarder") tentaram derrubar cada uma com
busca séria. Este documento registra o que sobreviveu, o que morreu e quem matou.

## Veredito executivo

**"Não existe nada parecido" é falso como frase — e verdadeiro como produto.**
Cada peça isolada tem concorrente em algum lugar; a conjunção num único player
desktop nativo não tem. Para o Reddit isso significa: postar como *engineering
showcase* (r/rust, r/tauri) funciona; postar como *"experimentem meu player"*
(r/musichoarder, r/selfhosted) hoje seria um desastre — o app não é instalável
por terceiros (ver "Bloqueadores").

## As 6 claims e o destino de cada uma

### Sobreviveram (rare_combo — zero contraexemplo direto)

**1. Background generativo audio-reativo PERSISTENTE atrás da UI inteira.**
18 shapes × 5 renderers = 90 combos, FFT real capturada do monitor do sink via
PipeWire, tinta derivada da capa. O refutador procurou e não achou player que
rode isso atrás de biblioteca/busca/settings — ThemeSong (YouTube Music) monta
o canvas só na área do player (código verificado); AIMP skins põem spectrum
sobre a playlist; GLava/Wallpaper Engine são wallpaper, não UI de player.
*Este é o claim mais defensável do app — e o mais screenshotável.*

**2. Vector database como banco PRIMÁRIO da biblioteca.** Zero SQLite: metadata
como payloads Qdrant (sidecar ~34MB spawnado pelo app), vetor MERT 768d + vetor
de letra 1024d como named vectors no mesmo ponto. GitHub search "music player
qdrant" = 0 repositórios. AudioMuse-AI usa PostgreSQL+Voyager, bliss usa SQLite,
Plexamp guarda análise no SQLite do Plex. Ninguém fez do vector DB o banco.
*Defensável como decisão de arquitetura; interessa a dev, não a usuário.*

### Morreram (exists_elsewhere — o comentário "actually..." cola)

**3. Similaridade por embedding do sinal de áudio + comportamento.** Morto por
**AudioMuse-AI** (open-source, MusicNN/CLAP embeddings locais, instant mix,
integra Jellyfin/Navidrome — ~85% do combo) e **Plexamp Sonic Analysis**
(~95% funcional, closed-source, análise neural no servidor local do usuário
desde ~2020). Também: **LMS** (MusicNN local) e **Music Assistant** (2025-26,
análise 100% local). A distinção "MERT transformer vs MusicNN CNN" lê como
pedantismo de datasheet num thread. *Ainda é feature forte — só não é única.*

**4. Cadeia DSP de mastering embutida (LSP EQ×16 + Limiter + Bass + R128).**
Morto por **moOde** (CamillaDSP embutido com editor de pipeline), **Volumio
FusionDsp** (50 filtros PEQ) e **Strawberry** (EBU R128 per-track no playback).
O combo exato não existe, mas próximo o suficiente.

**5. Cor adaptativa da capa com WCAG garantido matematicamente.** Morto por
**Georgia-ReBORN** (theme foobar2000, 5.315 linhas de color system com
"WCAG 3.0/APCA contrast validation", código verificado) e
**material-color-utilities** (HCT garante contraste por construção — Symfonium
herda no Android). *A implementação nossa segue sendo boa engenharia; unicidade não.*

**6. Pipeline próprio de lyrics sincronizadas (BS-Roformer + wav2vec2).** Morto
pelo ecossistema **nomadkaraoke/python-lyrics-transcriber** (fetch multi-fonte,
Whisper, correção anti-alucinação via anchor sequences + LLM, LRC palavra a
palavra) e **UltraSinger**. E o nosso roda como scripts fora do app.

## Quem é quem no mapa competitivo (top overlap)

| Produto | Overlap | O que cobre |
|---|---|---|
| Plexamp | 9/10 | Sonic analysis local, visualizers, cor da capa — closed-source, Plex Pass |
| AudioMuse-AI | 8/10 | O análogo open-source da inteligência sônica |
| LMS (epoupon) | 8/10 | Embeddings MusicNN locais, radio mode, self-hosted |
| Material You | 8/10 | Contraste garantido por construção (HCT) |
| Symfonium | 7/10 | Tema dinâmico da capa (Android) |
| SoulSync / Explo | 7/10 | Loop ListenBrainz→slskd (o nosso discover.py existe lá fora) |
| Musicat | 6.5/10 | Player Tauri local mais próximo em produto |

## Bloqueadores para público (do inventário, sem piedade)

1. **IPs/hostnames pessoais hardcoded em repo público** — `lib_semantic_search`
   instancia `http://100.123.73.128:3939` direto (lib.rs:263); MERT default
   `extractlab.cormorant-alpha.ts.net:8448`. Higiene de segurança + primeiro
   comentário hostil do thread. Corrigir ANTES de qualquer post com link.
2. **Update exige `gh` CLI autenticado + jq + pkexec** — e o .deb declara
   `jq`/`gh` como depends. "Um music player que depende do GitHub CLI" vira piada.
3. **FLAC-only de ponta a ponta** (o GStreamer decodificaria o resto; o gate é
   nosso). **Linux-only por construção** (PipeWire hardcoded).
4. **Deps LV2 (lsp-plugins, calf) não declaradas no .deb** — instalação limpa =
   DSP silenciosamente ausente.
5. **Temas e lyrics não acompanham o app** — YAMLs só na cmr-auto; 252 LRCs
   gerados offline pro acervo pessoal; sem fetch LRCLIB no app.
6. **Metade do ecossistema vive fora do repo** (baixar_soulseek, temas, MERT
   service) — é setup pessoal, não produto. **Aquisição via Soulseek não é
   apresentável como feature.**
7. README stale (diz "vanilla JS", frontend é Solid há meses).
8. "Gapless" é auto-advance com gap real (sem about-to-finish).

## Estratégia de publicação

**Onde:** r/rust e r/tauri (showcase de engenharia), talvez r/unixporn (o
background + temas rendem screenshot). NÃO r/selfhosted / r/musichoarder por
enquanto — lá a pergunta é "how do I install" e a resposta hoje é "you don't".

**Pitch honesto (o que afirmar):**
- "Local music player where the library IS a vector database (Qdrant sidecar,
  no SQLite) and recommendations come from audio embeddings (MERT) of my own
  files" — dev-bait legítimo.
- "A generative, audio-reactive background that runs behind the ENTIRE UI
  (18 fields × 5 renderers), ink derived from album art" — o GIF carrega o post.
- Stack: Tauri 2 + Solid + GStreamer + Rust workspace. Linux-only, FLAC-only,
  alpha pessoal — dizer isso NO post desarma 80% dos comentários hostis.

**O que NÃO afirmar:** "nothing like this exists" (Plexamp/AudioMuse no primeiro
comentário), "mastering-grade DSP" (moOde), "WCAG-guaranteed adaptive colors as
a first" (Georgia-ReBORN).

**Pré-requisitos mínimos antes do post (1 sessão):** remover IPs hardcoded
(env/config), README atualizado com screenshots/GIF, disclaimer de escopo.
Opcional que muda o jogo: fetch LRCLIB no app + 2-3 temas bundled.

## Draft de post (esqueleto, EN)

> **I built a local-first music player where the library is a vector database**
>
> Rustify is a Tauri 2 + SolidJS + GStreamer player for my FLAC library. The
> unusual parts: there is no SQLite — track metadata lives as Qdrant payloads
> (34MB sidecar the app spawns), with MERT audio embeddings + lyric embeddings
> as named vectors on the same points, so "play similar" is a vector query over
> the sound itself. The whole UI runs on top of a persistent generative
> background — a scalar field (18 shapes) × painting strategy (5 renderers),
> driven by real FFT captured from the PipeWire sink monitor, inked with the
> album cover's dominant hue (WCAG-floored so it never goes invisible).
> Linux-only, FLAC-only, very much a personal alpha — sharing for the
> architecture discussion, not as a product.
> [GIF]

## Fontes

Journal completo dos 16 agentes:
`.claude/.../workflows/wf_1bacd322-936/journal.jsonl` (sessão c3dc9da2).
Produtos citados verificados com código-fonte quando indicado (Georgia-ReBORN,
ThemeSong) ou documentação oficial (Plexamp, AudioMuse-AI, moOde, LMS).
