// Ingestión: lee el repo de datos (fiscal-mexicano), genera embeddings con
// OpenAI y produce dos artefactos para subir a Cloudflare:
//
//   .data/vectors.ndjson   → wrangler vectorize upsert   (id + values + metadata)
//   .data/kv-pasajes.json  → wrangler kv bulk put        (registro confiable por id)
//
// Reemplaza a `rag indexar`. Porta load_corpus() de fiscal-rag/rag/corpus.py:
// el corpus es MULTI-DOCUMENTO (16 docs), así que recorre metadata/documentos.json
// y, por cada clave, metadata/<clave>/pasajes.jsonl. El texto que se indexa es
// `cita + texto` + el enriquecimiento de la unidad (igual que _search_text):
// el enriquecimiento mejora el recall pero NUNCA es fuente de cita (la cita sale
// de `texto`). El enriquecimiento está namespaced por documento y se une por
// `clave_unidad`.
//
// Uso:
//   OPENAI_API_KEY=sk-... node scripts/ingest.mjs [ruta-al-repo-de-datos]
//   (default: ../fiscal-mexicano)

import {
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  createWriteStream,
} from "node:fs";
import { once } from "node:events";
import { join } from "node:path";

const DATA_REPO = process.argv[2] ?? "../fiscal-mexicano";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";
const OPENAI_BASE = process.env.OPENAI_BASE ?? "https://api.openai.com/v1";
const API_KEY = process.env.OPENAI_API_KEY;
const OUT_DIR = ".data";
const BATCH = 100; // tamaño de lote para la API de embeddings

if (!API_KEY) {
  console.error("Falta OPENAI_API_KEY en el entorno.");
  process.exit(1);
}

// --- cargar el corpus multi-documento (port de rag/corpus.py::load_corpus) -- //
function loadDocumentos() {
  const file = join(DATA_REPO, "metadata", "documentos.json");
  if (!existsSync(file)) {
    console.error(`No existe ${file}. Corre el extractor primero.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, "utf-8")).documentos;
}

// Enriquecimiento de un documento: metadata/<clave>/generado/<unidad>.json,
// keyed por clave_unidad (el stem del archivo). Opcional y best-effort.
function loadEnrichment(clave) {
  const dir = join(DATA_REPO, "metadata", clave, "generado");
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(dir, f), "utf-8"));
    } catch {
      /* ignora archivos corruptos */
    }
  }
  return out;
}

// Recorre los documentos y une cada pasaje con el enriquecimiento de su unidad.
// Devuelve [{ pasaje, search }] en el orden del corpus.
function loadCorpus() {
  const items = [];
  for (const d of loadDocumentos()) {
    const clave = d.clave;
    const pasFile = join(DATA_REPO, "metadata", clave, "pasajes.jsonl");
    if (!existsSync(pasFile)) continue;
    const enrich = loadEnrichment(clave);
    for (const line of readFileSync(pasFile, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const p = JSON.parse(line);
      items.push({ pasaje: p, search: searchText(p, enrich[p.clave_unidad]) });
    }
  }
  return items;
}

// Réplica de _search_text en rag/corpus.py: cita + texto + términos de búsqueda.
function searchText(p, enrich) {
  const parts = [p.cita ?? "", p.texto];
  if (enrich) {
    parts.push(enrich.denominacion_comun ?? "");
    parts.push(...(enrich.temas ?? []));
    parts.push(...(enrich.terminos_coloquiales ?? []));
    parts.push(...(enrich.preguntas_ejemplo ?? []));
  }
  return parts.filter(Boolean).join("\n");
}

// --- embeddings ------------------------------------------------------------- //
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Reintenta ante fallos transitorios (red, 429, 5xx) con backoff exponencial,
// para que un blip de la API no tumbe todo el reindex (el corpus fiscal es
// grande → muchos lotes). Los 4xx (salvo 429) no se reintentan: son reales.
async function embedBatch(texts, intentos = 5) {
  let espera = 1000;
  for (let i = 1; ; i++) {
    let r = null;
    try {
      r = await fetch(`${OPENAI_BASE}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      });
    } catch (e) {
      if (i >= intentos) throw e;
    }
    if (r && r.ok) {
      const j = await r.json();
      return j.data.map((d) => d.embedding);
    }
    const transitorio = !r || r.status === 429 || r.status >= 500;
    if (!transitorio || i >= intentos) {
      throw new Error(`embeddings ${r ? r.status : "network"} (intento ${i}): ${r ? await r.text() : "fetch failed"}`);
    }
    const retryAfter = r?.headers.get("retry-after");
    const wait = retryAfter ? Number(retryAfter) * 1000 : espera;
    console.warn(`  ⚠ embeddings ${r ? r.status : "network"}; reintento ${i}/${intentos - 1} en ${wait}ms`);
    await sleep(wait);
    espera = Math.min(espera * 2, 30000);
  }
}

// --- main ------------------------------------------------------------------- //
const corpus = loadCorpus();
console.log(`${corpus.length} pasajes (de los documentos en documentos.json).`);

// Escritura en STREAMING: con 27 k vectores (~26 KB/línea) el archivo ronda
// ~700 MB; acumular y `Array.join` revienta el límite de string de V8
// (RangeError: Invalid string length). Escribimos línea por línea y honramos
// backpressure (`drain`) para acotar la memoria.
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const vecStream = createWriteStream(join(OUT_DIR, "vectors.ndjson"));
const kvStream = createWriteStream(join(OUT_DIR, "kv-pasajes.json"));

async function write(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

kvStream.write("["); // kv-pasajes.json es un arreglo JSON
let nVec = 0;
let kvFirst = true;

for (let i = 0; i < corpus.length; i += BATCH) {
  const slice = corpus.slice(i, i + BATCH);
  const vectors = await embedBatch(slice.map((c) => c.search));

  for (let j = 0; j < slice.length; j++) {
    const p = slice[j].pasaje;
    await write(
      vecStream,
      JSON.stringify({
        id: p.id,
        values: vectors[j],
        metadata: { documento: p.documento, clave_unidad: p.clave_unidad },
      }) + "\n",
    );
    nVec++;
    // El registro completo va a KV: de aquí salen las citas verificables.
    await write(kvStream, (kvFirst ? "" : ",") + JSON.stringify({ key: p.id, value: JSON.stringify(p) }));
    kvFirst = false;
  }
  console.log(`  embebidos ${Math.min(i + BATCH, corpus.length)}/${corpus.length}`);
}

kvStream.write("]");
vecStream.end();
kvStream.end();
await Promise.all([once(vecStream, "finish"), once(kvStream, "finish")]);

console.log(`\n✓ ${OUT_DIR}/vectors.ndjson  (${nVec} vectores)`);
console.log(`✓ ${OUT_DIR}/kv-pasajes.json (${nVec} registros)`);
console.log("\nAhora súbelos (wrangler trocea internamente los lotes):");
console.log("  npm run upload:vectors");
console.log("  npm run upload:kv");
