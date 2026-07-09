# Tier 0 — Remocoes de Controles Zumbi

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans

**Goal:** Remover 8 controles zumbi (markup + handlers + localStorage keys + imports orfaos) de `Settings.tsx` e `Stations.tsx`, deixando zero botoes sem acao real e zero keys de localStorage sem consumidor.

**Architecture:** Cada item e uma edicao localizada em `Settings.tsx` ou `Stations.tsx`. A cobertura de regressao e feita estendendo os arquivos de teste ja existentes (`Settings.test.tsx`, `Stations.test.tsx`) com asserts de ausencia dos controles removidos e presenca dos controles vivos. O ciclo TDD e: escrever asserts de ausencia (falham porque o elemento ainda existe) → remover o markup/handler/key → asserts passam.

**Branch:** `fix/tier0-zombie-controls`

---

## Mapa de Remocoes (confirmado via Read)

| Item | Linha(s) reais em Settings.tsx | O que sai |
|------|-------------------------------|-----------|
| 0.7 Crossfade | linhas 460-476 (set-row) + 190-201 (signals + handler) + const `CROSSFADE_KEY` (83) | set-row, signal `crossfade`, fn `setCrossfadeS`, fn `onCrossfadeTrackClick`, const `CROSSFADE_KEY` |
| 0.6 Gapless | linhas 478-486 (set-row) + 176-181 (signal + handler) + const `GAPLESS_KEY` (81) | set-row, signal `gapless`, fn `toggleGapless`, const `GAPLESS_KEY` |
| 0.1 Output device | linhas 488-498 (set-row inteira) | set-row com botao "Change…" |
| 0.2 Scrobble | linhas 541-549 (set-row inteira) | set-row com botao "Connect…" |
| 0.3 Generate missing | linhas 609-619 (controle da set-row) | apenas o `set-row__control` com o botao; a row fica como stat read-only |
| 0.4 qdrant Restart | linhas 627-634 (controle da set-row) | apenas o `set-row__control` com o botao; a row fica read-only |
| 0.8 Music folder Trocar | linhas 568-579 (controle da set-row) | apenas o botao com onClick console.log; a row fica read-only mostrando ~/Music/library |
| 0.5 Resume station disabled | Stations.tsx linha 273 | botao `disabled` REMOVIDO; empty-state fica so com o texto explicativo |

**Nota sobre 0.3 e 0.4:** a set-row do "Embeddings" e a do "qdrant process" ficam. So o `set-row__control` (o botao) sai. O label, hint e stat permanecem.

**Nota sobre 0.5 (ajustado 06/06):** o botao disabled e apenas REMOVIDO — o Tier 0 e remocao pura. Substituir por um CTA funcional ("Create first station") depende de `handleNewFromCurrent` usar a faixa atual (so corrigido no Tier 2) + guard de "sem faixa tocando". Esse CTA real entra no Tier 2 junto com o item 2.1.

---

## Task 1 — Criar branch e rodar testes baseline

**Files:** nenhum arquivo editado
**Objetivo:** confirmar que os testes atuais passam antes de qualquer mudanca.

### Steps

1. Criar branch de trabalho:
   ```bash
   git checkout -b fix/tier0-zombie-controls
   ```

2. Rodar testes:
   ```bash
   cd /home/opc/rustify-player && npx vitest run src/views/Settings.test.tsx src/views/Stations.test.tsx
   ```
   Resultado esperado: todos os testes passam. Se algum ja falha, registrar e nao prosseguir ate entender.

---

## Task 2 — Escrever testes de ausencia em Settings.test.tsx (falham inicialmente)

**Files:** `src/views/Settings.test.tsx` — adicionar `describe` block ao final

### Steps

1. Abrir `src/views/Settings.test.tsx` e adicionar apos o ultimo `it(` do describe "Settings view" (linha 204, antes do `}` de fechamento do describe) o seguinte bloco:

