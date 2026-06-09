import type { Env } from "./types";
import { CORS } from "./cors";

/** ¿La IP excedió el límite del bucket? (consulta el Durable Object). */
export async function isLimited(
  env: Env,
  request: Request,
  bucket: string,
  limit: number,
  period: number,
): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "anon";
  const id = env.RATE_LIMITER.idFromName(`${bucket}:${ip}`);
  const stub = env.RATE_LIMITER.get(id);
  const res = await stub.fetch("https://rl/", {
    method: "POST",
    body: JSON.stringify({ limit, period }),
  });
  const { success } = await res.json<{ success: boolean }>();
  return !success;
}

/** Devuelve una Response 429 si se excedió el límite, o null si pasa. */
export async function checkLimit(
  env: Env,
  request: Request,
  bucket: string,
  limit: number,
  period: number,
): Promise<Response | null> {
  if (!(await isLimited(env, request, bucket, limit, period))) return null;
  return new Response(
    JSON.stringify({ error: "Demasiadas solicitudes. Intenta de nuevo en un minuto." }),
    {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(period), ...CORS },
    },
  );
}
