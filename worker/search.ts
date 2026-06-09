import type { Env, Coordenadas } from "./types";
import { retrieve } from "./retrieve";

// Forma citable de un pasaje para consumo por máquina (LLMs, tools, MCP).
// Es la "fuente confiable": el LLM que llama redacta y cita a partir de esto.
export interface PasajeResultado {
  id: string;
  cita: string;
  documento: string;
  fuente: string;
  texto: string;
  archivo: string;
  pdf: string;
  coordenadas: Coordenadas | null;
  score: number;
}

/** Recuperación pura: sin generación de respuesta. Base de /api/buscar y MCP. */
export async function buscar(
  env: Env,
  pregunta: string,
  k: number,
  asOf: string | null,
): Promise<PasajeResultado[]> {
  const hits = await retrieve(env, pregunta, k, asOf);
  return hits.map((h) => ({
    id: h.id,
    cita: h.cita,
    documento: h.documento,
    fuente: h.fuente,
    texto: h.texto,
    archivo: h.archivo_texto,
    pdf: h.url_fuente,
    coordenadas: h.coordenadas ?? null,
    score: Math.round(h._score * 10000) / 10000,
  }));
}
