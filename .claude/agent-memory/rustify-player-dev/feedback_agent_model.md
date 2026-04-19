---
name: Agent model preference — opus 4.6
description: Quando spawnar sub-agentes via Agent tool, usar exclusivamente opus 4.6. Nunca opus 4.7.
type: feedback
---

Ao spawnar sub-agentes (Agent tool) para este projeto, passar sempre `model: "claude-opus-4-6[1m]"`.

**Why:** Usuario prefere opus 4.6 sobre 4.7. Default do harness pode resolver `model: "opus"` para 4.7; passar a string exata `claude-opus-4-6[1m]` evita ambiguidade.

**How to apply:** Em toda invocacao do tool `Agent` (ou `Task`) neste projeto, incluir parametro `model: "claude-opus-4-6[1m]"`. Nao usar `model: "opus"` (ambiguo) nem `model: "inherit"` (falha silenciosa). A preferencia vale mesmo quando o subagent_type tem model frontmatter — o parametro explicito sobrescreve.
