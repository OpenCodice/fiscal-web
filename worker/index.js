// El sitio es estático (./public). Este Worker solo responde por las rutas del
// servicio de búsqueda que se retiró, para que sus clientes reciban una señal
// clara en lugar de la página de inicio.
const RETIRADAS = ["/api/", "/mcp", "/openapi.json", "/pdf/"];

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (RETIRADAS.some((ruta) => url.pathname === ruta || url.pathname.startsWith(ruta))) {
      return Response.json(
        {
          error: "Este servicio se retiró. Los datos siguen disponibles en GitHub.",
          datos: "https://github.com/OpenCodice",
        },
        { status: 410 },
      );
    }
    return Response.redirect(new URL("/", url), 302);
  },
};
