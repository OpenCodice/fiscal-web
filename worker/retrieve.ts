import type { Env, Pasaje } from "./types";
import { vigente } from "./vigente";

export interface Hit extends Pasaje {
  _score: number;
}

/** Embeddings de uno o más textos con OpenAI (mismo modelo que la ingestión). */
async function embedAll(env: Env, texts: string[]): Promise<number[][]> {
  const base = env.OPENAI_BASE ?? "https://api.openai.com/v1";
  const r = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.EMBED_MODEL ?? "text-embedding-3-small",
      input: texts,
    }),
  });
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { data: { embedding: number[] }[] };
  return j.data.map((d) => d.embedding);
}

export async function embed(env: Env, text: string): Promise<number[]> {
  return (await embedAll(env, [text]))[0];
}

// Las preguntas vienen en lenguaje cotidiano ("tasa general del IVA", "pañales")
// y los pasajes en lenguaje de ley ("el impuesto se calculará aplicando la tasa
// del 16%"); con un solo vector la pregunta coloquial queda lejos del artículo
// base y los reglamentos/criterios la ahogan. El pasaje hipotético acerca la
// query al vocabulario estatutario (HyDE).
const EXPAND_PROMPT =
  "Ayudas a un buscador semántico de legislación fiscal mexicana (leyes, " +
  "reglamentos, RMF, criterios del SAT). Escribe el pasaje hipotético de ley " +
  "que respondería la pregunta del usuario: 1 o 2 oraciones redactadas con el " +
  "vocabulario técnico de las leyes fiscales (p. ej. 'comprobante fiscal' por " +
  "'factura', 'enajenación' por 'venta', 'gratificación anual' por 'aguinaldo', " +
  "'el impuesto se calculará aplicando la tasa de X%' por 'cuánto se paga'). " +
  "No menciones números de artículo. Devuelve solo ese texto, sin explicación.";

/** Reformulación estatutaria de la pregunta. Best-effort: null si falla. */
async function expandQuery(env: Env, pregunta: string): Promise<string | null> {
  const base = env.OPENAI_BASE ?? "https://api.openai.com/v1";
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        // Utilitaria y barata a propósito: no sigue a CHAT_MODEL (el modelo de
        // respuesta puede ser caro; reformular no lo amerita).
        model: "gpt-4o-mini",
        max_tokens: 120,
        temperature: 0,
        messages: [
          { role: "system", content: EXPAND_PROMPT },
          { role: "user", content: pregunta },
        ],
      }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Recupera los k pasajes más relevantes y vigentes.
 *
 * Consulta Vectorize con dos vectores —la pregunta tal cual y su reformulación
 * estatutaria— y fusiona los rankings por RRF: un pasaje que ambas listas
 * colocan arriba gana, y la reformulación rescata los artículos base que el
 * vocabulario coloquial no alcanza. Si la reformulación falla, se degrada a la
 * consulta simple.
 *
 * Vectorize sólo guarda vectores → devuelve ids. El texto/cita se hidrata desde
 * KV (registro confiable). Sobre-pedimos topK y filtramos por vigencia en el
 * Worker usando el dato real de KV (evita índices de metadata mientras todos los
 * pasajes son vigentes; ver README).
 */
export async function retrieve(
  env: Env,
  pregunta: string,
  k: number,
  asOf: string | null,
): Promise<Hit[]> {
  const expansion = await expandQuery(env, pregunta);
  const queries = expansion ? [pregunta, expansion] : [pregunta];
  const vecs = await embedAll(env, queries);
  const topK = Math.min(k * 4, 100);
  const results = await Promise.all(
    vecs.map((v) => env.VECTORIZE.query(v, { topK, returnMetadata: "none" })),
  );

  // RRF (1/(60+rango)) ordena; el coseno máximo entre listas se reporta como
  // score (los valores RRF no significan nada para el consumidor).
  const rrf = new Map<string, number>();
  const cos = new Map<string, number>();
  for (const res of results) {
    res.matches.forEach((m, i) => {
      rrf.set(m.id, (rrf.get(m.id) ?? 0) + 1 / (60 + i));
      cos.set(m.id, Math.max(cos.get(m.id) ?? 0, m.score));
    });
  }
  const ids = [...rrf.keys()]
    .sort((a, b) => rrf.get(b)! - rrf.get(a)!)
    .slice(0, topK);

  const records = await Promise.all(ids.map((id) => env.PASAJES.get<Pasaje>(id, "json")));

  const hits: Hit[] = [];
  for (const rec of records) {
    if (!rec) continue; // id huérfano (índice y KV desincronizados)
    if (!vigente(rec, asOf)) continue;
    hits.push({ ...rec, _score: cos.get(rec.id) ?? 0 });
    if (hits.length >= k) break;
  }
  return hits;
}

const numeroParrafo = (id: string) => Number(id.match(/\.p(\d+)$/)?.[1] ?? 0);

const _sinAcentos = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Palabras con carga semántica de la pregunta (≥5 letras, sin acentos). */
function palabrasClave(pregunta: string): string[] {
  return [...new Set(_sinAcentos(pregunta).split(/[^a-zñ]+/).filter((w) => w.length >= 5))];
}

