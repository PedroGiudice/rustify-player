# Auto-Update Server (Manifest na VM) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar a fonte-de-verdade do update checker do GitHub Releases API para um `manifest.json` servido pela VM (`http://100.123.73.128:8090/rustify/manifest.json`), publicado pelo `release.sh`, com banner de update visível no header do app.

**Architecture:** Opção B (híbrida): VM serve só o manifest JSON (~200 bytes), o `.deb` continua hospedado nos GitHub Releases (storage robusto, sem custo). `release.sh` gera o manifest local e copia pra `/var/www/updates/rustify/` (mesma infra já usada pelo app `proatt`). `rustify-update.sh` (já invocado por `check_for_update`/`install_update` Rust commands) passa a fazer `curl` no manifest VM e usar o `url` indicado pra download. UI ganha um banner Solid no topo do shell que faz polling no startup + 1x/hora.

**Tech Stack:** bash + jq + curl + nginx (server-side, já configurado), Rust Tauri 2.x (cliente preservado), Solid 1.9 + vanilla CSS (banner).

---

## File Structure

**Cria:**
- `/var/www/updates/rustify/manifest.json` (server, gerado pelo release.sh)
- `src/components/UpdateBanner.tsx` (banner Solid)
- `src/components/UpdateBanner.test.tsx` (testes Vitest)
- `src/store/update.ts` (signal global + polling)
- `src/store/update.test.ts` (testes do store)

**Modifica:**
- `scripts/release.sh` — adicionar geração + publish de manifest.json
- `scripts/rustify-update.sh` — substituir `gh release view` por `curl` no manifest VM
- `src/App.tsx` — montar `<UpdateBanner/>` + iniciar polling no startup
- `src/styles/extractor-lab.css` — estilos do banner
- `src/tauri.ts` — sem mudança (API preservada)

**Preserva (não mexer):**
- `src-tauri/src/lib.rs` `check_for_update`/`install_update`/`restart_app` — API estável
- Cargo deps — não preciso adicionar reqwest (script bash faz curl)

---

## Schema do Manifest

```json
{
  "schema_version": 1,
  "version": "0.2.26",
  "commit": "664a04b",
  "channel": "dev",
  "url": "https://github.com/PedroGiudice/rustify-player/releases/download/dev/rustify-player_0.2.26_amd64.deb",
  "sha256": "deadbeefcafe...",
  "size_bytes": 47185920,
  "published_at": "2026-05-17T18:30:00Z",
  "notes": "Glow nos ativos + EQ spectrum overlay",
  "min_version": null
}
```

**Decisões de schema:**
- `schema_version` permite evolução sem quebrar clientes antigos
- `channel` futuro suporta `dev`/`stable`/`canary` (por enquanto só `dev`)
- `url` aponta direto pro GH (não precisa proxy)
- `sha256` opcional no script atual (pkexec dpkg -i confia no GH), mas presente pra evolução
- `min_version`/`null` reservado pra forçar update mandatório

---

## Task 1: Adicionar geração de manifest.json no release.sh

**Files:**
- Modify: `scripts/release.sh:50-58` (final do script, depois do `gh release` succeed)

- [ ] **Step 1: Escrever as funções e o publish step**

Adicionar **antes da linha final `echo "[release] done"`** (linha ~56):

```bash
# ── Manifest pra VM auto-update ──────────────────────────────────────────────
# Geramos um JSON enxuto na VM (/var/www/updates/rustify/manifest.json) que o
# rustify-update.sh consulta pra saber se ha versao nova. O .deb continua
# hospedado nos GH Releases — o manifest so aponta pra URL do asset.
echo "[release] publishing manifest"

MANIFEST_DIR="/var/www/updates/rustify"
MANIFEST_PATH="${MANIFEST_DIR}/manifest.json"
SHA256="$(sha256sum "$DEB" | awk '{print $1}')"
SIZE_BYTES="$(stat -c %s "$DEB")"
PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEB_URL="https://github.com/${REPO}/releases/download/${TAG}/$(basename "$DEB")"
NOTES_LINE="${NOTES}"  # mesma string ja construida acima

sudo mkdir -p "$MANIFEST_DIR"

# jq -n monta o JSON do zero a partir das variaveis (sem heredoc com escape).
sudo tee "$MANIFEST_PATH" >/dev/null <<EOF
$(jq -n \
    --arg version "$VERSION" \
    --arg commit "$COMMIT" \
    --arg channel "$TAG" \
    --arg url "$DEB_URL" \
    --arg sha256 "$SHA256" \
    --argjson size_bytes "$SIZE_BYTES" \
    --arg published_at "$PUBLISHED_AT" \
    --arg notes "$NOTES_LINE" \
    '{
        schema_version: 1,
        version: $version,
        commit: $commit,
        channel: $channel,
        url: $url,
        sha256: $sha256,
        size_bytes: $size_bytes,
        published_at: $published_at,
        notes: $notes,
        min_version: null
    }')
EOF

echo "[release] manifest -> ${MANIFEST_PATH}"
```

