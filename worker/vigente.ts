// Port de _vigente() en rag/tfidf.py.
// ¿El pasaje es válido en la fecha `asOf`? (null = solo el texto vigente hoy).
// Las fechas ISO (YYYY-MM-DD) se comparan como string sin problema.
//
// El corpus fiscal no trae vigencia por unidad: cuando `vigente_*` es null o
// undefined, el pasaje se considera vigente (la comparación laxa `== null`
// cubre ambos casos). El filtrado histórico (`as_of`) solo aplica a corpus con
// fechas; para el fiscal es un no-op hasta que se añadan.
export function vigente(
  doc: { vigente_desde?: string | null; vigente_hasta?: string | null },
  asOf: string | null,
): boolean {
  if (asOf == null) return doc.vigente_hasta == null;
  const desde = doc.vigente_desde ?? "0000-00-00";
  const hasta = doc.vigente_hasta;
  return desde <= asOf && (hasta == null || asOf < hasta);
}
