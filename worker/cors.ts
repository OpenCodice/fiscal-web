// CORS abierto para los endpoints de máquina (LLMs/tools llaman cross-origin).
export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400",
};
