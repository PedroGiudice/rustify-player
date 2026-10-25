// Avaliação de design no app REAL da cmr-auto pela ponte MCP (websocket), para
// as skills do Impeccable. Tauri no Linux não tem CDP, então o `detect --cdp`
// do Impeccable não serve; aqui o detector é injetado por eval e a foto sai do
// comando `debug_capture_webview` (pixels do próprio WebKitGTK).
//
// Uso (na VM, com o túnel da ponte de pé; ver app_eval.sh):
//   node app_eval.mjs <porta> capture [full]        -> imprime o caminho do PNG na cmr-auto
//   node app_eval.mjs <porta> detect <detect.js>    -> imprime os achados em JSON
//   node app_eval.mjs <porta> js '<corpo de função>'
//
// A ponte corta script em 5 s: tudo que demora roda em segundo plano na página
// e é buscado depois por polling.

import { readFileSync } from 'node:fs';

const [, , port, mode, arg] = process.argv;
if (!port || !mode) {
  console.error('uso: node app_eval.mjs <porta> <capture [full]|detect <detect.js>|js <script>>');
  process.exit(2);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  const done = pending.get(m.id);
  if (done) { pending.delete(m.id); done(m); }
};
const run = (script, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = `ev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  pending.set(id, resolve);
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`ponte sem resposta em ${timeoutMs} ms`)); }, timeoutMs);
  ws.send(JSON.stringify({ command: 'execute_js', id, args: { script, windowLabel: 'main' } }));
});
const data = async (script, timeoutMs) => {
  const r = await run(script, timeoutMs);
  if (!r.success) throw new Error(r.error || 'execute_js falhou');
  return r.data;
};

// Dispara `expr` (uma Promise) em segundo plano e espera o resultado.
async function background(expr, waitMs = 60000) {
  await data(`window.__appEval = null; Promise.resolve().then(() => ${expr}).then(v => { window.__appEval = { ok: true, v }; }, e => { window.__appEval = { ok: false, e: String(e && e.stack || e) }; }); return true;`);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    const got = await data('const r = window.__appEval; if (r) window.__appEval = null; return r;');
    if (got) {
      if (!got.ok) throw new Error(got.e);
      return got.v;
    }
  }
  throw new Error(`sem resultado em ${waitMs} ms`);
}

await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`ponte fechada na porta ${port}`)); });
try {
  if (mode === 'capture') {
    const r = await background(`window.__TAURI__.core.invoke('debug_capture_webview', { fullDocument: ${arg === 'full'} })`);
    console.log(JSON.stringify(r));
  } else if (mode === 'detect') {
    // Sem autoScan: nada de overlay na tela do CEO; o app fica como estava.
    const src = readFileSync(arg, 'utf8');
    await data(`if (!window.impeccableDetectAsync) { window.__IMPECCABLE_CONFIG__ = { autoScan: false }; (0, eval)(${JSON.stringify(src)}); } return typeof window.impeccableDetectAsync;`, 60000);
    const findings = await background('window.impeccableDetectAsync({ visualContrast: true })', 120000);
    const meta = await data('return { route: location.pathname + location.hash, viewport: [innerWidth, innerHeight], zoom: getComputedStyle(document.documentElement).zoom };');
    console.log(JSON.stringify({ ...meta, findings }, null, 1));
  } else if (mode === 'js') {
    console.log(JSON.stringify(await data(arg)));
  } else {
    throw new Error(`modo desconhecido: ${mode}`);
  }
} finally {
  ws.close();
}