- [ ] **Step 2: Validar via dry-run (sem build)**

Rodar fragmento isolado pra confirmar que o JSON sai bem-formado:

```bash
VERSION="0.2.26"
COMMIT="testabc"
TAG="dev"
DEB="/tmp/fake.deb"
REPO="PedroGiudice/rustify-player"
NOTES="v0.2.26 · Branch: main · Commit: testabc · 2026-05-17T18:30:00Z"

echo "fake" > "$DEB"
SHA256="$(sha256sum "$DEB" | awk '{print $1}')"
SIZE_BYTES="$(stat -c %s "$DEB")"
PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEB_URL="https://github.com/${REPO}/releases/download/${TAG}/$(basename "$DEB")"

jq -n \
  --arg version "$VERSION" \
  --arg commit "$COMMIT" \
  --arg channel "$TAG" \
  --arg url "$DEB_URL" \
  --arg sha256 "$SHA256" \
  --argjson size_bytes "$SIZE_BYTES" \
  --arg published_at "$PUBLISHED_AT" \
  --arg notes "$NOTES" \
  '{schema_version:1, version:$version, commit:$commit, channel:$channel, url:$url, sha256:$sha256, size_bytes:$size_bytes, published_at:$published_at, notes:$notes, min_version:null}'
```

Expected: JSON valido com todos os campos preenchidos. Se sair `null` em algum, depurar antes.

