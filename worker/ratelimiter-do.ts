// Durable Object: ventana fija por clave (IP+bucket). Fuertemente consistente,
// confiable a diferencia del binding nativo beta. Una instancia por clave.
export class RateLimiter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const { limit, period } = await request.json<{ limit: number; period: number }>();
    const now = Date.now();
    let w = await this.state.storage.get<{ start: number; count: number }>("w");
    if (!w || now - w.start >= period * 1000) {
      w = { start: now, count: 0 };
    }
    w.count++;
    await this.state.storage.put("w", w);
    return Response.json({ success: w.count <= limit });
  }
}
