# Sitio fiscal de OpenCodice (sat.constitucion.app)

Página estática de presentación del proyecto. No tiene build: lo que hay en
`public/` se sirve tal cual desde Cloudflare Workers.

- `public/index.html` y `public/estilo.css`: el sitio.
- `worker/index.js`: responde `410` en las rutas del servicio de búsqueda que se
  retiró (`/api/*`, `/mcp`, `/openapi.json`, `/pdf/*`) y redirige el resto al inicio.

```bash
npm install
npm run dev      # vista local
npm run deploy   # también se despliega solo con cada push a main
```

Los datos viven en [github.com/OpenCodice](https://github.com/OpenCodice).