- [ ] **Step 3: Garantir permissão de escrita em /var/www/updates/rustify/**

Setup one-time (NÃO entra no script; user roda manual uma vez):

```bash
sudo mkdir -p /var/www/updates/rustify
sudo chown -R www-data:www-data /var/www/updates/rustify
# Permitir o user opc escrever sem sudo (mais limpo que sudo dentro do release.sh)
sudo setfacl -R -m u:opc:rwx /var/www/updates/rustify
sudo setfacl -d -m u:opc:rwx /var/www/updates/rustify
```

Depois do setup, REMOVER os dois `sudo` do trecho adicionado no Step 1 (deixar `tee` e `mkdir` sem sudo).

- [ ] **Step 4: Validar que o manifest é servido pelo nginx**

Após rodar `./scripts/release.sh` (ou só copiar manualmente um manifest dummy pra testar a rota):

```bash
echo '{"version":"test"}' > /var/www/updates/rustify/manifest.json
curl -s http://localhost:8090/rustify/manifest.json
curl -s http://100.123.73.128:8090/rustify/manifest.json
```

Expected: ambos retornam `{"version":"test"}`. Se 404, conferir `/etc/nginx/conf.d/updates.conf` (já tem `root /var/www/updates;` e autoindex).

- [ ] **Step 5: Commit**

```bash
git add scripts/release.sh
git commit -m "feat(release): publica manifest.json na VM para auto-update

Mantém .deb hospedado no GitHub Releases (storage robusto).
Manifest enxuto (~200B) servido por nginx :8090 da VM.
schema_version=1 permite evolução sem quebrar clientes."
```

---

## Task 2: Trocar fonte de truth do rustify-update.sh para manifest VM

**Files:**
- Modify: `scripts/rustify-update.sh:34-135` (substituir `cmd_check_json` + `cmd_install`)

- [ ] **Step 1: Escrever os testes manuais primeiro**

Antes de mexer, garantir que tem manifest válido na VM (Task 1 já populou). Validar inputs/outputs:

```bash
# Input: curl no manifest VM
curl -s http://100.123.73.128:8090/rustify/manifest.json | jq .

# Output esperado do --check-json após a mudança:
# {
#   "current_version": "0.2.26 · 664a04b",
#   "latest_version": "0.2.27 · abc1234",
#   "update_available": true,
#   "published_at": "2026-05-17T19:00:00Z",
#   "download_url": "https://github.com/..."
# }
```

Manter o mesmo schema de saída pra **não** quebrar o cliente Rust (`UpdateCheckResult` em lib.rs:2208).

- [ ] **Step 2: Reescrever cmd_check_json**

Substituir o bloco completo (linhas 34-135 originais) por:

```bash
# Manifest URL — VM tailnet (via Tailscale o cmr-auto tem rota direta).
# Fallback HTTPS via Tailscale Serve quando configurarmos rota dedicada.
MANIFEST_URL="${RUSTIFY_MANIFEST_URL:-http://100.123.73.128:8090/rustify/manifest.json}"

cmd_check_json() {
    require_cmd curl
    require_cmd jq
    require_cmd dpkg-query
    require_cmd stat
    require_cmd date

    local current_ver
    if [ -r /usr/share/rustify-player/VERSION ]; then
        current_ver=$(head -n 1 /usr/share/rustify-player/VERSION)
    else
        current_ver=$(dpkg-query -W -f='${Version}' "$PKG" 2>/dev/null || echo "unknown")
    fi

    # curl --max-time 5 evita que o app trave esperando rede; -f retorna nao-zero
    # em 4xx/5xx pra cair no error branch sem parse de HTML.
    local manifest
    if ! manifest=$(curl -sf --max-time 5 "$MANIFEST_URL" 2>/dev/null); then
        emit_error_json "manifest_unreachable" "Não consegui acessar o manifest em $MANIFEST_URL. Confere se a VM tá no ar."
        return 0
    fi

    # Valida JSON antes de extrair — se nginx servir HTML por engano (rota errada),
    # cai aqui em vez de explodir no jq abaixo.
    if ! echo "$manifest" | jq -e . >/dev/null 2>&1; then
        emit_error_json "manifest_invalid" "Manifest não é JSON válido."
        return 0
    fi

    local remote_pkg_ver remote_sha remote_url remote_pub remote_size
    remote_pkg_ver=$(echo "$manifest" | jq -r '.version // empty')
    remote_sha=$(echo "$manifest" | jq -r '.commit // empty')
    remote_url=$(echo "$manifest" | jq -r '.url // empty')
    remote_pub=$(echo "$manifest" | jq -r '.published_at // empty')
    remote_size=$(echo "$manifest" | jq -r '.size_bytes // 0')

    if [ -z "$remote_pkg_ver" ] || [ -z "$remote_url" ]; then
        emit_error_json "manifest_incomplete" "Manifest sem version/url."
        return 0
    fi

    local remote_ver
    if [ -n "$remote_sha" ]; then
        remote_ver="${remote_pkg_ver} · ${remote_sha}"
    else
        remote_ver="$remote_pkg_ver"
    fi

    # mesma estratégia da versao antiga: mtime do md5sums vs published_at remoto
    local local_install_ts remote_pub_ts
    if [ -f "/var/lib/dpkg/info/${PKG}.md5sums" ]; then
        local_install_ts=$(stat -c %Y "/var/lib/dpkg/info/${PKG}.md5sums")
    else
        local_install_ts=0
    fi
    remote_pub_ts=$(date -d "$remote_pub" +%s 2>/dev/null || echo 0)

    local update_available="false"
    if [ "$remote_pub_ts" -gt "$local_install_ts" ]; then
        update_available="true"
    fi

    jq -n \
        --arg cv "$current_ver" \
        --arg lv "$remote_ver" \
        --arg pa "$remote_pub" \
        --arg du "$remote_url" \
        --argjson sz "$remote_size" \
        --argjson ua "$update_available" \
        '{
            current_version: $cv,
            latest_version: $lv,
            update_available: $ua,
            published_at: $pa,
            download_url: $du,
            size_bytes: $sz
        }'
}
```

- [ ] **Step 3: Reescrever cmd_install**

Substituir o bloco antigo (que usa `gh release download`) por download direto da URL no manifest:

```bash
cmd_install() {
    require_cmd curl
    require_cmd jq
    require_cmd pkexec
    require_cmd mktemp

    local tmpdir
    tmpdir=$(mktemp -d -t rustify-update-XXXXXX)
    trap "rm -rf '$tmpdir'" EXIT

    local manifest
    manifest=$(curl -sf --max-time 5 "$MANIFEST_URL") || {
        echo "manifest unreachable: $MANIFEST_URL" >&2
        exit 4
    }

    local url version sha256
    url=$(echo "$manifest" | jq -r '.url // empty')
    version=$(echo "$manifest" | jq -r '.version // empty')
    sha256=$(echo "$manifest" | jq -r '.sha256 // empty')

    if [ -z "$url" ] || [ -z "$version" ]; then
        echo "manifest missing url/version" >&2
        exit 3
    fi

    local deb="$tmpdir/rustify-player_${version}_amd64.deb"
    echo "downloading from $url"
    curl -sL --max-time 60 -o "$deb" "$url" || {
        echo "download failed" >&2
        exit 3
    }

    # Verifica sha256 quando o manifest fornece — protege contra MitM no
    # download e contra .deb corrompido. Se manifest nao tiver sha (compat),
    # pula e prossegue.
    if [ -n "$sha256" ]; then
        local got
        got=$(sha256sum "$deb" | awk '{print $1}')
        if [ "$got" != "$sha256" ]; then
            echo "sha256 mismatch: expected $sha256 got $got" >&2
            exit 5
        fi
    fi

    pkexec dpkg -i "$deb"
}
```

- [ ] **Step 4: Rodar smoke test manual**

```bash
# Direto na VM ou cmr-auto:
RUSTIFY_MANIFEST_URL=http://100.123.73.128:8090/rustify/manifest.json \
  bash scripts/rustify-update.sh --check-json | jq .
```

Expected: JSON com os campos `current_version`, `latest_version`, `update_available`, `published_at`, `download_url`, `size_bytes`.

Se rodar na VM sem o pacote instalado, `current_version` vira `"unknown"` e `update_available=true` (mtime fallback `=0` é sempre menor que published_at). Isso é correto.

- [ ] **Step 5: Caso de erro - VM offline**

Simular VM offline:

```bash
RUSTIFY_MANIFEST_URL=http://10.0.0.1:9999/foo bash scripts/rustify-update.sh --check-json
```

Expected: `{"error":"manifest_unreachable","message":"Não consegui acessar..."}` em ~5s (timeout).

- [ ] **Step 6: Commit**

```bash
git add scripts/rustify-update.sh
git commit -m "feat(updater): consulta manifest na VM em vez do GitHub API

- curl http://100.123.73.128:8090/rustify/manifest.json com timeout 5s
- Mesmo schema de saída do --check-json (compat com Rust commands)
- Override via RUSTIFY_MANIFEST_URL pra dev/staging
- sha256 verification opcional quando manifest fornece"
```

---

## Task 3: Criar store de update no frontend

**Files:**
- Create: `src/store/update.ts`
- Create: `src/store/update.test.ts`

- [ ] **Step 1: Escrever os testes primeiro**

```tsx
// src/store/update.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const checkForUpdate = vi.fn();
const installUpdate = vi.fn();
const restartApp = vi.fn();

vi.mock("../tauri", () => ({
  checkForUpdate: () => checkForUpdate(),
  installUpdate: () => installUpdate(),
  restartApp: () => restartApp(),
}));

describe("store/update", () => {
  beforeEach(() => {
    vi.resetModules();
    checkForUpdate.mockReset();
    installUpdate.mockReset();
    restartApp.mockReset();
  });

  it("checkUpdate: armazena status quando update_available=true", async () => {
    checkForUpdate.mockResolvedValue({
      update_available: true,
      current_version: "0.2.26",
      latest_version: "0.2.27 · abc",
      download_url: "https://github.com/...",
      published_at: "2026-05-17T19:00:00Z",
    });
    const { updateStatus, checkUpdate } = await import("./update");
    await checkUpdate();
    expect(updateStatus()?.update_available).toBe(true);
    expect(updateStatus()?.latest_version).toBe("0.2.27 · abc");
  });

  it("checkUpdate: nao seta erro quando up_to_date", async () => {
    checkForUpdate.mockResolvedValue({
      update_available: false,
      current_version: "0.2.27",
      latest_version: "0.2.27",
    });
    const { updateStatus, updateError, checkUpdate } = await import("./update");
    await checkUpdate();
    expect(updateStatus()?.update_available).toBe(false);
    expect(updateError()).toBe(null);
  });

  it("checkUpdate: armazena erro quando manifest_unreachable", async () => {
    checkForUpdate.mockResolvedValue({
      error: "manifest_unreachable",
      message: "VM offline",
    });
    const { updateStatus, updateError, checkUpdate } = await import("./update");
    await checkUpdate();
    expect(updateError()).toBe("VM offline");
    expect(updateStatus()).toBe(null);
  });

  it("dismissBanner: zera o status sem zerar a versao remota", async () => {
    checkForUpdate.mockResolvedValue({
      update_available: true,
      latest_version: "0.2.27 · abc",
    });
    const { updateStatus, checkUpdate, dismissBanner, bannerVisible } = await import("./update");
    await checkUpdate();
    expect(bannerVisible()).toBe(true);
    dismissBanner();
    expect(bannerVisible()).toBe(false);
    expect(updateStatus()?.latest_version).toBe("0.2.27 · abc");
  });
});
```

- [ ] **Step 2: Run tests (devem falhar)**

```bash
bun test src/store/update.test.ts
```

Expected: FAIL — `./update` não existe.

- [ ] **Step 3: Implementar o store**

```tsx
// src/store/update.ts
/* ============================================================
   store/update.ts — Estado global de update.

   Polling no startup + 1x/hora consultando o manifest VM via
   `check_for_update` Tauri command. UI consome `updateStatus()`
   e `bannerVisible()` para mostrar/esconder banner.
   ============================================================ */

