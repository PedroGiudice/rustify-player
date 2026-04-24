---
name: Cork PipeWire fix para xruns na pausa
description: Fix implementado em 2026-04-20 — raw pointer pro stream resolve lifetime 'static do closure sem Rc
type: project
---

Xruns fantasma durante pausa foram resolvidos com cork real do stream PipeWire (`pw_stream_set_active`).

**Why:** O callback `process` continuava rodando a cada quantum (~5ms) durante pausa, ring buffer vazio = xrun por callback. Cork para os callbacks.

**How to apply:** O `StreamBox<'c>` tem lifetime tied ao `Core` local, entao `Rc<StreamBox>` nao satisfaz `'static` exigido pelo closure de `cmd_rx.attach`. Solucao: extrair `stream.as_raw_ptr()` (*mut pw_sys::pw_stream) antes do closure — raw pointers sao `'static`. Safety garantida porque o stream outlives o mainloop. Comunicacao engine->mainloop via `pw::channel::Sender<Cmd>` clonado, exposto como `set_cork: Option<Box<dyn Fn(bool) + Send>>` no `ActiveStream`.
