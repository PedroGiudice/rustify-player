# Retomada: Android — entregar UI mobile no S24 + base vetorial local (CMR-190)

## Contexto rápido

O Rustify Android v0 (tocar + registrar) está completo e provado: playback
Media3 com fila nativa, biblioteca por manifest (1746/1746), eventos com
proveniência e **sync E2E validado** (play_events do S24 chegam ao Qdrant da
cmr-auto via receptor tailscale no desktop 0.2.73; régua mostra `s24` no
breakdown por device). A UI nova (design do CEO no claude.design) foi
convertida pra Solid e está mergeada na main (`src/mobile/`, dispatcher por
UA em `src/main.tsx`), gates verdes.

**O que falta:** o APK com essa UI nunca chegou ao aparelho — a sessão
anterior fechou com o build rodando. O celular tem um APK com dist velho
(o CEO viu "UI idêntica"; causa: `bun run build` manual obrigatório +
`bun install` faltando pós-merge — ambos já corrigidos e documentados).
Depois da entrega, o tema da próxima sessão é **CMR-190** (base vetorial
local no mobile), começando pela pesquisa do Qdrant Edge.

## Arquivos principais

- `docs/contexto/14082026-android-v0-fechamento-ui-mobile.md` — contexto denso desta sessão
- `CLAUDE.md` seção "Android (v0...)" — build/install/debug canônico (LER antes de buildar)
- `src/mobile/` — UI Solid; `src/main.tsx` — dispatcher; `docs/android/ipc-contrato-v0.md` — contrato IPC
- `docs/design-refs/design_handoff_mobile/` — spec visual (inclui telas v1 ainda não implementadas)
- Linear CMR-190 — base vetorial mobile (arquitetura proposta + pesquisa Qdrant Edge)

## Próximos passos (por prioridade)

### 1. Entregar o APK com a UI nova no S24
**Onde:** VM (build) + cmr-auto (adb, celular via cabo USB).
**O que:** build fresco e install — rodar na ordem, sem pipe mascarando erro:
```bash
cd /home/opc/rustify-player && bun run build   # OBRIGATÓRIO (frontend embutido no .so)
ls dist/assets/ | grep MobileApp               # chunk presente = dist certo
cd src-tauri && cargo tauri android build --debug
APK=gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
stat -c '%y' $APK                              # mtime tem que ser AGORA
scp $APK cmr-auto@100.102.249.9:/tmp/ && ssh cmr-auto@100.102.249.9 'adb install -r /tmp/app-universal-debug.apk'
```
**Por que:** é a única pendência entre o trabalho mergeado e o CEO ver a UI.
**Verificar:** abrir o app no S24 → dock de 4 abas (Home/Search/Library/
Settings) no lugar da UI desktop. Smoke CDP (referência:
`smoke_audio.py` no scratchpad da sessão 13/08; `localabstract:
webview_devtools_remote_<pid>`, `suppress_origin=True`, tela via
`svc power stayon usb`). Screenshot pro CEO.

### 2. Smoke funcional da UI no aparelho
**Onde:** S24 via CDP/adb.
**O que:** biblioteca lista pastas; play por pasta seta fila com origin
`playlist`; mini player reflete estado; evento cai no journal
(`run-as dev.cmr.rustifyplayer tail files/play_events.jsonl`) e sincroniza
(contar `device_id=s24` no Qdrant: deve passar de 2).
**Por que:** a integração IPC foi escrita contra o contrato, nunca executada
em Android.
**Verificar:** `curl -s http://127.0.0.1:16333/collections/play_events/points/count -d '{"filter":{"must":[{"key":"device_id","match":{"value":"s24"}}]},"exact":true}' -H 'Content-Type: application/json'` (túnel: `ssh -f -N -L 16333:localhost:6333 cmr-auto@100.102.249.9`).

### 3. CMR-190 — base vetorial local (tema principal da sessão, decisão do CEO)
**Onde:** pesquisa primeiro; depois `scripts/android/export_manifest.py` +
`src-tauri/src/mobile_library.rs`.
**O que:** (a) **WebSearch: status do Qdrant Edge em 2026** (GA? Android/
NDK? licença?) — o CEO pediu isso explicitamente antes de qualquer decisão;
(b) decidir Edge vs brute-force (baseline: mert 768d × 1746 ≈ 5,4MB,
cosine top-K trivial em Rust puro); (c) desenhar o snapshot de gosto
derivado no desktop (o gap real das stations não é vetor, é sinal).
**Por que:** destrava similar-tracks/stations no aparelho sem violar a
decisão "sem processo sidecar".
**Verificar:** issue CMR-190 tem a arquitetura proposta e os números.

### 4. Oportunista: parear wireless adb (CEO presente com o aparelho)
**O que:** Depuração por Wi-Fi no S24 → `adb pair` da cmr-auto (ou da VM,
que tem platform-tools) → `adb connect <ip-tailscale-s24>`. CEO avisa que
despareia com frequência — se falhar 2x, ficar no cabo sem insistir.

## Restrições

- NÃO reabrir decisões: Media3 (não port do engine), sem Qdrant sidecar no
  aparelho, sync por união de conjuntos, receptor bind SÓ no IP tailscale.
- NÃO logar eventos pela UI (journal no service é a verdade).
- IDs de track são STRING no JS (u64 > 2^53).
- Compilar sempre na VM. Release desktop exige bump manual ANTES.

## Como verificar o ambiente

```bash
cd /home/opc/rustify-player && rtk proxy git status   # árvore limpa, main
npm run typecheck && npx vitest run 2>&1 | tail -2    # 293 pass
ssh cmr-auto@100.102.249.9 'adb devices'              # S24 presente (cabo)
curl -s -m 3 http://100.102.249.9:19878/sync/health   # {"ok":true} = receptor de pé
```
