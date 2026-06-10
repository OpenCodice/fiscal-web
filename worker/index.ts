import type { Env } from "./types";
import { retrieve } from "./retrieve";
import { buildMessages, buildCitas, parseCitaIds, sanitizeHistory, buildRetrievalQuery, MARK } from "./answer";
import { buscar } from "./search";
import { openapiSpec } from "./openapi";
import { handleMcp } from "./mcp";
import { CORS } from "./cors";
import { checkLimit } from "./ratelimit";

export { RateLimiter } from "./ratelimiter-do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Preflight CORS para los endpoints de máquina.
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }
    // Para humanos: recuperación + respuesta generada en streaming.
    if (url.pathname === "/api/preguntar" && request.method === "POST") {
      return (await checkLimit(env, request, "answer", 10, 60)) ?? handlePreguntar(request, env);
    }
    // Para máquinas (LLMs/tools): recuperación pura, JSON.
    if (url.pathname === "/api/buscar" && request.method === "POST") {
      return (await checkLimit(env, request, "search", 40, 60)) ?? handleBuscar(request, env);
    }
    // Descripción para ChatGPT Actions / function-calling.
    if (url.pathname === "/openapi.json") {
      return Response.json(openapiSpec(url.origin), { headers: CORS });
    }
    // Servidor MCP (Claude y clientes MCP).
    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }
    // PDF oficial por documento (para el visor con resaltado): /pdf/<clave>.pdf.
    if (url.pathname.startsWith("/pdf/") && url.pathname.endsWith(".pdf")) {
      return servePdf(env, url.pathname, request);
    }
    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    // Todo lo demás: el frontend (SPA).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function servePdf(env: Env, pathname: string, request: Request): Promise<Response> {
  // /pdf/<clave>.pdf → clave del documento. Solo [a-z0-9-] para evitar
  // path traversal y normalizar contra las claves del registro (cff, rmf-2026…).
  const clave = pathname.slice("/pdf/".length, -".pdf".length);
  if (!/^[a-z0-9-]+$/.test(clave)) return new Response("PDF inválido", { status: 400 });
  const object = await env.PDF.get(`${clave}.pdf`);
  if (!object) return new Response("PDF no encontrado", { status: 404 });
  const headers = new Headers();
  headers.set("etag", object.httpEtag);
  // Revalida por ETag en cada carga: el navegador cachea pero comprueba si el
  // PDF cambió. Así, tras actualizar un documento, no resalta las coordenadas
  // nuevas sobre el PDF viejo (no hay campo `version` para versionar la URL).
  headers.set("cache-control", "no-cache");
  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-type", "application/pdf");
  return new Response(object.body, { headers });
}

async function handleBuscar(request: Request, env: Env): Promise<Response> {
  let body: { pregunta?: string; k?: number; as_of?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400, headers: CORS });
  }
  const pregunta = (body.pregunta ?? "").toString().trim();
  if (!pregunta) {
    return Response.json({ error: "falta 'pregunta'" }, { status: 400, headers: CORS });
  }
  const k = Math.min(Math.max(Number(body.k) || 6, 1), 12);
  const asOf = body.as_of ? String(body.as_of) : null;

  try {
    const pasajes = await buscar(env, pregunta, k, asOf);
    return Response.json({ pregunta, pasajes }, { headers: CORS });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "error de recuperación" },
      { status: 502, headers: CORS },
    );
  }
}

async function handlePreguntar(request: Request, env: Env): Promise<Response> {
  let body: { pregunta?: string; k?: number; as_of?: string; historial?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }

  const pregunta = (body.pregunta ?? "").toString().trim();
  if (!pregunta) return Response.json({ error: "falta 'pregunta'" }, { status: 400 });
  // k=12: los artículos largos (27 LISR, 2-A LIVA, 42 CFF) están partidos por
  // fracción y con 6 pasajes el LLM solo ve un pedazo de la lista que le piden.
  const k = Math.min(Math.max(Number(body.k) || 12, 1), 16);
  const asOf = body.as_of ? String(body.as_of) : null;
  const historial = sanitizeHistory(body.historial);

  // Para seguimientos cortos, la query de recuperación incorpora el contexto previo.
  const hits = await retrieve(env, buildRetrievalQuery(pregunta, historial), k, asOf);

  // Respuesta en NDJSON: una línea JSON por evento.
  //   {"t":"hits","v":[...]}   pasajes recuperados (para mostrar fuentes al instante)
  //   {"t":"token","v":"..."}  prosa en streaming
  //   {"t":"citas","v":[...]}  citas verificadas (al final)
  //   {"t":"error","v":"..."}
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      try {
        if (hits.length === 0) {
          send({ t: "token", v: "No encontré pasajes relevantes para esa pregunta." });
          send({ t: "citas", v: [] });
          controller.close();
          return;
        }

        send({
          t: "hits",
          v: hits.map((h) => ({ id: h.id, cita: h.cita, score: h._score })),
        });

        const base = env.OPENAI_BASE ?? "https://api.openai.com/v1";
        const r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: env.CHAT_MODEL ?? "gpt-4o-mini",
            max_tokens: 700,
            stream: true,
            messages: buildMessages(pregunta, hits, historial),
          }),
        });
        if (!r.ok || !r.body) {
          send({ t: "error", v: `LLM ${r.status}: ${await r.text().catch(() => "")}` });
          controller.close();
          return;
        }

        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let sseBuf = "";
        let full = "";
        let emitted = 0;

        // Emite la prosa, reteniendo el final por si el marcador llega partido
        // entre deltas. Al ver el marcador, deja de emitir (lo que sigue son ids).
        const flush = (final = false) => {
          const idx = full.indexOf(MARK);
          const end =
            idx === -1
              ? final
                ? full.length
                : Math.max(emitted, full.length - (MARK.length - 1))
              : idx;
          if (end > emitted) {
            send({ t: "token", v: full.slice(emitted, end) });
            emitted = end;
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuf += dec.decode(value, { stream: true });
          const lines = sseBuf.split("\n");
          sseBuf = lines.pop() ?? "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const data = t.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const j = JSON.parse(data);
              const delta = j.choices?.[0]?.delta?.content;
              if (delta) {
                full += delta;
                flush(false);
              }
            } catch {
              // delta parcial; se completa en la siguiente iteración
            }
          }
        }
        flush(true);

        const ids = parseCitaIds(full);
        send({ t: "citas", v: buildCitas(hits, ids) });
        controller.close();
      } catch (e) {
        try {
          send({ t: "error", v: e instanceof Error ? e.message : String(e) });
        } catch {
          /* stream ya cerrado */
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
