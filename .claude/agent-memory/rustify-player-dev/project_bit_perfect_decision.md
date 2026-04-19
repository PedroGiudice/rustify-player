---
name: Bit-perfect descartado como feature
description: OutputMode::BitPerfect foi decidido como INUTIL pelo usuario. UI nao expoe. Enum nao deve ter a variante.
type: project
---

Bit-perfect mode foi explicitamente descartado como feature.

**Why:** Usuario usa EasyEffects diariamente e decidiu que nao vale abrir mao do EQ/DSP pela "pureza" do sinal. Decisao tomada em sessao 2026-04-18 ("deixa bit perfect de lado, porque eu não acho que vale a pena abrir mão do EQ pra isso") e reafirmada como "INUTIL" em 2026-04-19.

**How to apply:**
- `OutputMode` nao deve ter variante `BitPerfect`. So `System` (que e passthrough normal do graph via PipeWire AUTOCONNECT, passando pelo EasyEffects se estiver ativo).
- UI de Settings NAO mostra toggle de bit-perfect nem device picker. Usuario que quer redirecionar usa `pavucontrol` ou equivalente do sistema.
- Se precisar de "debug path" pra isolar "bug do player vs bug do PipeWire", usar outro mecanismo (env var, CLI flag booleano) — nao re-adicionar ao enum.
- Comparacoes com Spotify/YT Music sao invalidas (streaming) — comparar com Harmonoid (libmpv) ou Lollypop (GStreamer), que tambem nao expoem device picker porque terceirizam decisao pra lib alto-nivel.
