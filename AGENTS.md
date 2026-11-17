# fiscal-web — guía para agentes

Landing estático de [sat.constitucion.app](https://sat.constitucion.app). Presenta el proyecto y enlaza a los
repos de datos en [github.com/OpenCodice](https://github.com/OpenCodice).

- `public/index.html` y `public/estilo.css` — todo el sitio. Sin build, sin
  framework, sin JavaScript en la página.
- `public/og.png` — la imagen para redes (og:image), con el diseño de las
  tarjetas de constitucion-web (`scripts/lib/tarjeta.mjs`, `dibujar` con
  `sitio: "sat.constitucion.app"`); si cambia el texto de la página, se vuelve
  a dibujar desde ahí. `public/robots.txt` y `public/sitemap.xml` son fijos.
- `worker/index.js` — responde `410` en las rutas del servicio de búsqueda que
  se retiró (`/api/*`, `/mcp`, `/openapi.json`, `/pdf/*`) y redirige cualquier
  otra ruta al inicio.
- `wrangler.jsonc` — Worker con assets. Las migraciones `v1` y `v2` son el alta
  y la baja de un Durable Object anterior; no se pueden quitar de la lista.

Cada push a `main` despliega a producción (`.github/workflows/deploy.yml`).
Para verlo en local: `npm install && npm run dev`.

## Criterios

- **Estilo:** texto plano sobre la página, sobrio y legible, sin animaciones.
  Tipografía del sistema, blanco y negro, modo oscuro por `prefers-color-scheme`.
  `estilo.css` es el mismo archivo en `constitucion-web` y `fiscal-web`: un
  cambio de estilo va en los dos.
- **Contenido:** las cifras (artículos, documentos, unidades) salen de los repos
  de datos; actualízalas cuando cambie el corpus y no prometas lo que aún no
  existe.
- **Sin LLM ni servicios en tiempo de lectura.** Aquí hubo un chat con búsqueda
  semántica y se retiró a propósito. La siguiente pieza es una bitácora de
  cambios generada del historial de git, también estática.