import { createSignal } from "solid-js";
import { checkForUpdate, installUpdate, restartApp } from "../tauri";

export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  published_at?: string;
  download_url?: string;
  size_bytes?: number;
}

const [status, setStatus] = createSignal<UpdateInfo | null>(null);
const [error, setError] = createSignal<string | null>(null);
const [installing, setInstalling] = createSignal(false);
const [installed, setInstalled] = createSignal(false);
const [dismissed, setDismissed] = createSignal(false);

export const updateStatus = status;
export const updateError = error;
export const updateInstalling = installing;
export const updateInstalled = installed;

// bannerVisible: combina status + dismissed. Reaparece a cada nova
// checagem que detecta update novo (latest_version != lastDismissedVersion).
const [lastDismissedVer, setLastDismissedVer] = createSignal<string | null>(null);
export function bannerVisible(): boolean {
  const s = status();
  if (!s?.update_available) return false;
  if (dismissed() && s.latest_version === lastDismissedVer()) return false;
  return true;
}

export async function checkUpdate(): Promise<void> {
  try {
    const result: any = await checkForUpdate();
    if (result?.error) {
      setError(result.message ?? result.error);
      setStatus(null);
      return;
    }
    setError(null);
    setStatus(result as UpdateInfo);
    if (result?.latest_version !== lastDismissedVer()) {
      setDismissed(false);
    }
  } catch (e) {
    setError(String(e));
    setStatus(null);
  }
}

