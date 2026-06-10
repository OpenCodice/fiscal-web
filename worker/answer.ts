import type { Hit } from "./retrieve";
import type { Coordenadas } from "./types";

/**
 * Port de rag/answer.py — patrón anti-alucinación.
 *
 * El LLM responde SOLO con los pasajes dados y, al final, lista los ids que usó
 * tras un marcador. La app valida que esos ids existan entre los recuperados y
 * **renderiza la cita desde el dato confiable** (KV), nunca del texto del LLM.
 *
 * Variante streaming: en vez de pedir un JSON entero (que no se puede emitir
 * token a token), pedimos la prosa primero y los ids después del marcador.
 */
export const MARK = "##CITAS##";

export const SYSTEM =
  "Eres un asistente que responde preguntas sobre la legislación fiscal mexicana " +
  "(leyes, códigos, reglamentos, la Resolución Miscelánea Fiscal y los criterios " +
  "del SAT) USANDO EXCLUSIVAMENTE los pasajes que se te proporcionan en el último " +
  "mensaje. No uses conocimiento externo ni des asesoría fiscal. Si los pasajes no " +
  "contienen la respuesta, dilo claramente. Responde en español, de forma breve y " +
  "clara. Mantienes una conversación: puedes usar los mensajes anteriores para " +
  "entender preguntas de seguimiento, pero fundamenta cada respuesta solo en los " +
  "pasajes del último mensaje. " +
  "NO infieras por tu cuenta el significado de siglas o acrónimos (p. ej. nombres " +
  "de regímenes fiscales); tu conocimiento previo puede estar desactualizado. Los " +
  "pasajes se recuperaron por su relevancia a la pregunta: si la pregunta usa una " +
  "sigla, un término corto o una palabra cotidiana y los pasajes regulan la figura " +
  "correspondiente con su nombre legal (p. ej. 'aguinaldo' → 'gratificaciones', " +
  "'factura' → 'comprobante fiscal', 'gasolina' → 'combustibles'), trátalos como " +
  "la respuesta y respóndelos; NO los descartes por no contener la palabra literal " +
  "de la pregunta. Cada pasaje indica entre paréntesis su ubicación en la ley " +
  "(Título/Capítulo/Sección), que suele traer el nombre del régimen o tema. " +
  "Cuidado con el sentido de los pasajes: si un pasaje enumera excepciones, " +
  "exclusiones o quién NO puede aplicar algo, NUNCA lo presentes como la regla " +
  "general o como quién SÍ puede. " +
  "Si preguntan por un caso específico (un producto, una actividad) que los " +
  "pasajes no mencionan expresamente pero sí traen la regla general aplicable, " +
  "dilo así: que los pasajes no lo mencionan y cuál es la regla general que " +
  "aplicaría por defecto, citándola; no concluyas que un beneficio o tasa " +
  "preferente aplica si el caso no aparece en los pasajes.";

/** Un turno previo de la conversación (sin pasajes; solo contexto). */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Limpia el historial que envía el cliente: solo turnos válidos, sin el marcador
 * de citas en las respuestas del asistente, acotado en longitud y número de turnos
 * para no inflar el contexto del LLM.
 */
export function sanitizeHistory(raw: unknown, maxTurns = 6): Turn[] {
  if (!Array.isArray(raw)) return [];
  const out: Turn[] = [];
  for (const t of raw) {
    const role = (t as { role?: unknown })?.role;
    const content = (t as { content?: unknown })?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const clean = content.split(MARK)[0].trim().slice(0, 2000);
    if (clean) out.push({ role, content: clean });
  }
  return out.slice(-maxTurns);
}

/**
 * Query para recuperar pasajes. En seguimientos cortos ("¿y para extranjeros?")
 * la pregunta por sí sola no recupera bien, así que se le antepone la última
 * pregunta del usuario como contexto.
 */
export function buildRetrievalQuery(question: string, history: Turn[]): string {
  if (question.length >= 60) return question;
  const prevUser = [...history].reverse().find((t) => t.role === "user")?.content;
  return prevUser ? `${prevUser}\n${question}` : question;
}

export function buildMessages(question: string, hits: Hit[], history: Turn[] = []) {
  const pasajes = hits
    .map((h) => {
      const ubic = typeof h.contexto === "string" && h.contexto ? ` — ${h.contexto}` : "";
      return `[${h.id}] (${h.cita}${ubic})\n${h.texto}`;
    })
    .join("\n\n");
  const user =
    `PASAJES:\n${pasajes}\n\n` +
    `PREGUNTA: ${question}\n\n` +
    `Primero escribe la respuesta en español, breve y clara, basada solo en los pasajes.\n` +
    `Al terminar, en una línea nueva escribe exactamente "${MARK}" seguido de un ` +
    `arreglo JSON con los ids de los pasajes que respaldan tu respuesta. Ejemplo:\n` +
    `${MARK}["${hits[0]?.id ?? "cff/001.p1"}"]\n` +
    `Incluye en el arreglo únicamente ids que aparezcan en los PASAJES de arriba.`;
  return [
    { role: "system", content: SYSTEM },
    ...history,
    { role: "user", content: user },
  ];
}

export interface Cita {
  id: string;
  cita: string;
  documento: string; // clave del documento (para servir su PDF: /pdf/<documento>.pdf)
  fuente: string; // nombre legible del documento
  texto: string;
  archivo: string;
  pdf: string; // url al PDF oficial (Cámara de Diputados / SAT)
  coordenadas: Coordenadas | null; // página + rects para el visor con resaltado
}

/** Sólo se aceptan ids realmente recuperados (anti-alucinación de citas). */
export function buildCitas(hits: Hit[], ids: string[]): Cita[] {
  const byId = new Map(hits.map((h) => [h.id, h]));
  const out: Cita[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const h = byId.get(id);
    if (!h || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: h.id,
      cita: h.cita,
      documento: h.documento,
      fuente: h.fuente,
      texto: h.texto,
      archivo: h.archivo_texto,
      pdf: h.url_fuente,
      coordenadas: h.coordenadas ?? null,
    });
  }
  return out;
}

/** Extrae el arreglo de ids que el LLM escribió después del marcador. */
export function parseCitaIds(full: string): string[] {
  const idx = full.indexOf(MARK);
  if (idx === -1) return [];
  const rest = full.slice(idx + MARK.length);
  const m = rest.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
