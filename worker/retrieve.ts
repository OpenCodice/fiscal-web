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
        model: env.CHAT_MODEL ?? "gpt-4o-mini",
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