export async function installNow(): Promise<void> {
  setInstalling(true);
  try {
    await installUpdate();
    setInstalled(true);
  } catch (e) {
    setError(`Install falhou: ${e}`);
  } finally {
    setInstalling(false);
  }
}

export async function restartNow(): Promise<void> {
  await restartApp();
}

export function dismissBanner(): void {
  const s = status();
  if (s) setLastDismissedVer(s.latest_version);
  setDismissed(true);
}

// Polling: 1x no boot + 1x a cada hora. Curto o suficiente pra usuario
// nao precisar reiniciar pra ver updates; longo o suficiente pra nao
// gastar requests. Pode ser ajustado via Tweaks no futuro.
const POLL_INTERVAL_MS = 60 * 60 * 1000;

let pollHandle: ReturnType<typeof setInterval> | null = null;

export function startUpdatePolling(): void {
  if (pollHandle) return;
  // Primeira checagem com pequeno delay pra nao competir com boot do app
  setTimeout(() => { void checkUpdate(); }, 8_000);
  pollHandle = setInterval(() => { void checkUpdate(); }, POLL_INTERVAL_MS);
}

export function stopUpdatePolling(): void {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}
```

- [ ] **Step 4: Run tests (devem passar)**

```bash
bun test src/store/update.test.ts
```

Expected: 4 testes passing.

- [ ] **Step 5: Commit**

```bash
git add src/store/update.ts src/store/update.test.ts
git commit -m "feat(update): store de update com polling 1x/hora

- checkUpdate() invoca check_for_update Tauri command
- bannerVisible() combina status + dismissed (resseta em version nova)
- installNow() + restartNow() para o fluxo do banner
- startUpdatePolling() chamado pelo App.tsx no mount"
```

---

## Task 4: Criar UpdateBanner component

**Files:**
- Create: `src/components/UpdateBanner.tsx`
- Create: `src/components/UpdateBanner.test.tsx`

- [ ] **Step 1: Escrever os testes**

```tsx
// src/components/UpdateBanner.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

const checkForUpdate = vi.fn();
const installUpdate = vi.fn();
const restartApp = vi.fn();

vi.mock("../tauri", () => ({
  checkForUpdate: () => checkForUpdate(),
  installUpdate: () => installUpdate(),
  restartApp: () => restartApp(),
}));