```tsx
  // ── Tier 0: controles removidos NAO devem existir ────────────
  describe("controles zumbi removidos (Tier 0)", () => {
    it("0.1 Output device nao tem botao Change", () => {
      const { container } = render(() => <Settings />);
      const allBtns = Array.from(container.querySelectorAll("button"));
      const changeBtn = allBtns.find((b) => (b.textContent ?? "").trim() === "Change…");
      expect(changeBtn).toBeUndefined();
    });

    it("0.2 Scrobble nao tem botao Connect", () => {
      const { container } = render(() => <Settings />);
      const allBtns = Array.from(container.querySelectorAll("button"));
      const connectBtn = allBtns.find((b) => (b.textContent ?? "").includes("Connect…"));
      expect(connectBtn).toBeUndefined();
    });

    it("0.3 Embeddings row existe mas nao tem botao Generate missing", () => {
      const { container } = render(() => <Settings />);
      // A row de Embeddings ainda existe como stat read-only
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const embedLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("embeddings"));
      expect(embedLabel).toBeTruthy();
      // Mas o botao "Generate missing" nao existe
      const allBtns = Array.from(container.querySelectorAll("button"));
      const genBtn = allBtns.find((b) => (b.textContent ?? "").toLowerCase().includes("generate missing"));
      expect(genBtn).toBeUndefined();
    });

    it("0.4 qdrant row existe mas nao tem botao Restart", () => {
      const { container } = render(() => <Settings />);
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const qdrantLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("qdrant"));
      expect(qdrantLabel).toBeTruthy();
      // Botao Restart nao existe
      const allBtns = Array.from(container.querySelectorAll("button"));
      const restartBtn = allBtns.find((b) => (b.textContent ?? "").trim() === "Restart…");
      expect(restartBtn).toBeUndefined();
    });

    it("0.6 Gapless nao tem toggle button", () => {
      const { container } = render(() => <Settings />);
      // Nao deve existir nenhum elemento com texto Gapless
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const gaplessLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("gapless"));
      expect(gaplessLabel).toBeUndefined();
    });

    it("0.7 Crossfade nao tem slider (.set-slider)", () => {
      const { container } = render(() => <Settings />);
      // Nao deve existir label "Crossfade"
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const crossfadeLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("crossfade"));
      expect(crossfadeLabel).toBeUndefined();
      // Nao deve existir .set-slider
      expect(container.querySelector(".set-slider")).toBeNull();
    });

    it("0.8 Music folder nao tem botao Trocar", () => {
      const { container } = render(() => <Settings />);
      const allBtns = Array.from(container.querySelectorAll("button"));
      const trocarBtn = allBtns.find((b) => (b.textContent ?? "").includes("Trocar"));
      expect(trocarBtn).toBeUndefined();
    });

    // Controles VIVOS devem continuar presentes
    it("controles vivos: Theme seg, Beat sync, Volume, Normalize, Re-scan, Check for updates", () => {
      const { container } = render(() => <Settings />);
      // Theme seg (Light/Dark/Auto)
      const segs = Array.from(container.querySelectorAll(".seg"));
      const themeSeg = segs.find((s) => {
        const txt = (s.textContent ?? "").toLowerCase();
        return txt.includes("light") && txt.includes("dark") && txt.includes("auto");
      });
      expect(themeSeg).toBeTruthy();
      // Beat sync seg (Off/Subtle/Pulse)
      const beatSeg = segs.find((s) => {
        const txt = (s.textContent ?? "").toLowerCase();
        return txt.includes("off") && txt.includes("pulse");
      });
      expect(beatSeg).toBeTruthy();
      // Volume slider
      const volumeInput = container.querySelector("input[type='range']");
      expect(volumeInput).toBeTruthy();
      // Normalize toggle
      const allBtns = Array.from(container.querySelectorAll("button"));
      const normBtn = allBtns.find((b) => (b.title ?? "").toLowerCase().includes("normalize") || (b.getAttribute("onClick") ?? "").includes("toggleNorm"));
      // Normalizar row deve existir
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const normLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("normalizar"));
      expect(normLabel).toBeTruthy();
      // Re-scan botao
      const rescanBtn = Array.from(container.querySelectorAll("button.set-folder-btn--accent")).find(
        (b) => (b.textContent ?? "").includes("Re-scan")
      );
      expect(rescanBtn).toBeTruthy();
      // Check for updates
      const checkBtn = allBtns.find((b) => (b.textContent ?? "").trim() === "Check for updates");
      expect(checkBtn).toBeTruthy();
    });
  });
```

2. Rodar apenas o novo describe pra confirmar que os testes falham (porque os controles ainda existem):
   ```bash
   cd /home/opc/rustify-player && npx vitest run src/views/Settings.test.tsx
   ```
   Esperado: os testes do novo describe "controles zumbi removidos" falham; os anteriores continuam passando.

---

