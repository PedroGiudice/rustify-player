# Rustify Player — Claude Project Rules

## Compilacao e release

**Nao compilar ate ter certeza de que nao fara mais edicoes no momento.**
Acumule todas as mudancas pendentes (backend + frontend) e compile/release
uma unica vez no final. Compilacoes intermediarias poluem o contexto e
desperdicam tokens. `cargo check` pontual e ok pra validar sintaxe critica;
`release.sh` so quando for entregar pro usuario testar.

```bash
# Validacao rapida (sem binario, sem bundle)
cargo check --manifest-path src-tauri/Cargo.toml

# Release completo (build + .deb + publish GH)
./scripts/release.sh
```

A cmr-auto puxa com:

```bash
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb
```

Nao compilar localmente na cmr-auto — i5 8th gen leva minutos. A VM leva
segundos. Release.sh e o unico caminho.

## Branch atual

`fix-playback-race-condition` — ativa ate merge em main.
