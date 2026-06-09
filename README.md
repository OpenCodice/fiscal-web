# fiscal-web 🧾🔎🇲🇽

UI web del RAG del **corpus fiscal mexicano**, sobre **Cloudflare Workers**.
La aplicación web del sistema fiscal: consume los datos de
[`fiscal-mexicano`](../fiscal-mexicano) y reusa el patrón del RAG
([`fiscal-rag`](../fiscal-rag)) portado a TypeScript. Espejo de
[`constitucion-web`](../constitucion-web), generalizado de **un documento** a un
**corpus multi-documento** (16 leyes/códigos/reglamentos + RMF + criterios).

```
pregunta ─▶ embedding (OpenAI) ─▶ Vectorize (top-K) ─▶ hidrata pasajes (KV)
         ─▶ LLM responde anclado (streaming) ─▶ citas verificables (con página de PDF)
```

**Patrón anti-alucinación (intacto):** el LLM no escribe la cita; devuelve `id`s
de pasaje, la app valida que existan entre los recuperados y **renderiza la cita
desde el registro confiable de KV** (`cita`/`texto`/`documento`/página).

## Arquitectura

| Pieza | Rol |
|---|---|
| **Worker** (`worker/`) | API `/api/preguntar` (streaming NDJSON) + sirve el frontend |
| **Vectorize** (`fiscal-pasajes`) | índice vectorial (1536 dims, cosine) — recuperación semántica |
| **KV** (`PASAJES`) | pasajes completos por `id` — fuente de las citas |
| **R2** (`fiscal-pdf`) | un PDF oficial por documento — visor con resaltado (`/pdf/<clave>.pdf`) |
| **OpenAI** | embeddings (`text-embedding-3-small`) + respuesta (`gpt-4o-mini`) |
| **Preact + Tailwind** (`src/`) | frontend, build con Vite → `dist/` |

Diferencias con `constitucion-web`: el corpus es **multi-documento** (`documento`
+ `clave_unidad`, no `clave_articulo`), tiene ~20× más pasajes (27 399), el texto
indexado es `cita + texto` (no hay `texto_embedding`), **no hay vigencia** por
unidad (`as_of` es un no-op por ahora) y se sirven **N PDF** (uno por documento)
desde R2. La ingestión porta `fiscal-rag/rag/corpus.py::load_corpus`.

## Puesta en marcha

```bash
npm install

# 1. Infraestructura (una vez) — copia los ids/nombres a wrangler.jsonc
npx wrangler vectorize create fiscal-pasajes --dimensions=1536 --metric=cosine
npx wrangler kv namespace create PASAJES            # copia id → wrangler.jsonc
npx wrangler kv namespace create PASAJES --preview  # copia preview_id → wrangler.jsonc
npx wrangler r2 bucket create fiscal-pdf
npx wrangler secret put OPENAI_API_KEY              # para producción
cp .dev.vars.example .dev.vars                      # y pon tu key para dev local

# 2. Ingestión: datos → embeddings → Vectorize + KV
OPENAI_API_KEY=sk-... npm run ingest                # lee ../fiscal-mexicano
npm run upload:vectors                              # sube vectors.ndjson a Vectorize
npm run upload:kv                                   # sube pasajes a KV (wrangler trocea)
#  ⚠️ Vectorize tarda unos segundos en hacer queryable lo recién subido.

# 3. PDFs oficiales → R2 (para el visor con resaltado)
npm run pdfs                                        # descarga los 16 PDF a .data/pdfs/
for f in .data/pdfs/*.pdf; do \
  npx wrangler r2 object put "fiscal-pdf/$(basename "$f")" --file "$f" \
    --content-type application/pdf; done

# 4. Desarrollo (frontend :5173 + Worker :8787, con proxy /api)
npm run dev

# 5. Producción
npm run deploy                                      # vite build + wrangler deploy
```

Sin `routes` en `wrangler.jsonc`, el Worker queda en `*.workers.dev`. Para un
dominio de marca, descomenta el bloque `routes` (la zona debe estar en Cloudflare).

## Actualización cuando hay reforma / enriquecimiento

Cuando `fiscal-mexicano` recibe un commit nuevo (reforma vía `vigilar-fiscal.yml`
o el CI de enriquecimiento `enriquecer.yml`), reconstruye el índice:

```bash
cd ../fiscal-mexicano && git pull
cd ../fiscal-web && npm run ingest && npm run upload:vectors && npm run upload:kv
```

En CI lo hace `.github/workflows/reingest.yml` (también sube los PDF a R2). Se
puede disparar con un `repository_dispatch: datos-actualizados` desde
`fiscal-mexicano`, a mano, o por el schedule semanal.

## Notas de costo / operación

- Ingestión: ~$0.20 una vez (27 399 embeddings); se repite solo al reindexar.
- Por pregunta: 1 embedding de query + 1 chat `gpt-4o-mini` (~$0.001).
- **AI Gateway** (recomendado): añade `OPENAI_BASE` en `wrangler.jsonc` apuntando
  a tu gateway para caché de respuestas, rate limiting y analítica de costo.
- El enriquecimiento (`metadata/<clave>/generado/`) es **opcional**: mejora el
  recall de preguntas coloquiales y se recoge en la ingestión si existe; nunca es
  fuente de cita.

## API

El Worker expone tres superficies sobre la **misma** `retrieve()`:

| Endpoint | Para | Genera respuesta |
|---|---|---|
| `POST /api/preguntar` | la UI humana | sí (LLM, streaming) |
| `POST /api/buscar` | LLMs / tools (ChatGPT, function-calling) | no (recuperación pura) |
| `GET /openapi.json` | ChatGPT Actions / Custom GPT | — |
| `/mcp` | Claude y clientes MCP (JSON-RPC) | no |

**Principio:** a un LLM consumidor se le dan **pasajes citables**, no prosa
generada. El modelo que llama cita desde la fuente confiable. Es el patrón
anti-alucinación, con el LLM externo como renderizador de la cita.

### `POST /api/preguntar` (humano) → `application/x-ndjson`
Una línea JSON por evento:
```
{"t":"hits", "v":[{"id","cita","score"}]}   pasajes recuperados
{"t":"token","v":"…"}                        prosa en streaming
{"t":"citas","v":[{"id","cita","documento","fuente","texto","archivo","pdf","coordenadas"}]}
{"t":"error","v":"…"}
```

### `POST /api/buscar` (máquina) → JSON
```jsonc
// req:  { "pregunta": "...", "k": 6 }
// resp: { "pregunta": "...", "pasajes": [
//   { "id","cita","documento","fuente","texto","archivo","pdf","score" } ] }
```

### MCP
Conecta un cliente MCP a `https://<tu-worker>/mcp`. Expone la tool
`buscar_fiscal(pregunta, k?, as_of?)`. Implementación a mano (Streamable HTTP /
JSON-RPC); ver `worker/mcp.ts`. Validar con un cliente real.