## Task 3 — Escrever teste de ausencia e de CTA real em Stations.test.tsx (falha inicialmente)

**Files:** `src/views/Stations.test.tsx` — adicionar `it` ao describe existente

### Steps

1. Em `Stations.test.tsx`, adicionar antes do ultimo `});` de fechamento do describe "Stations view" (linha 211):

```tsx
  it("0.5 empty-state nao tem o botao disabled Resume station", async () => {
    // Simula backend sem stations (empty-state)
    (globalThis as any).window.__TAURI__.core.invoke = vi.fn(async (cmd: string) => {
      if (cmd === "lib_list_stations") return [];
      return null;
    });
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      // O feature card fallback (empty-state) deve estar visivel
      expect(container.querySelector(".st-feature")).toBeTruthy();
    });
    // Botao "Resume station" (era disabled, agora removido) NAO deve existir
    const allBtns = Array.from(container.querySelectorAll("button"));
    const resumeBtn = allBtns.find((b) => (b.textContent ?? "").includes("Resume station"));
    expect(resumeBtn).toBeUndefined();
    // O texto explicativo do empty-state continua presente
    expect((container.querySelector(".st-feature")?.textContent ?? "")).toContain("Stations aparecem aqui");
  });
```

2. Rodar o arquivo:
   ```bash
   cd /home/opc/rustify-player && npx vitest run src/views/Stations.test.tsx
   ```
   Esperado: o novo teste falha (o botao "Resume station" disabled ainda existe); os outros passam.

---

## Task 4 — Remover 0.7 Crossfade de Settings.tsx

**Files:** `src/views/Settings.tsx`

O que remover:
- const `CROSSFADE_KEY` (linha 83)
- signal `crossfade` e funcoes `setCrossfadeS` / `onCrossfadeTrackClick` (linhas 190-201)
- set-row inteira do Crossfade (linhas 460-476)

### Steps

1. Em `Settings.tsx`, remover a linha 83:
   ```
   const CROSSFADE_KEY = "rustify-mock-crossfade-s";
   ```

2. Remover o bloco de signal e handlers (linhas 189-201):
   ```tsx
   // ── Crossfade slider ──────────────────────────────────────────
   const [crossfade, setCrossfade] = createSignal<number>(parseFloat(localStorage.getItem(CROSSFADE_KEY) ?? "2"));
   function setCrossfadeS(v: number) {
     const clamped = Math.max(0, Math.min(12, Math.round(v * 10) / 10));
     setCrossfade(clamped);
     try { localStorage.setItem(CROSSFADE_KEY, String(clamped)); } catch {}
   }
   function onCrossfadeTrackClick(e: MouseEvent) {
     const el = e.currentTarget as HTMLElement;
     const rect = el.getBoundingClientRect();
     const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
     setCrossfadeS(pct * 12); // 0..12s
   }
   ```

3. Remover a set-row do Crossfade (linhas 460-476):
   ```tsx
   <div class="set-row">
     <div>
       <div class="set-row__label">Crossfade</div>
       <div class="set-row__hint">
         Overlap entre faixas. 0 desabilita; recomendado &lt; 4 s pra ambient.
       </div>
     </div>
     <div class="set-row__control">
       <div class="set-slider">
         <div class="set-slider__track" onClick={onCrossfadeTrackClick}>
           <div class="set-slider__fill" style={{ width: `${(crossfade() / 12) * 100}%` }} />
           <div class="set-slider__thumb" style={{ left: `${(crossfade() / 12) * 100}%` }} />
         </div>
         <span class="set-slider__val">{crossfade().toFixed(1)} s</span>
       </div>
     </div>
   </div>
   ```

4. Rodar `cargo check` nao se aplica (e TSX). Rodar tsc:
   ```bash
   cd /home/opc/rustify-player && npx tsc --noEmit
   ```
   Sem erros de tipo.

---

## Task 5 — Remover 0.6 Gapless de Settings.tsx

**Files:** `src/views/Settings.tsx`

O que remover:
- const `GAPLESS_KEY` (linha 81)
- signal `gapless` e funcao `toggleGapless` (linhas 176-181)
- set-row inteira do Gapless playback (linhas 478-486)

### Steps

1. Remover a linha 81:
   ```
   const GAPLESS_KEY = "rustify-mock-gapless";
   ```

