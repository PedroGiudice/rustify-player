# Rustify Player — Cheatsheet

## Release e deploy

### Na VM (publicar nova versao)

```bash
./scripts/release.sh
```

Builda o .deb e publica na rolling release `dev` do GH (PedroGiudice/rustify-player).
Leva ~25s em 16 vCPU EPYC.

### Na cmr-auto (instalar ultima versao)

```bash
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb
```

## Debug de playback

### Rodar com logs

```bash
RUST_LOG=warn rustify-player 2>&1 | tee /tmp/rustify.log
```

Niveis uteis:
- `warn` — so xruns e erros (recomendado pra crackling debug)
- `info` — adiciona state changes, reconfiguracoes
- `debug` — verbose, tudo (sample rates, seeks, stream events)

Filtro por modulo:

```bash
RUST_LOG=audio_engine=debug,rustify_player=info rustify-player
```

### Contar xruns durante playback

```bash
grep -c "xrun" /tmp/rustify.log          # quantos eventos de xrun
grep "xrun" /tmp/rustify.log | head -20  # ver os logs
grep "xrun" /tmp/rustify.log | tail -20  # ultimos
```

### Filtros uteis no log

```bash
grep -E "xrun|negotiated|sample_rate|state.changed" /tmp/rustify.log
grep "pipewire" /tmp/rustify.log
grep "ERROR\|WARN" /tmp/rustify.log
```

## Dev local (VM)

### Compilacao

```bash
# Check rapido (sem binario)
cargo check --manifest-path src-tauri/Cargo.toml

# Check crate especifico
cargo check --manifest-path src-tauri/Cargo.toml -p audio-engine

# Format + lint
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -W clippy::all

# Tests
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml -p audio-engine
```

### Dev server (hot reload)

```bash
bun run tauri dev
```

### Build manual (se precisar)

```bash
bun run tauri build
```

### Examples dos crates

```bash
# Audio engine: tocar um arquivo
cargo run -p audio-engine --example play_file -- /path/to/track.flac

# Library indexer: escanear uma pasta
cargo run -p library-indexer --example scan_folder -- /path/to/music
```

## Git workflow

### Branch atual

Trabalhando em `main` (pipewire migration ja foi merged).

### Commit rapido

```bash
git add -u
git commit -m "fix(audio-engine): descricao curta"
```

Convencao: `<tipo>(<escopo>): <descricao>` em portugues.
Escopos: `audio-engine`, `library-indexer`, `frontend`, `embed`, `docs`, `chore`.

### Limpar branches mergeadas

```bash
git branch --merged main | grep -v main | xargs -r git branch -d
```

## Database queries (cmr-auto)

```bash
# Tracks com embedding failed
sqlite3 ~/.local/share/rustify-player/library.db \
  "SELECT path FROM tracks WHERE embedding_status='failed' LIMIT 10"

# Contagem por status
sqlite3 ~/.local/share/rustify-player/library.db \
  "SELECT embedding_status, COUNT(*) FROM tracks GROUP BY embedding_status"

# Todas as tracks de um album
sqlite3 ~/.local/share/rustify-player/library.db \
  "SELECT track_number, title FROM tracks WHERE album_title='NOME' ORDER BY track_number"
```

## EasyEffects

```bash
easyeffects -p                   # preset atual
easyeffects -l                   # listar presets
gsettings get com.github.wwmm.easyeffects.streamoutputs last-used-preset
```

## Pipewire debug

```bash
pw-cli info all | grep -A2 "rustify\|node.name"
pw-top                           # monitor em tempo real
wpctl status                     # overview
```

## Notas

- Porta 8000 e reservada pelo Tailscale Serve (extractor lab). Nao usar.
- Nao compilar localmente na cmr-auto — i5 8th gen leva minutos. Usar release.sh na VM.
- Nunca usar `Content-Encoding: zstd` no embed client — usar `X-Audio-Encoding: zstd`.
- `transformers==4.38.2` e PIN obrigatorio no rustify-embed. Versoes superiores quebram pesos do MERT.
