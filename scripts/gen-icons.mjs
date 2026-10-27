#!/usr/bin/env node
/* ============================================================
   scripts/gen-icons.mjs — subconjunto Lucide do boot (A25).

   O boot registrava a coleção Lucide inteira (566 KB de JSON para
   ~65 ícones usados). Este script varre o código, coleta todo nome
   `lucide:<nome>` escrito como texto e grava em src/icons-subset.json
   só esses ícones (com os aliases resolvidos: `more-horizontal` é
   alias de `ellipsis`). Continua offline, sem CDN.

   Onde procura:
     - src/**\/*.ts(x), fora testes: ICONS do components/Icon.tsx,
       `icon="lucide:..."` dos <iconify-icon> e listas de dados;
     - src-tauri/src/**\/*.rs: nomes que o BACKEND entrega em tempo de
       execução (ícone da station, `lucide:radio` / `lucide:sparkles`).
   Nome montado em tempo de execução (`lucide:${x}`) não é encontrado:
   o script FALHA se achar esse padrão, para ninguém descobrir pelo
   quadrado vazio. Ícone que só chega por dado externo vai em EXTRA.

   Uso:
     node scripts/gen-icons.mjs          # regrava src/icons-subset.json
     node scripts/gen-icons.mjs --check  # falha se o arquivo está velho
   O `npm run build` roda o modo de escrita antes do vite build; nome
   que não existe na coleção derruba o build.

   O S24 não usa Iconify (src/mobile/icons.tsx, SVG inline): nada aqui
   o afeta.
   ============================================================ */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/icons-subset.json");
const COLLECTION = join(ROOT, "node_modules/@iconify-json/lucide/icons.json");

/** Ícones que só chegam por dado externo (nenhum hoje: as stations no
    disco da cmr-auto usam `lucide:sparkles`, que o desktop.rs já cita). */
const EXTRA = [];

const SCAN = [
  { dir: "src", exts: [".ts", ".tsx"] },
  { dir: "src-tauri/src", exts: [".rs"] },
];
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "gen", "mobile"]);
const isTest = (p) => /\.test\.(ts|tsx)$/.test(p) || p.includes("__fixtures__");

const NAME_RE = /lucide:([a-z0-9]+(?:-[a-z0-9]+)*)/g;
// `lucide:${...}`, "lucide:" + x, 'lucide:' + x
const DYNAMIC_RE = /lucide:\$\{|["'`]lucide:["'`]\s*\+/;

function walk(dir, exts, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, exts, out);
    } else if (exts.some((e) => name.endsWith(e)) && !isTest(p)) {
      out.push(p);
    }
  }
  return out;
}

function collectNames() {
  const names = new Map(); // nome -> primeiro arquivo onde aparece
  const dynamic = [];
  for (const { dir, exts } of SCAN) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs, exts, [])) {
      const txt = readFileSync(file, "utf8");
      const rel = relative(ROOT, file);
      txt.split("\n").forEach((line, i) => {
        if (DYNAMIC_RE.test(line)) dynamic.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
      for (const m of txt.matchAll(NAME_RE)) {
        if (!names.has(m[1])) names.set(m[1], rel);
      }
    }
  }
  for (const n of EXTRA) if (!names.has(n)) names.set(n, "EXTRA");
  return { names, dynamic };
}

function buildSubset(names) {
  const col = JSON.parse(readFileSync(COLLECTION, "utf8"));
  const icons = {};
  const aliases = {};
  const missing = [];
  const addIcon = (n) => {
    if (col.icons[n]) {
      icons[n] = col.icons[n];
      return true;
    }
    const a = col.aliases?.[n];
    if (!a) return false;
    aliases[n] = a;
    return addIcon(a.parent);
  };
  for (const [n, where] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
    if (!addIcon(n)) missing.push(`${n} (${where})`);
  }
  const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const subset = {
    prefix: col.prefix,
    icons: sortObj(icons),
    ...(Object.keys(aliases).length ? { aliases: sortObj(aliases) } : {}),
    width: col.width,
    height: col.height,
  };
  return { subset, missing };
}

const check = process.argv.includes("--check");
const { names, dynamic } = collectNames();
if (dynamic.length) {
  console.error("[gen-icons] nome Lucide montado em tempo de execução (não dá para subconjuntar):");
  for (const d of dynamic) console.error("  " + d);
  console.error("  Use o nome inteiro como texto, ou acrescente os possíveis em EXTRA.");
  process.exit(1);
}
const { subset, missing } = buildSubset(names);
if (missing.length) {
  console.error("[gen-icons] nomes que não existem na coleção Lucide instalada:");
  for (const m of missing) console.error("  " + m);
  process.exit(1);
}
const json = JSON.stringify(subset) + "\n";
const kb = (Buffer.byteLength(json) / 1024).toFixed(1);
if (check) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (cur !== json) {
    console.error("[gen-icons] src/icons-subset.json desatualizado: rode `node scripts/gen-icons.mjs`.");
    process.exit(1);
  }
  console.log(`[gen-icons] ok: ${names.size} nomes, ${kb} KB`);
} else {
  writeFileSync(OUT, json);
  console.log(`[gen-icons] ${names.size} nomes -> src/icons-subset.json (${kb} KB)`);
}