2. Remover o bloco de signal + handler (linhas 176-181):
   ```tsx
   const [gapless, setGapless] = createSignal(localStorage.getItem(GAPLESS_KEY) !== "false");
   function toggleGapless() {
     const next = !gapless();
     setGapless(next);
     try { localStorage.setItem(GAPLESS_KEY, String(next)); } catch {}
   }
   ```

3. Remover a set-row do Gapless (linhas 478-486 — linhas se deslocam levemente apos Task 4):
   ```tsx
   <div class="set-row">
     <div>
       <div class="set-row__label">Gapless playback</div>
       <div class="set-row__hint">Necessario pra live e concept albums. Desabilita crossfade quando ativo.</div>
     </div>
     <div class="set-row__control">
       <button class="tog" aria-pressed={gapless() ? "true" : "false"} onClick={toggleGapless} type="button" title="Toggle gapless" />
     </div>
   </div>
   ```

4. Verificar tsc:
   ```bash
   cd /home/opc/rustify-player && npx tsc --noEmit
   ```

---

## Task 6 — Remover 0.1 Output device de Settings.tsx

**Files:** `src/views/Settings.tsx`

O que remover: a set-row inteira do Output device (linhas 488-498, ajustadas apos tasks anteriores).

### Steps

1. Localizar e remover o bloco (sera o que contem "Output device" e o botao "Change…"):
   ```tsx
   <div class="set-row">
     <div>
       <div class="set-row__label">Output device</div>
       <div class="set-row__hint mono">pipewire · default sink</div>
     </div>
     <div class="set-row__control">
       <button class="set-folder-btn" type="button" title="Backend ainda nao oferece switch de output device">
         Change…
       </button>
     </div>
   </div>
   ```

2. Verificar tsc:
   ```bash
   cd /home/opc/rustify-player && npx tsc --noEmit
   ```

---

## Task 7 — Remover 0.2 Scrobble de Settings.tsx

**Files:** `src/views/Settings.tsx`

O que remover: a set-row inteira do Scrobble (linhas 541-549, ajustadas).

### Steps

1. Localizar e remover o bloco (contem "Scrobble · Last.fm" e o botao "Connect…"):
   ```tsx
   <div class="set-row">
     <div>
       <div class="set-row__label">Scrobble · Last.fm</div>
       <div class="set-row__hint">Envia tracks tocados pro servico de scrobble. Desconectado.</div>
     </div>
     <div class="set-row__control">
       <button class="set-folder-btn" type="button" title="Integracao pendente">Connect…</button>
     </div>
   </div>
   ```

2. Verificar tsc:
   ```bash
   cd /home/opc/rustify-player && npx tsc --noEmit
   ```

---

## Task 8 — Remover botao de 0.3 Generate missing (manter row Embeddings read-only)

**Files:** `src/views/Settings.tsx`

A set-row "Embeddings" FICA. So o `set-row__control` com o botao e removido; o bloco de label + hint permanece.

### Steps

1. Localizar a set-row "Embeddings" (linhas 601-620, ajustadas). A linha de abertura contem `set-row__label">Embeddings`. Remover apenas o div `set-row__control` inteiro:
   ```tsx
   <div class="set-row__control">
     <button
       class="set-folder-btn"
       type="button"
       title="Backend pendente — gera embeddings missing"
     >
       {/* @ts-ignore */}
       <iconify-icon icon="lucide:flask-conical" noobserver />
       Generate missing · {embedPending()}
     </button>
   </div>
   ```

   Resultado: a set-row fica assim (somente a parte esquerda com label + hint):
   ```tsx
   <div class="set-row">
     <div>
       <div class="set-row__label">Embeddings</div>
       <div class="set-row__hint">
         {embedDone()} of {tracksTotal()} tracks tem AI embeddings.
         Drives the station recommender.
       </div>
     </div>
   </div>
   ```

   Nota: `embedPending()` deixa de ser usado no markup. Verificar se ainda e usado em outro lugar; se nao, remover o accessor. O signal `data()` e `embedDone()` continuam vivos para o hint da row.
   
   Verificar se `embedPending` e usado em mais algum lugar:
   ```bash
   cd /home/opc/rustify-player && grep -n "embedPending" src/views/Settings.tsx
   ```
   Se so aparecia na row removida, remover tambem o accessor `const embedPending = () => data()?.snapshot.embeddings_pending ?? 0;` (linha 305).

2. Verificar tsc:
   ```bash
   cd /home/opc/rustify-player && npx tsc --noEmit
   ```

---

