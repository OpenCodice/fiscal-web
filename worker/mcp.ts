// Servidor MCP mínimo (JSON-RPC 2.0 sobre HTTP / Streamable HTTP), sin dependencias.
// Expone una tool `buscar_fiscal` que envuelve la misma retrieve().
// Consumible por Claude (Desktop, claude.ai, Claude Code) y otros clientes MCP.
//
// NOTA: implementación hecha a mano; valídala con un cliente real. Si algún
// cliente exige features extra (SSE GET, sesiones), el fallback es el McpAgent
// del SDK `agents` de Cloudflare (requiere Durable Objects).
import type { Env } from "./types";
import { buscar } from "./search";
import { CORS } from "./cors";
import { isLimited } from "./ratelimit";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "fiscal-mx", version: "1.0.0" };

const TOOL = {
  name: "buscar_fiscal",
  description:
    "Busca pasajes de la legislación fiscal mexicana (leyes, códigos, reglamentos, " +
    "la Resolución Miscelánea Fiscal y los criterios del SAT) relevantes a una " +
    "pregunta. Devuelve pasajes citables (cita legal, documento, texto, archivo " +
    "fuente, página del PDF). NO genera respuestas: usa los pasajes para responder " +
    "y citar con precisión, sin inventar.",
  inputSchema: {
    type: "object",
    properties: {
      pregunta: { type: "string", description: "Pregunta o tema en lenguaje natural, en español." },
      k: { type: "integer", minimum: 1, maximum: 12, default: 6, description: "Pasajes a devolver." },
      as_of: { type: "string", description: "Fecha ISO YYYY-MM-DD para consulta histórica (opcional)." },
    },
    required: ["pregunta"],
  },
};

const JSON_HEADERS = { "content-type": "application/json", ...CORS };

const rpcResult = (id: unknown, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: JSON_HEADERS });

const rpcError = (id: unknown, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    headers: JSON_HEADERS,
  });

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") {
    return new Response("MCP endpoint: usa POST (Streamable HTTP).", { status: 405, headers: CORS });
  }

  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: any };
  try {
    msg = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const { id, method, params } = msg;

  // Las notificaciones (sin id) no llevan respuesta.
  if (id === undefined || id === null) {
    return new Response(null, { status: 202, headers: CORS });
  }

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: [TOOL] });

    case "tools/call": {
      const name = params?.name;
      if (name !== TOOL.name) {
        return rpcError(id, -32602, `Tool desconocida: ${name}`);
      }
      // Rate limit por IP (protege el costo de embeddings).
      if (await isLimited(env, request, "search", 40, 60)) {
        return rpcResult(id, {
          content: [{ type: "text", text: "Límite de solicitudes excedido. Intenta en un minuto." }],
          isError: true,
        });
      }
      const args = params?.arguments ?? {};
      const pregunta = String(args.pregunta ?? "").trim();
      if (!pregunta) {
        // Error de tool: va en el result con isError, no como error de protocolo.
        return rpcResult(id, {
          content: [{ type: "text", text: "Falta el argumento 'pregunta'." }],
          isError: true,
        });
      }
      const k = Math.min(Math.max(Number(args.k) || 6, 1), 12);
      const asOf = args.as_of ? String(args.as_of) : null;
      try {
        const pasajes = await buscar(env, pregunta, k, asOf);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify({ pregunta, pasajes }, null, 2) }],
          structuredContent: { pregunta, pasajes },
          isError: false,
        });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Error al buscar: ${e instanceof Error ? e.message : e}` }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Método no soportado: ${method}`);
  }
}
