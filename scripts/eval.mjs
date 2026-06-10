// Set de regresión del RAG: hace las preguntas de eval/preguntas.jsonl contra
// /api/preguntar y verifica que la respuesta contenga los datos duros esperados
// (verificados a mano contra el texto de ley en fiscal-mexicano) y que al menos
// una cita venga del documento correcto.
//
// Las expectativas codifican el estado DESEADO: una pregunta que falla señala
// un hueco real de recuperación o de respuesta, no un test mal escrito.
//
// Uso:
//   node scripts/eval.mjs [--base https://sat.constitucion.app] [--solo N] [--file ruta.jsonl]
//
// El endpoint admite 10 preguntas/minuto por IP; el runner se espacia solo.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const BASE = flag("--base") ?? "https://sat.constitucion.app";
const SOLO = flag("--solo") ? Number(flag("--solo")) : null;
const PAUSA_MS = 6500; // 10/min de rate limit en /api/preguntar

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const casos = readFileSync(flag("--file") ?? join(root, "eval", "preguntas.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

async function preguntar(pregunta) {
  const r = await fetch(`${BASE}/api/preguntar`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // El WAF de Cloudflare bloquea user-agents de librerías HTTP (error 1010).
      "user-agent": "Mozilla/5.0 fiscal-web-eval/1.0",
    },
    body: JSON.stringify({ pregunta }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const tokens = [];
  let citas = [];
  for (const line of (await r.text()).split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.t === "token") tokens.push(ev.v);
    else if (ev.t === "citas") citas = ev.v.map((c) => c.id);
    else if (ev.t === "error") throw new Error(`api: ${ev.v}`);
  }
  return { respuesta: tokens.join("").trim(), citas };
}

function evaluar(caso, { respuesta, citas }) {
  const fallos = [];
  for (const pat of caso.espera) {
    if (!new RegExp(pat, "i").test(respuesta)) fallos.push(`respuesta sin /${pat}/`);
  }
  if (caso.citas_alguna?.length) {
    const ok = citas.some((id) => caso.citas_alguna.some((p) => id.startsWith(p)));
    if (!ok) fallos.push(`citas [${citas.join(", ") || "ninguna"}] sin ${caso.citas_alguna.join("|")}`);
  }
  return fallos;
}

const seleccion = SOLO ? [casos[SOLO - 1]] : casos;
let fallidas = 0;
for (const [i, caso] of seleccion.entries()) {
  const n = SOLO ?? i + 1;
  let fallos;
  let detalle = "";
  try {
    const res = await preguntar(caso.pregunta);
    fallos = evaluar(caso, res);
    detalle = fallos.length ? `\n    respuesta: ${res.respuesta.slice(0, 200)}` : "";
  } catch (e) {
    fallos = [`error: ${e.message}`];
  }
  if (fallos.length) {
    fallidas++;
    console.log(`✗ [${n}] ${caso.pregunta}`);
    for (const f of fallos) console.log(`    ${f}`);
    if (detalle) console.log(detalle);
    console.log(`    nota: ${caso.nota}`);
  } else {
    console.log(`✓ [${n}] ${caso.pregunta}`);
  }
  if (i < seleccion.length - 1) await new Promise((r) => setTimeout(r, PAUSA_MS));
}

console.log(`\n${seleccion.length - fallidas}/${seleccion.length} correctas`);
process.exit(fallidas ? 1 : 0);