## Task 9 — Remover botao de 0.4 qdrant Restart (manter row read-only)

**Files:** `src/views/Settings.tsx`

A set-row "qdrant process" FICA. So o `set-row__control` com o botao e removido.

### Steps

1. Localizar a set-row (linha ~622, ajustada). Remover apenas o `set-row__control`:
   ```tsx
   <div class="set-row__control">
     <button
       class="set-folder-btn"
       type="button"
       title="Backend pendente"
     >
       Restart…
     </button>
   </div>
   ```

   Resultado da set-row apos remocao:
   ```tsx
   <div class="set-row">
     <div>
       <div class="set-row__label">qdrant process</div>
       <div class="set-row__hint mono">localhost:6333 · vec-dim 1024 · status ok</div>
     </div>
   </div>
   ```

2. Verificar tsc:
   ```bash
   cd /home/opc/rustify-player && npx tsc --noEmit
   ```

---

## Task 10 — Remover botao de 0.8 Music folder Trocar (manter row read-only)

**Files:** `src/views/Settings.tsx`

A set-row "Music folder" FICA. So o `set-row__control` com o botao e seu `console.log` stub sao removidos.

### Steps

1. Localizar a set-row (linha ~563, ajustada). Remover o `set-row__control` inteiro:
   ```tsx
   <div class="set-row__control">
     <button
       class="set-folder-btn"
       type="button"
       title="Backend ainda nao oferece lib_set_library_path"
       onClick={() => console.log("[settings] TODO: invocar dialog.open() + lib_set_library_path quando backend expuser")}
     >
       {/* @ts-ignore */}
       <iconify-icon icon="lucide:folder-open" noobserver />
       Trocar…
     </button>
   </div>
   ```

   Resultado:
   ```tsx
   <div class="set-row">
     <div>
       <div class="set-row__label">Music folder</div>
       <div class="set-row__hint mono">~/Music/library</div>
     </div>
   </div>
   ```

2. Verificar tsc:
   ```bash
   cd /home/opc/rustify-player && npx tsc --noEmit
   ```

---

## Task 11 — Remover 0.5 botao disabled "Resume station" de Stations.tsx

**Files:** `src/views/Stations.tsx`

### Steps

1. Localizar o botao disabled (linha 273) e REMOVE-LO inteiro:
   ```tsx
   <button class="st-feature__cta" type="button" disabled>
     {/* @ts-ignore */}
     <iconify-icon icon="ph:play-fill" noobserver />
     Resume station
   </button>
   ```

   O empty-state (`.st-feature` fallback) fica com o texto explicativo "Stations aparecem aqui", sem botao. O CTA funcional ("Create first station") sera adicionado no Tier 2, depois que `handleNewFromCurrent` for corrigido pra usar a faixa atual + guard de "sem faixa tocando".

2. Verificar tsc:
   ```bash
   cd /home/opc/rustify-player && npx tsc --noEmit
   ```

---

## Task 12 — Atualizar teste legado Settings.test.tsx (linha 116) que valida controles removidos

**Files:** `src/views/Settings.test.tsx`

O teste existente na linha 116 valida explicitamente que "Crossfade", "Gapless" e "Output device" existem. Apos as remocoes, esse teste deve falhar e precisa ser atualizado para refletir o estado honesto pos-limpeza.

### Steps

1. Localizar o teste (linha 116):
   ```tsx
   it("Playback tem crossfade slider, gapless toggle, output device", () => {
     const { container, getByText } = render(() => <Settings />);
     expect(getByText("Crossfade")).toBeTruthy();
     expect(getByText(/Gapless/i)).toBeTruthy();
     expect(getByText(/Output device/i)).toBeTruthy();
     // Slider visivel
     expect(container.querySelector(".set-slider")).toBeTruthy();
   });
   ```

2. Substituir pelo teste que valida os controles vivos do painel Playback:
   ```tsx
   it("Playback tem volume slider, normalize toggle, resume on launch toggle", () => {
     const { container, getByText } = render(() => <Settings />);
     // Volume range
     expect(container.querySelector("input[type='range']")).toBeTruthy();
     // Normalizar row
     const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
     const normLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("normalizar"));
     expect(normLabel).toBeTruthy();
     // Resume on launch row
     const resumeLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("resume"));
     expect(resumeLabel).toBeTruthy();
     // Crossfade NAO existe
     const crossfadeLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("crossfade"));
     expect(crossfadeLabel).toBeUndefined();
     // Gapless NAO existe
     const gaplessLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("gapless"));
     expect(gaplessLabel).toBeUndefined();
     // Output device NAO existe
     const outputLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("output device"));
     expect(outputLabel).toBeUndefined();
   });
   ```