/** Párrafos de una unidad, hidratados de KV en orden de párrafo. */
async function parrafosDeUnidad(
  env: Env,
  unidad: string,
  asOf: string | null,
  excepto: Set<string>,
): Promise<Hit[]> {
  const { keys } = await env.PASAJES.list({ prefix: `${unidad}.p` });
  const ids = keys
    .map((k) => k.name)
    .filter((id) => !excepto.has(id))
    .sort((a, b) => numeroParrafo(a) - numeroParrafo(b));
  const recs = await Promise.all(ids.map((id) => env.PASAJES.get<Pasaje>(id, "json")));
  return recs
    .filter((r): r is Pasaje => !!r && vigente(r, asOf))
    .map((r) => ({ ...r, _score: 0 }));
}

/**
 * Preguntas-lista: los artículos largos (2-A LIVA, 27 LISR) están partidos por
 * fracción y el top-k trae incisos sueltos — el LLM responde con el pedazo que
 * vio. Cuando una unidad aporta ≥minHits pasajes, se considera que la pregunta
 * va sobre ese artículo y se hidratan de KV sus párrafos faltantes (los ids
 * comparten el prefijo `documento/unidad.p`). Los pasajes recuperados nunca se
 * recortan; los añadidos entran por orden de párrafo hasta maxTotal.
 */
export async function expandUnidades(
  env: Env,
  hits: Hit[],
  asOf: string | null,
  minHits = 3,
  maxTotal = 40,
): Promise<Hit[]> {
  const porUnidad = new Map<string, Hit[]>();
  for (const h of hits) {
    const u = `${h.documento}/${h.clave_unidad}`;
    porUnidad.set(u, [...(porUnidad.get(u) ?? []), h]);
  }
  const expandibles = [...porUnidad.keys()].filter((u) => porUnidad.get(u)!.length >= minHits);
  if (!expandibles.length) return hits;

  const have = new Set(hits.map((h) => h.id));
  const faltantes = new Map<string, Hit[]>();
  await Promise.all(
    expandibles.map(async (u) => {
      faltantes.set(u, await parrafosDeUnidad(env, u, asOf, have));
    }),
  );

  // Presupuesto de añadidos repartido por orden de aparición en el ranking;
  // dentro de la unidad ganan los párrafos más tempranos (las listas abren
  // con la regla y sus primeros incisos).
  let presupuesto = maxTotal - hits.length;
  const out: Hit[] = [];
  const emitido = new Set<string>();
  for (const h of hits) {
    if (emitido.has(h.id)) continue;
    const u = `${h.documento}/${h.clave_unidad}`;
    const extra = faltantes.get(u);
    if (!extra) {
      emitido.add(h.id);
      out.push(h);
      continue;
    }
    faltantes.delete(u);
    const usados = extra.slice(0, Math.max(0, presupuesto));
    presupuesto -= usados.length;
    const completos = [...porUnidad.get(u)!, ...usados].sort(
      (a, b) => numeroParrafo(a.id) - numeroParrafo(b.id),
    );
    for (const c of completos) {
      if (emitido.has(c.id)) continue;
      emitido.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/**
 * Fuente primaria por referencia cruzada: los criterios/reglas citan en su
 * texto al artículo de ley que desarrollan y el corpus trae esas citas ya
 * resueltas (`referencias`, capa derivada de fiscal-mexicano). Sin esto, el
 * RAG recupera al satélite que parafrasea y el artículo de ley nunca llega al
 * contexto. De cada unidad referida entran sus primeros párrafos (la regla
 * general abre el artículo) más los que comparten vocabulario con la pregunta
 * (en un artículo-lista largo, la fracción relevante vive adentro).
 */
export async function expandReferencias(
  env: Env,
  pregunta: string,
  hits: Hit[],
  asOf: string | null,
  maxRefs = 6,
  porUnidad = 8,
  maxTotal = 48,
): Promise<Hit[]> {
  const presentes = new Set(hits.map((h) => `${h.documento}/${h.clave_unidad}`));
  const refs: string[] = [];
  for (const h of hits) {
    for (const r of h.referencias ?? []) {
      if (!presentes.has(r) && !refs.includes(r)) refs.push(r);
    }
  }
  if (!refs.length || hits.length >= maxTotal) return hits;

  const palabras = palabrasClave(pregunta);
  const have = new Set(hits.map((h) => h.id));
  const out = [...hits];
  const unidades = await Promise.all(
    refs.slice(0, maxRefs).map((r) => parrafosDeUnidad(env, r, asOf, have)),
  );
  for (const parrafos of unidades) {
    const presupuesto = Math.min(porUnidad, maxTotal - out.length);
    if (presupuesto <= 0) break;
    const relevantes = new Set(
      parrafos
        .map((p) => ({ p, n: palabras.filter((w) => _sinAcentos(p.texto).includes(w)).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, presupuesto)
        .map((x) => x.p.id),
    );
    const sel = parrafos
      .filter((p, i) => i < 2 || relevantes.has(p.id))
      .slice(0, presupuesto);
    out.push(...sel);
  }
  return out;
}