describe("UpdateBanner", () => {
  beforeEach(() => {
    vi.resetModules();
    checkForUpdate.mockReset();
    installUpdate.mockReset();
    restartApp.mockReset();
  });

  it("nao renderiza quando bannerVisible=false (sem update)", async () => {
    checkForUpdate.mockResolvedValue({
      update_available: false,
      current_version: "0.2.26",
      latest_version: "0.2.26",
    });
    const { UpdateBanner } = await import("./UpdateBanner");
    const { checkUpdate } = await import("../store/update");
    await checkUpdate();
    const { container } = render(() => <UpdateBanner />);
    expect(container.querySelector(".update-banner")).toBeNull();
  });

  it("renderiza com versao e botoes quando update_available=true", async () => {
    checkForUpdate.mockResolvedValue({
      update_available: true,
      current_version: "0.2.26",
      latest_version: "0.2.27 · abc1234",
      published_at: "2026-05-17T19:00:00Z",
    });
    const { UpdateBanner } = await import("./UpdateBanner");
    const { checkUpdate } = await import("../store/update");
    await checkUpdate();
    const { container, getByText } = render(() => <UpdateBanner />);
    expect(container.querySelector(".update-banner")).not.toBeNull();
    expect(getByText(/0\.2\.27/)).toBeTruthy();
    expect(getByText(/Instalar/i)).toBeTruthy();
    expect(getByText(/Depois/i)).toBeTruthy();
  });

  it("clique em Depois esconde o banner", async () => {
    checkForUpdate.mockResolvedValue({
      update_available: true,
      latest_version: "0.2.27 · abc",
    });
    const { UpdateBanner } = await import("./UpdateBanner");
    const { checkUpdate } = await import("../store/update");
    await checkUpdate();
    const { container, getByText } = render(() => <UpdateBanner />);
    fireEvent.click(getByText(/Depois/i));
    expect(container.querySelector(".update-banner")).toBeNull();
  });

  it("clique em Instalar dispara installUpdate", async () => {
    checkForUpdate.mockResolvedValue({
      update_available: true,
      latest_version: "0.2.27 · abc",
    });
    installUpdate.mockResolvedValue(undefined);
    const { UpdateBanner } = await import("./UpdateBanner");
    const { checkUpdate } = await import("../store/update");
    await checkUpdate();
    const { getByText } = render(() => <UpdateBanner />);
    fireEvent.click(getByText(/Instalar/i));
    await Promise.resolve();
    expect(installUpdate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests (devem falhar)**

```bash
bun test src/components/UpdateBanner.test.tsx
```

Expected: FAIL — `./UpdateBanner` não existe.

- [ ] **Step 3: Implementar o componente**

```tsx
// src/components/UpdateBanner.tsx
/* ============================================================
   components/UpdateBanner.tsx — Banner fixo no topo do shell
   quando ha versao mais nova disponivel.

   Estados:
   - dispoonivel: mostra "v0.2.27 disponível · [Instalar] [Depois]"
   - instalando: spinner + label
   - instalado: "Restart pra aplicar · [Reiniciar]"
   ============================================================ */

import { Show } from "solid-js";
import {
  updateStatus,
  updateInstalling,
  updateInstalled,
  bannerVisible,
  dismissBanner,
  installNow,
  restartNow,
} from "../store/update";

export function UpdateBanner() {
  return (
    <Show when={bannerVisible() || updateInstalled()}>
      <div class="update-banner" role="status" aria-live="polite">
        <Show
          when={updateInstalled()}
          fallback={
            <>
              <span class="update-banner__msg">
                Atualização disponível:{" "}
                <b>{updateStatus()?.latest_version}</b>
              </span>
              <div class="update-banner__actions">
                <button
                  class="update-banner__btn update-banner__btn--primary"
                  disabled={updateInstalling()}
                  onClick={() => void installNow()}
                >
                  {updateInstalling() ? "Instalando…" : "Instalar"}
                </button>
                <button
                  class="update-banner__btn"
                  onClick={() => dismissBanner()}
                >
                  Depois
                </button>
              </div>
            </>
          }
        >
          <span class="update-banner__msg">
            Update instalado. Reinicia para aplicar.
          </span>
          <div class="update-banner__actions">
            <button
              class="update-banner__btn update-banner__btn--primary"
              onClick={() => void restartNow()}
            >
              Reiniciar
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
```

- [ ] **Step 4: Run tests (devem passar)**

```bash
bun test src/components/UpdateBanner.test.tsx
```

Expected: 4 testes passing.

- [ ] **Step 5: Commit**

```bash
git add src/components/UpdateBanner.tsx src/components/UpdateBanner.test.tsx
git commit -m "feat(update): banner sticky no topo do shell

Mostra latest_version quando update_available, com Instalar/Depois.
Após install, swap para Reiniciar pra aplicar via app.restart()."
```

---

## Task 5: Wire-up no App.tsx + estilos

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles/extractor-lab.css`

- [ ] **Step 1: Adicionar UpdateBanner no App.tsx**

Editar `src/App.tsx`:

**Imports (logo após `import { Tweaks }`):**

```tsx
import { UpdateBanner } from "./components/UpdateBanner";
import { startUpdatePolling } from "./store/update";
```

**Dentro do `onMount` (depois do `window.addEventListener("keydown", onKey)`):**

```tsx
    startUpdatePolling();
```

**No JSX (entre `<Titlebar />` e `<Sidebar />`):**

```tsx
      <Titlebar />
      <UpdateBanner />
      <Sidebar />
```

- [ ] **Step 2: Adicionar estilos do banner em extractor-lab.css**

Adicionar no final do arquivo:

```css
/* ============================================================
   Update banner — sticky no topo, abaixo da Titlebar.
   ============================================================ */
.update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  background: linear-gradient(
    90deg,
    color-mix(in oklab, var(--accent, #2563eb) 12%, transparent),
    color-mix(in oklab, var(--accent, #2563eb) 4%, transparent)
  );
  border-bottom: 1px solid color-mix(in oklab, var(--accent, #2563eb) 30%, transparent);
  font-size: 13px;
  color: var(--ink, #1a1a1a);
  position: relative;
  z-index: 50;
}

.update-banner__msg b {
  font-weight: 600;
  color: var(--accent, #2563eb);
}

.update-banner__actions {
  display: flex;
  gap: 8px;
}

.update-banner__btn {
  appearance: none;
  border: 1px solid color-mix(in oklab, var(--ink, #1a1a1a) 20%, transparent);
  background: transparent;
  color: var(--ink, #1a1a1a);
  padding: 4px 12px;
  border-radius: 6px;
  font: inherit;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.update-banner__btn:hover:not(:disabled) {
  background: color-mix(in oklab, var(--ink, #1a1a1a) 6%, transparent);
}

.update-banner__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.update-banner__btn--primary {
  background: var(--accent, #2563eb);
  border-color: var(--accent, #2563eb);
  color: #fff;
}

.update-banner__btn--primary:hover:not(:disabled) {
  background: color-mix(in oklab, var(--accent, #2563eb) 88%, #000);
}
```

- [ ] **Step 3: Smoke test do bundle**

```bash
bun run build
```

Expected: build limpo, zero erros TypeScript.

- [ ] **Step 4: Validar visualmente com fake manifest**

Pra forçar `update_available=true` no dev, sobrescrever o manifest na VM com versão fictícia maior:

```bash
# Na VM:
jq '.version = "9.9.9" | .published_at = "2099-01-01T00:00:00Z"' \
  /var/www/updates/rustify/manifest.json | tee /tmp/fake.json
cp /tmp/fake.json /var/www/updates/rustify/manifest.json
```

Rodar o app na cmr-auto, esperar 8s pelo primeiro poll, banner deve aparecer com `"9.9.9"`.

Restaurar o manifest depois (`./scripts/release.sh` reescreve com a versão real).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/styles/extractor-lab.css
git commit -m "feat(update): monta UpdateBanner + estilos no shell

Banner aparece entre Titlebar e Sidebar quando há update.
Polling iniciado no mount via startUpdatePolling()."
```

---

## Task 6: Release + smoke test end-to-end

**Files:**
- Nenhum (apenas execução)

- [ ] **Step 1: Bump version**

Editar `src-tauri/tauri.conf.json:4` — incrementar version (ex: `0.2.27`).

```bash
git add src-tauri/tauri.conf.json
git commit -m "chore(release): v0.2.27"
```

- [ ] **Step 2: Rodar release.sh**

```bash
./scripts/release.sh
```

Expected output (no final):
- `[release] manifest -> /var/www/updates/rustify/manifest.json`
- `[release] done`

- [ ] **Step 3: Verificar manifest publicado**

```bash
curl -s http://100.123.73.128:8090/rustify/manifest.json | jq .
```

Expected: JSON com `version: "0.2.27"`, `commit` matching `git rev-parse --short HEAD`, `sha256` correto.

- [ ] **Step 4: Verificar sha256**

```bash
DEB="src-tauri/target/release/bundle/deb/rustify-player_0.2.27_amd64.deb"
LOCAL_SHA=$(sha256sum "$DEB" | awk '{print $1}')
REMOTE_SHA=$(curl -s http://100.123.73.128:8090/rustify/manifest.json | jq -r '.sha256')
test "$LOCAL_SHA" = "$REMOTE_SHA" && echo "OK: sha256 match" || echo "FAIL: sha mismatch"
```

Expected: `OK: sha256 match`.

- [ ] **Step 5: cmr-auto puxa via app**

Usuário rodando o app na cmr-auto:
1. Aguardar ~8s após boot — banner deve aparecer mostrando `0.2.27`
2. Clicar **Instalar** — pkexec abre prompt, digita senha
3. Apos `dpkg -i` finish, banner muda pra "Reiniciar"
4. Clicar **Reiniciar** — app fecha e reabre

Fluxo alternativo manual (se quiser pular o banner):

```bash
# cmr-auto:
bash <(curl -s http://100.123.73.128:8090/rustify/install.sh) 2>/dev/null \
  || curl -sL "$(curl -s http://100.123.73.128:8090/rustify/manifest.json | jq -r .url)" \
  -o /tmp/rustify.deb && sudo dpkg -i /tmp/rustify.deb
```

- [ ] **Step 6: Documentar no CLAUDE.md do projeto**

Adicionar seção no `CLAUDE.md`:

```markdown
## Auto-update server

Manifest hospedado em `http://100.123.73.128:8090/rustify/manifest.json`
(servido por nginx `/var/www/updates/rustify/`, gerado pelo `release.sh`).

- Schema: `schema_version`, `version`, `commit`, `channel`, `url`,
  `sha256`, `size_bytes`, `published_at`, `notes`, `min_version`.
- Cliente: `scripts/rustify-update.sh --check-json | --install`.
- Override pra dev/staging: `RUSTIFY_MANIFEST_URL=http://...`.
- Banner Solid em `src/components/UpdateBanner.tsx` faz polling
  1x no boot + 1x/hora via `src/store/update.ts`.

Pra forçar banner em dev, sobrescrever o manifest com version maior:
\`\`\`bash
jq '.version = "9.9.9" | .published_at = "2099-01-01T00:00:00Z"' \
  /var/www/updates/rustify/manifest.json > /tmp/x && \
  mv /tmp/x /var/www/updates/rustify/manifest.json
\`\`\`
Próximo `release.sh` restaura.
```

```bash
git add CLAUDE.md
git commit -m "docs: documenta auto-update via manifest VM no CLAUDE.md"
```

---

## Verification (end-to-end)

Rodar tudo na ordem após implementar todas as tasks:

1. **Server-side:**
   ```bash
   curl -s http://100.123.73.128:8090/rustify/manifest.json | jq .
   ```
   Esperado: JSON bem-formado, `schema_version: 1`, `version` matching `tauri.conf.json`.

2. **Script:**
   ```bash
   bash scripts/rustify-update.sh --check-json | jq .
   ```
   Esperado: JSON com `current_version`, `latest_version`, `update_available`, `download_url`.

3. **Erro path:**
   ```bash
   RUSTIFY_MANIFEST_URL=http://10.0.0.1:9999/x bash scripts/rustify-update.sh --check-json
   ```
   Esperado: `{"error":"manifest_unreachable",...}` em ~5s.

4. **Frontend tests:**
   ```bash
   bun test src/store/update.test.ts src/components/UpdateBanner.test.tsx
   ```
   Esperado: 8 testes passing (4 store + 4 banner).

5. **Build limpo:**
   ```bash
   bun run build
   cargo check --manifest-path src-tauri/Cargo.toml
   ```
   Esperado: zero erros.

6. **Banner visivel com fake manifest:**
   - Sobrescrever manifest com `"version":"9.9.9"`, rodar app, aguardar 8s
   - Banner deve aparecer entre Titlebar e Sidebar
   - Clique em "Depois" esconde
   - Próximo boot reaparece (porque dismissed nao persiste — proposital, força ação)

7. **Install end-to-end na cmr-auto:**
   - Release v0.2.27 publicado
   - cmr-auto rodando v0.2.26 → banner aparece
   - Clique **Instalar** → pkexec pede senha → `dpkg -i` roda
   - Banner muda pra "Reiniciar" → clique → app reabre em v0.2.27

---

## Notas operacionais

**Por que polling 1x/hora e não websocket/SSE:**
- A VM nao precisa empurrar mensagem. Update é evento raro (1-5x/dia em dev, semanal em stable).
- 1 request HTTP de ~200 bytes/hora é negligível (24 req/dia/cliente).
- Sem state server-side, sem subscription cleanup.

**Por que dismissed não persiste em localStorage:**
- Decisão deliberada: usuário fecha o banner, no próximo boot reaparece (se ainda há update pendente).
- Persistir tornaria o usuário "esquecer" do update por dias — antitético ao goal.
- Se o usuário instala, `bannerVisible` cai sozinho na próxima check (porque update_available=false).

**Single point of failure:**
- VM offline → `manifest_unreachable` → banner não aparece, mas app continua funcionando normal.
- Fallback explícito hoje: `gh release download` manual (sempre disponível).
- Futuro: adicionar fallback automático no script (`curl manifest || gh release view`).

**Migração da versão antiga (Opção C):**
- Compat total: clientes antigos (com versão antiga do `rustify-update.sh` que usa `gh`) continuam funcionando direto contra GH Releases enquanto o `dev` tag existir.
- Migração efetiva: cmr-auto recebe `.deb` v0.2.27 com novo script → próximas checagens já usam VM.

**Custos:**
- Bandwidth VM: ~200B × 24 polls/dia × N clientes = trivial.
- Bandwidth GH: download do .deb (~50MB) só quando update disponível, ~mensal.
- Storage VM: 1 arquivo JSON, sempre sobrescrito.

---

## Self-Review

**Cobertura do spec:**
- Manifest schema ✅ Task 1
- release.sh publica manifest ✅ Task 1
- rustify-update.sh lê do manifest VM ✅ Task 2
- Banner UI ✅ Task 4
- App.tsx wire-up + estilos ✅ Task 5
- Polling no boot ✅ Task 3
- Erro path (VM offline) ✅ Task 2 Step 5
- sha256 verification ✅ Task 2 Step 3 (opcional, ativa quando manifest fornece)
- Documentação ✅ Task 6 Step 6
- Smoke test end-to-end ✅ Task 6

**Placeholders:** zero. Cada step tem código exato ou comando exato.

**Type consistency:**
- `UpdateInfo` em `src/store/update.ts` tem mesmos campos que `UpdateCheckResult` em `src-tauri/src/lib.rs:2208` (current_version, latest_version, update_available, published_at, download_url).
- `size_bytes` adicionado no schema novo é opcional — Rust struct ainda não lê, sem quebra.
- Banner `UpdateBanner.tsx` consome só campos garantidos (`latest_version`, `update_available`).

**Riscos identificados:**
- nginx :8090 já tem CORS aberto (`Access-Control-Allow-Origin *`) — sem mudança necessária.
- `setfacl` no setup one-time depende de package `acl` instalado. Validar antes: `dpkg -l acl`.
- Se cmr-auto não estiver na tailnet (raro), `100.123.73.128:8090` fica inacessível. Resolução: usar o IP público `217.76.48.35:8090` (já funciona, testado em Task 0 setup).

---

**Total estimado:** ~3h (1h Tasks 1-2 server-side, 1h Tasks 3-4 frontend, 30min Task 5 wire-up, 30min Task 6 release + smoke test).
