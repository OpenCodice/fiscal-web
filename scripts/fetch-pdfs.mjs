// Descarga los PDF oficiales de cada documento del corpus a .data/pdfs/<clave>.pdf,
// para subirlos luego a R2 (bucket fiscal-pdf) y servirlos en /pdf/<clave>.pdf.
//
// La URL de cada PDF se toma del propio corpus (campo `url_fuente` del primer
// pasaje de cada documento), así no se duplica el registro de fuentes.
//
// NOTA sobre las coordenadas: el repo de datos NO versiona los PDF (a diferencia
// de constitucion-mexicana). Los rects de resaltado se calcularon contra el PDF
// oficial al momento de extraer. Descargar aquí el PDF vigente puede, en teoría,
// desalinear el resaltado si la fuente cambió desde la última extracción; corre
// esto junto con la reingesta, poco después de que el watcher actualice el texto.
//
// Uso:
//   node scripts/fetch-pdfs.mjs [ruta-al-repo-de-datos]   (default: ../fiscal-mexicano)

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_REPO = process.argv[2] ?? "../fiscal-mexicano";
const OUT_DIR = join(".data", "pdfs");
const UA = "Mozilla/5.0 (fiscal-web; descarga de PDF oficial)";

function documentos() {
  const file = join(DATA_REPO, "metadata", "documentos.json");
  if (!existsSync(file)) {
    console.error(`No existe ${file}. Corre el extractor primero.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, "utf-8")).documentos;
}

// url_fuente del primer pasaje del documento (todas las líneas comparten la misma).
function urlFuente(clave) {
  const file = join(DATA_REPO, "metadata", clave, "pasajes.jsonl");
  if (!existsSync(file)) return null;
  const first = readFileSync(file, "utf-8").split("\n").find((l) => l.trim());
  if (!first) return null;
  return JSON.parse(first).url_fuente ?? null;
}

mkdirSync(OUT_DIR, { recursive: true });

let ok = 0;
let fail = 0;
for (const d of documentos()) {
  const url = urlFuente(d.clave);
  if (!url) {
    console.warn(`· ${d.clave}: sin pasajes/url, se omite`);
    continue;
  }
  try {
    const r = await fetch(url, { headers: { "user-agent": UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(join(OUT_DIR, `${d.clave}.pdf`), buf);
    console.log(`↓ ${d.clave}.pdf  (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
    ok++;
  } catch (e) {
    console.error(`✗ ${d.clave}: ${e instanceof Error ? e.message : e}`);
    fail++;
  }
}

console.log(`\n✓ ${ok} PDF en ${OUT_DIR}/  (${fail} fallidos)`);
if (ok === 0) process.exit(1);
