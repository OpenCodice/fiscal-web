// Regenera SOLO .data/kv-pasajes.json desde el repo de datos, sin tocar
// embeddings ni vectores. Para cambios que solo alteran el registro KV de los
// pasajes (p. ej. el campo `referencias`): el texto indexado no cambió, así
// que re-embeber sería puro costo.
//
// Uso:
//   node scripts/kv-refresh.mjs [ruta-al-repo-de-datos]   (default: ../fiscal-mexicano)
//   npm run upload:kv

import { readFileSync, mkdirSync, existsSync, createWriteStream } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";

const DATA_REPO = process.argv[2] ?? "../fiscal-mexicano";
const OUT_DIR = ".data";

const docsFile = join(DATA_REPO, "metadata", "documentos.json");
if (!existsSync(docsFile)) {
  console.error(`No existe ${docsFile}. Corre el extractor primero.`);
  process.exit(1);
}
const documentos = JSON.parse(readFileSync(docsFile, "utf-8")).documentos;

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const kvStream = createWriteStream(join(OUT_DIR, "kv-pasajes.json"));
const write = async (chunk) => {
  if (!kvStream.write(chunk)) await once(kvStream, "drain");
};

kvStream.write("[");
let n = 0;
for (const d of documentos) {
  const pasFile = join(DATA_REPO, "metadata", d.clave, "pasajes.jsonl");
  if (!existsSync(pasFile)) continue;
  for (const line of readFileSync(pasFile, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const p = JSON.parse(line);
    await write((n ? "," : "") + JSON.stringify({ key: p.id, value: JSON.stringify(p) }));
    n++;
  }
}
kvStream.write("]");
kvStream.end();
await once(kvStream, "finish");
console.log(`✓ ${OUT_DIR}/kv-pasajes.json (${n} registros). Sube con: npm run upload:kv`);
