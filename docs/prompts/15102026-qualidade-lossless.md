# Retomada: regra "só lossless" (0.2.93) e o que vem depois

<session_metadata>
branch: feat/crate-soundcloud
releases: 0.2.93 publicada (inclui a 0.2.92); cmr-auto em 0.2.91 até o dpkg -i do CEO
servicos_vm: tmux telemetria (fila Tidal; subir com uv run --with tidalapi --with mutagen --with numpy), rustify-lyrics.timer 08:30, rustify-regua.timer 09:00
issues: CMR-297 (troca por versão melhor), CMR-313 (decisão só lossless), CMR-123 (autoplay)
</session_metadata>

## Contexto rápido

Em 15/10 a auditoria espectral mostrou 7,6% do acervo com corte de lossy (funk: Soulseek 43%, Tidal 15%,
SoundCloud/Bandcamp 5%). O CEO decidiu: só entra lossless de verdade, 16/44 ou melhor, medido pelo conteúdo.
A 0.2.93 aplica isso no Crate (Soulseek e SoundCloud), os scripts aplicam na Tidal e no Bandcamp/SoundCloud
por script, e o acervo foi marcado (nada apagado): a barra do player mostra "Lossy 16,1 kHz" no lugar do
"24/44". Leia antes: `CLAUDE.md` seção "Qualidade real do acervo" e
`docs/contexto/15102026-qualidade-soundcloud.md`.

## Próximos passos (por prioridade)

1. **QA da 0.2.93 com o CEO** (depois do `dpkg -i`): barra em "Socadinha" (Dave Nunes) = "Lossy 16,1 kHz"
   com ponto âmbar; "KOD" (J. Cole) = "CD em 24/96"; Racionais "Vida Loka, Pt. 2" = "FLAC 16/44". Crate:
   MP3 do SoundCloud mostra "não entra (só lossless)". No log do app: `quality backfill: nothing to do`
   (o acervo foi semeado) e a familiaridade da 0.2.92 aquecendo.
2. **CMR-297 com a classe espectral**: a troca por versão melhor compara `quality_class`, não `bit_depth`.
   Candidatas: as 167 faixas com corte (lista no `.jsonl` da auditoria), buscando versão limpa na Tidal (fora
   do funk ela sai limpa) ou no Soulseek ([Trocar fonte]).
3. **S24**: rótulo de qualidade no player mobile (o manifest precisa exportar `quality_class`).
4. Pendências antigas: S24 por USB (manifest de 11/09), correções do CEO nas playlists, CMR-301.

## Restrições

- As duas cópias do detector (`quality_audit.py`, `spectral.rs`) só mudam juntas; a fixture
  `scripts/curator/fixtures/spectral_cliffs.json` é regenerada pelo Python e lida pelos dois testes.
- Nunca apagar faixa do acervo por qualidade sem ordem do CEO.
- Fila da Tidal sem `--with numpy` = baixador cai no início (de propósito).
