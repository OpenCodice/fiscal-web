// Spec OpenAPI 3.1 de la API de búsqueda, para ChatGPT Actions / function-calling.
// `origin` se inyecta en runtime para que `servers.url` siempre sea correcto.
export function openapiSpec(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Legislación fiscal mexicana — búsqueda de pasajes",
      version: "1.0.0",
      description:
        "Busca pasajes citables de la legislación fiscal mexicana (leyes, códigos, " +
        "reglamentos, la Resolución Miscelánea Fiscal y los criterios del SAT). " +
        "Devuelve pasajes con su cita legal y documento; no genera respuestas. " +
        "Úsalos para responder y citar con precisión.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/buscar": {
        post: {
          operationId: "buscarPasajes",
          summary: "Busca pasajes relevantes de la legislación fiscal mexicana",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BuscarRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Pasajes relevantes, ordenados por relevancia.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/BuscarResponse" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        BuscarRequest: {
          type: "object",
          required: ["pregunta"],
          properties: {
            pregunta: {
              type: "string",
              description: "Pregunta o tema en lenguaje natural, en español.",
            },
            k: {
              type: "integer",
              minimum: 1,
              maximum: 12,
              default: 6,
              description: "Número de pasajes a devolver.",
            },
            as_of: {
              type: "string",
              format: "date",
              description:
                "Fecha ISO (YYYY-MM-DD) para consulta histórica. Omitir = texto vigente hoy.",
            },
          },
        },
        BuscarResponse: {
          type: "object",
          properties: {
            pregunta: { type: "string" },
            pasajes: {
              type: "array",
              items: { $ref: "#/components/schemas/Pasaje" },
            },
          },
        },
        Pasaje: {
          type: "object",
          properties: {
            id: { type: "string", description: "Identificador del pasaje (p. ej. cff/027.p1)." },
            cita: { type: "string", description: "Cita legal formal. Úsala textual." },
            documento: { type: "string", description: "Clave del documento (cff, lisr, rmf-2026…)." },
            fuente: { type: "string", description: "Nombre legible del documento." },
            texto: { type: "string", description: "Texto del pasaje (fuente de la cita)." },
            archivo: { type: "string", description: "Ruta de la unidad en el repo de datos." },
            score: { type: "number", description: "Relevancia (mayor = más relevante)." },
          },
        },
      },
    },
  };
}
