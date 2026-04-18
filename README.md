# rustify-player

Player de musica desktop em Tauri 2.x com frontend HTML/CSS/JS puro.

## Stack

- **Backend:** Rust (Tauri 2)
- **Frontend:** HTML + CSS + JS vanilla (sem framework)
- **Package manager:** bun
- **Identifier:** `dev.cmr.rustifyplayer`

## Estrutura

```
rustify-player/
├── src/              # Frontend (HTML/CSS/JS puro)
│   ├── index.html
│   ├── main.js
│   ├── styles.css
│   └── assets/
├── src-tauri/        # Backend Rust
│   ├── src/
│   ├── Cargo.toml
│   └── tauri.conf.json
└── package.json
```

## Desenvolvimento

```bash
bun install           # Instala deps JS
bun run tauri dev     # Roda app em modo dev
bun run tauri build   # Build de producao
```

## Requisitos

- Rust stable (`rustup`)
- Bun
- Dependencias de sistema Tauri (webkit2gtk, libayatana-appindicator3-dev, etc.)
