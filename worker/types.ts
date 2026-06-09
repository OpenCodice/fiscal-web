// Coordenadas del pasaje en el PDF (para el visor con resaltado).
export interface RectPDF {
  page: number;
  x0: number;
  top: number;
  x1: number;
  bottom: number;
}
export interface Coordenadas {
  pagina: number;
  page_w: number;
  page_h: number;
  rects: RectPDF[];
}

// Registro de pasaje tal como vive en KV (fuente confiable de la cita).
// Mismo shape que metadata/<clave>/pasajes.jsonl en fiscal-mexicano. El corpus
// fiscal es multi-documento (`documento` + `clave_unidad`) y NO trae campos de
// vigencia (la RMF/criterios son anuales por versión del documento, no por
// artículo), por eso `vigente_*` son opcionales.
export interface Pasaje {
  id: string;
  cita: string;
  texto: string;
  documento: string; // clave del documento: "cff", "lisr", "rmf-2026", …
  clave_unidad: string; // unidad dentro del doc: "027", "2.7.1.21", "10-iva-n"
  fuente: string; // nombre legible del documento ("Código Fiscal de la Federación")
  archivo_texto: string;
  url_fuente: string;
  coordenadas: Coordenadas | null;
  vigente_desde?: string | null;
  vigente_hasta?: string | null;
  [k: string]: unknown;
}

export interface Env {
  ASSETS: Fetcher;
  VECTORIZE: VectorizeIndex;
  PASAJES: KVNamespace;
  OPENAI_API_KEY: string;
  OPENAI_BASE?: string;
  EMBED_MODEL?: string;
  CHAT_MODEL?: string;
  RATE_LIMITER: DurableObjectNamespace; // rate limiting por IP
  PDF: R2Bucket; // PDF oficial versionado
}
