# Retomada: design "app full pro" (auth, JWT, hardening) + validações pendentes

## Contexto rápido

Sessão de 2026-07-17 shipou 4 releases (0.2.53→0.2.56): beat-sync PLL do
/design implementado, regressão diagnosticada por medição (emitter de FFT
colapsava de 60 pra 7 Hz — dedup fraco, consertado), chip de origem da fila na
PlayerBar (station/playlist/álbum/rádio/solta), paleta alternante do bg (top-3
cores da capa, ciclo 40s) e — por feedback do usuário — beat-sync virou modos
**Off/Speed/Pulse com Speed default** (o comportamento clássico de acelerar o
movimento, agora sobre sinal são). Curadoria de 4 gêneros aprovada (61 itens,
359 faixas em CSV na cmr-auto), mas o download foi pausado: a rede Soulseek
penalizou o burst de searches (gotchas documentados no CLAUDE.md).

**A tarefa PRINCIPAL desta sessão** (ordem do usuário: "próxima sessão é tua"):
**propor o que fazer pra tornar o app "full pro" — auth, JWT, etc.** É trabalho
de DESIGN/arquitetura, não de implementação imediata: mapear o que "pro"
significa pra um player desktop Tauri local single-user, produzir uma spec com
recomendação forte, e alinhar escopo antes de codar.

<session_metadata>
branch: main
last_commit: a4f4bb4 (v0.2.56 — publicada, usuário ainda na 0.2.55)
design_project_id: c5cabb56-e85e-4944-a8af-65fbe978188b
leva_csv: cmr-auto:~/leva-curadoria-0717.csv (359 faixas, download pausado)
subagent_model: sonnet default; usuário pediu OPUS pra curadoria/design pesado
</session_metadata>

## Arquivos principais

- `docs/contexto/17072026-beat-modes-paleta-curadoria.md` — contexto denso desta sessão
- `CLAUDE.md` — gotchas novos do slskd (409/throttle/pkill) na seção music-curator
- `src/lib/beatPll.ts` — beat-sync (Speed/Pulse) com calibração medida
- `src/lib/adaptiveInk.ts` — paleta alternante (ciclo 40s)
- `docs/curadoria/2026-07-17-leva-trap-funk-jazz-rock.md` — leva aprovada
- `docs/superpowers/specs/2026-07-12-session-awareness-design.md` — Fases 1-3 pendentes

## Próximos passos (por prioridade)

### 1. Design "app full pro" (auth, JWT, hardening, distribuição)
**Onde:** trabalho de arquitetura; produto final em
`docs/superpowers/specs/2026-07-17-full-pro-design.md` (ou data do dia).
**O que:** o pedido é aberto de propósito ("auth, jwt, etc"). Antes de propor,
LEVANTAR a superfície real do app hoje — candidatos concretos a "pro":
  (a) **Hardening do que já existe**: MCP bridge `:9223` aberto na tailnet SEM
      auth (qualquer nó da tailnet executa JS/IPC no app — avaliar risco real);
      Qdrant sidecar `:6333` local; permissões do Tauri (CSP, scopes de fs).
  (b) **Modo servidor + clientes remotos**: streaming da biblioteca pra outros
      devices (mobile/web) com auth de verdade — JWT RS256 como nos MCPs da VM
      (`case-knowledge-api` é o precedente da casa), refresh, device pairing.
  (c) **Multi-usuário/contas + sync**: perfis, sync de play_events/likes entre
      instalações (o Qdrant é local por design — sync é problema real).
  (d) **Distribuição pro**: updater assinado (tauri-plugin-updater + chave), CI
      de release, crash reporting, telemetria opt-in, empacotamento além do .deb.
Usar workflow de design (padrão que funcionou no session-awareness: N propostas
independentes × painel de juízes × síntese — subagentes Opus se o usuário
mantiver a ordem). Entregar com RECOMENDAÇÃO e faseamento, não menu.
**Por que:** pedido explícito do usuário; decisões aqui são de produto — escalar
com recomendação antes de implementar.
**Verificar:** spec commitada + aprovação explícita do usuário no escopo/fases.

### 2. Lembrar o usuário de instalar a v0.2.57 e validar Speed + deriva do ciclo
**Onde:** cmr-auto (usuário executa):
`gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.57_amd64.deb` + fechar/abrir.
**O que:** Speed é o default novo do beat-sync ("mais agressivo, mas melhor" —
feedback dele); se quiser mais punch, Tweaks → Beat depth → Strong. E a
transição do ciclo da paleta agora é deriva lenta (tau 3.5s via
--bg-ink-morph) — ele reclamou de "bruta" na 0.2.55; validar a sutileza.
**Por que:** 0.2.56+0.2.57 são resposta direta a dois feedbacks dele.
**Verificar:** feedback subjetivo + probe MCP (--bg-ink-rgb derivando ao longo
de ~10s após o tick de 40s).

### 3. Re-rodar a leva de downloads quando a penalidade da rede expirar
**Onde:** cmr-auto via SSH.
**O que:** (i) testar a rede: 1 busca manual via API slskd com sleep 12s —
0 responses = ainda penalizado, esperar mais; (ii) limpar searches acumuladas
(gotcha no CLAUDE.md); (iii) relançar:
```bash
ssh -f cmr-auto@100.102.249.9 'bash -lc "cd ~ && PYTHONUNBUFFERED=1 setsid nohup uv run --with slskd-api --with mutagen baixar_soulseek_teste.py --csv ~/leva-curadoria-0717.csv --retry-all >> ~/leva-curadoria-0717.log 2>&1 < /dev/null"'
```
Monitorar por `~/slskd_dados/downloads/` (fonte de verdade), não pelo log.
**Por que:** 359 faixas aprovadas paradas; a run anterior queimou em vazio.
**Verificar:** FLACs novos em downloads/ + `grep -c ENQUEUED` crescendo.

### 4. Herdadas: session-awareness Fases 1-3 e validação do motor v2
**Onde:** specs referenciadas acima. Sem mudança de estado desde 12/07 — o
usuário já validou qualitativamente as stations ("funcionou, mesmo com poucas
tracks").

## Como verificar (ambiente)

```bash
cd /home/opc/rustify-player
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -1   # Finished
npm run typecheck 2>&1 | tail -1                                   # sem erro
npx vitest run 2>&1 | tail -1                                      # 208 passed
ssh cmr-auto@100.102.249.9 'curl -s localhost:6333/collections/rustify_tracks | python3 -c "import json,sys; print(json.load(sys.stdin)[\"result\"][\"points_count\"])"'  # ~1378 (cresce com a leva)
```

## Restrições (não esquecer)

- Código só tem efeito na cmr-auto após `./scripts/release.sh` + dpkg PELO
  USUÁRIO + restart. Lembrar o comando SEMPRE.
- Design full-pro: decisões de produto/custo/escopo → escalar com recomendação,
  não menu. Precedente JWT da casa: `case-knowledge-api` (RS256, Bearer).
- Track IDs u64 viajam como STRING; nunca as_i64.
- Validar no app real via MCP bridge (`100.102.249.9:9223`, app aberto) —
  medir, não presumir (esta sessão provou o valor disso 3x).
- Nunca restaurar o EQ warm-tilt. CSS só em extractor-lab.css.
- slskd: ver gotchas novos no CLAUDE.md antes de mexer em downloads.