3. Rodar todos os testes de Settings:
   ```bash
   cd /home/opc/rustify-player && npx vitest run src/views/Settings.test.tsx
   ```
   Esperado: todos os testes passam agora, inclusive o novo describe "controles zumbi removidos".

---

## Task 13 — Rodar todos os testes e verificar criterios de aceite

**Files:** nenhum editado nessa task

### Steps

1. Rodar suite completa dos dois arquivos:
   ```bash
   cd /home/opc/rustify-player && npx vitest run src/views/Settings.test.tsx src/views/Stations.test.tsx
   ```
   Esperado: 100% passando.

2. Verificar criterio de aceite do plano mestre — zero ocorrencias das keys removidas no src:
   ```bash
   cd /home/opc/rustify-player && rg 'rustify-mock-gapless|rustify-mock-crossfade' src/
   ```
   Esperado: 0 ocorrencias.

3. Verificar zero console.log stub de settings:
   ```bash
   cd /home/opc/rustify-player && rg '\[settings\] TODO' src/
   ```
   Esperado: 0 ocorrencias.

4. Verificar que nenhuma set-row tem botao com atributo `disabled` no painel Playback/Library (nao deve existir botao nenhum la que seja disabled-stub):
   ```bash
   cd /home/opc/rustify-player && grep -n 'disabled>' src/views/Settings.tsx || echo "OK: zero disabled-stub"
   ```
   Resultados de disabled nos botoes de update flow sao ok (tem logica real). Verificar manualmente o contexto se algum aparecer.

5. Verificar tsc final:
   ```bash
   cd /home/opc/rustify-player && npx tsc --noEmit
   ```

---

## Task 14 — Commit

**Files:** `src/views/Settings.tsx`, `src/views/Settings.test.tsx`, `src/views/Stations.tsx`, `src/views/Stations.test.tsx`

### Steps

1. Verificar status:
   ```bash
   cd /home/opc/rustify-player && git status
   ```

2. Adicionar os 4 arquivos:
   ```bash
   cd /home/opc/rustify-player && git add src/views/Settings.tsx src/views/Settings.test.tsx src/views/Stations.tsx src/views/Stations.test.tsx
   ```

3. Commit:
   ```bash
   cd /home/opc/rustify-player && git commit -m "$(cat <<'EOF'
   fix(ui): remove 8 controles zumbi (Tier 0) — crossfade, gapless, output device, scrobble, generate embeddings, qdrant restart, music folder trocar, resume station disabled

   - Crossfade: remove slider, signal, handler, CROSSFADE_KEY (engine nao tem crossfade)
   - Gapless: remove toggle, signal, handler, GAPLESS_KEY (engine ja e sempre-gapless)
   - Output device: remove set-row inteira (switch de sink nao e feature do backend)
   - Scrobble Last.fm: remove set-row inteira (decisao: aversao documentada ao Last.fm)
   - Generate missing embeddings: remove botao, mantém row como stat read-only
   - qdrant Restart: remove botao, mantém row de status read-only
   - Music folder Trocar: remove botao com console.log stub, row fica read-only
   - Stations empty-state: remove botao disabled "Resume station" (CTA real vira Tier 2)

   Testes de regressao em Settings.test.tsx e Stations.test.tsx cobrem ausencia
   dos controles removidos e presenca dos controles vivos.

   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
   EOF
   )"
   ```

---

## Criterios de Aceite Final

| Criterio | Verificacao |
|----------|-------------|
| `rg 'rustify-mock-gapless\|rustify-mock-crossfade' src/` = 0 | Task 13, step 2 |
| `rg '\[settings\] TODO' src/` = 0 | Task 13, step 3 |
| Nenhuma set-row sem acao clicavel em Settings/Playback | Inspeção visual + testes de ausencia |
| `npx tsc --noEmit` sem erros | Cada task de remocao |
| `npx vitest run Settings.test.tsx Stations.test.tsx` = 100% | Task 13, step 1 |
| Botao "Resume station" disabled ausente no empty-state | Task 3 + Task 13 |
| Empty-state mantem o texto explicativo ("Stations aparecem aqui") | Task 3 |
