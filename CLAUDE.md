# Rustify Player — Claude Project Rules

## Release workflow (obrigatorio apos qualquer mudanca de codigo)

Sempre que eu terminar de aplicar mudancas que compilam e quero que o usuario
teste na cmr-auto, rodo:

```bash
./scripts/release.sh
```

Isso builda o .deb na VM (rapido — ~25s em 16 vCPU EPYC) e publica como rolling
release `dev` no GH. A cmr-auto puxa com:

```bash
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb
```

Nao compilar localmente na cmr-auto — i5 8th gen leva minutos. A VM leva
segundos. Release.sh e o unico caminho.

## Branch atual

`fix-playback-race-condition` — ativa ate merge em main.
