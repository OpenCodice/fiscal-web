import { useEffect, useRef, useState } from "preact/hooks";
import type { Coordenadas, PdfViewer as PdfViewerType } from "./PdfViewer";

// Repo de datos en GitHub: cada cita enlaza a su unidad (texto oficial).
const DATA_REPO = "https://github.com/OpenCodice/fiscal-mexicano/blob/main";

interface Cita {
  id: string;
  cita: string;
  documento: string; // clave del documento (para abrir su PDF)
  fuente: string; // nombre legible del documento
  texto: string;
  archivo: string;
  pdf: string;
  coordenadas: Coordenadas | null;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  citas?: Cita[];
  error?: string;
  pending?: boolean; // el asistente sigue recuperando/escribiendo
}

const EJEMPLOS = [
  "¿Cuándo debo presentar la declaración anual?",
  "¿Cómo facturo mis ventas de mostrador?",
  "¿Qué tasa de IVA aplica a alimentos?",
  "¿Cuándo se considera que hay residencia fiscal en México?",
];

function Bandera({ class: cls = "" }: { class?: string }) {
  return (
    <span
      class={
        "inline-block rounded-sm bg-gradient-to-b from-emerald-600 via-white to-red-600 ring-1 ring-stone-300 " +
        cls
      }
    />
  );
}

export function App() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  // Visor PDF (panel lateral): se carga bajo demanda (pdf.js es pesado).
  const [PdfViewer, setPdfViewer] = useState<typeof PdfViewerType | null>(null);
  const [pdfProps, setPdfProps] = useState<{
    cita: string;
    documento: string;
    coordenadas: Coordenadas;
  } | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Autoscroll al fondo cuando el hilo crece o llegan tokens.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Escape cierra el panel del PDF.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pdfOpen) cerrarPdf();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pdfOpen]);

  async function abrirPdf(c: Cita) {
    if (!c.coordenadas) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (!PdfViewer) {
      const mod = await import("./PdfViewer");
      setPdfViewer(() => mod.PdfViewer);
    }
    setPdfProps({ cita: c.cita, documento: c.documento, coordenadas: c.coordenadas });
    setPdfOpen(true);
  }

  function cerrarPdf() {
    setPdfOpen(false);
    // Mantén el contenido durante la animación de salida, luego desmonta.
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setPdfProps(null), 320);
  }

  function nuevaConversacion() {
    if (loading) return;
    setMessages([]);
    cerrarPdf();
    setInput("");
    taRef.current?.focus();
  }

  function autosize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  async function preguntar(q: string) {
    const texto = q.trim();
    if (!texto || loading) return;

    // Historial limpio (sin pendientes ni errores) para que el LLM entienda seguimientos.
    const historial = messages
      .filter((m) => !m.error && m.content && !m.pending)
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-6);

    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
    setMessages((prev) => [
      ...prev,
      { role: "user", content: texto },
      { role: "assistant", content: "", pending: true },
    ]);
    setLoading(true);

    // Actualiza el ÚLTIMO mensaje (el asistente recién insertado).
    const patch = (fn: (m: Msg) => Partial<Msg>) =>
      setMessages((prev) => {
        const next = [...prev];
        const i = next.length - 1;
        next[i] = { ...next[i], ...fn(next[i]) };
        return next;
      });

    try {
      const res = await fetch("/api/preguntar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pregunta: texto, historial }),
      });
      if (!res.body) throw new Error("El servidor no devolvió respuesta.");

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.t === "token") patch((m) => ({ content: m.content + msg.v }));
          else if (msg.t === "citas") patch(() => ({ citas: msg.v }));
          else if (msg.t === "error") patch(() => ({ error: msg.v }));
        }
      }
    } catch (e) {
      patch(() => ({ error: e instanceof Error ? e.message : String(e) }));
    } finally {
      patch(() => ({ pending: false }));
      setLoading(false);
    }
  }

  const vacio = messages.length === 0;

  return (
    <div class="relative h-full overflow-hidden bg-stone-50 text-stone-800">
      {/* Columna del chat: se encoge en desktop cuando el panel del PDF está abierto. */}
      <div
        class={
          "flex h-full flex-col transition-[padding] duration-300 ease-out " +
          (pdfOpen ? "lg:pr-[min(560px,46vw)]" : "")
        }
      >
        {/* Encabezado */}
        <header class="z-10 shrink-0 border-b border-stone-200/80 bg-stone-50/80 backdrop-blur">
          <div class="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
            <div class="flex items-center gap-2.5">
              <Bandera class="h-5 w-5" />
              <div class="leading-tight">
                <div class="text-sm font-semibold tracking-tight">Legislación fiscal mexicana</div>
                <div class="text-xs text-stone-400">Respuestas con citas verificables</div>
              </div>
            </div>
            {!vacio && (
              <button
                onClick={nuevaConversacion}
                disabled={loading}
                class="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition hover:border-stone-400 hover:text-stone-800 disabled:opacity-50"
              >
                Nueva conversación
              </button>
            )}
          </div>
        </header>

        {/* Hilo de mensajes */}
        <div ref={scrollerRef} class="scroll-thin grow overflow-y-auto">
          {vacio ? (
            <div class="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-4 text-center">
              <Bandera class="mb-5 h-12 w-12" />
              <h1 class="text-2xl font-bold tracking-tight text-stone-800 sm:text-3xl">
                ¿Qué quieres saber de la legislación fiscal?
              </h1>
              <p class="mt-2 max-w-md text-sm text-stone-500">
                Pregunta en lenguaje natural sobre leyes, códigos, reglamentos, la RMF y
                los criterios del SAT, y recibe respuestas con{" "}
                <strong class="font-semibold text-stone-700">citas verificables</strong> al texto
                oficial.
              </p>
              <div class="mt-7 flex w-full max-w-xl flex-wrap justify-center gap-2">
                {EJEMPLOS.map((ej) => (
                  <button
                    key={ej}
                    onClick={() => preguntar(ej)}
                    class="rounded-full border border-stone-200 bg-white px-3.5 py-2 text-sm text-stone-600 shadow-sm transition hover:border-emerald-400 hover:text-emerald-700"
                  >
                    {ej}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div class="mx-auto max-w-3xl px-4 py-6">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} class="msg-in mb-6 flex justify-end">
                    <div class="max-w-[85%] rounded-2xl rounded-br-md bg-emerald-700 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-sm">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} class="msg-in mb-8 flex gap-3">
                    <Bandera class="mt-1 h-6 w-6 shrink-0" />
                    <div class="min-w-0 flex-1">
                      {m.error ? (
                        <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                          {m.error}
                        </div>
                      ) : m.content ? (
                        <div
                          class={
                            "whitespace-pre-wrap text-[15px] leading-relaxed text-stone-800" +
                            (m.pending ? " streaming" : "")
                          }
                        >
                          {m.content}
                        </div>
                      ) : (
                        <div class="thinking flex items-center py-1.5" aria-label="Pensando">
                          <span />
                          <span />
                          <span />
                        </div>
                      )}

                      {m.citas && m.citas.length > 0 && (
                        <div class="mt-4">
                          <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
                            Fuentes ({m.citas.length})
                          </div>
                          <div class="space-y-2.5">
                            {m.citas.map((c) => (
                              <CitaCard key={c.id} c={c} onPdf={() => abrirPdf(c)} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div class="shrink-0 bg-gradient-to-t from-stone-50 via-stone-50 to-transparent pb-3 pt-2">
          <div class="mx-auto max-w-3xl px-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                preguntar(input);
              }}
              class="flex items-end gap-2 rounded-2xl border border-stone-300 bg-white p-2 shadow-sm transition focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-100"
            >
              <textarea
                ref={taRef}
                value={input}
                rows={1}
                placeholder="Escribe tu pregunta…"
                onInput={(e) => {
                  setInput((e.target as HTMLTextAreaElement).value);
                  autosize();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    preguntar(input);
                  }
                }}
                class="scroll-thin max-h-[200px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed outline-none placeholder:text-stone-400"
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                aria-label="Enviar"
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-700 text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? (
                  <svg class="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.25" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                )}
              </button>
            </form>
            <p class="mt-2 px-1 text-center text-[11px] text-stone-400">
              Respuestas generadas por IA a partir de los pasajes citados; no es asesoría fiscal. El
              texto oficial es el de la Cámara de Diputados y el SAT.
            </p>
          </div>
        </div>
      </div>

      {/* Backdrop solo en móvil (en desktop el chat se reacomoda, no se cubre). */}
      <div
        onClick={cerrarPdf}
        class={
          "fixed inset-0 z-30 bg-black/30 transition-opacity duration-300 lg:hidden " +
          (pdfOpen ? "opacity-100" : "pointer-events-none opacity-0")
        }
      />

      {/* Panel lateral del PDF: entra desde la derecha. */}
      <aside
        class={
          "fixed inset-y-0 right-0 z-40 w-full transform border-l border-stone-200 bg-white shadow-2xl transition-transform duration-300 ease-out lg:w-[min(560px,46vw)] " +
          (pdfOpen ? "translate-x-0" : "translate-x-full")
        }
        aria-hidden={!pdfOpen}
      >
        {PdfViewer && pdfProps && (
          <PdfViewer
            cita={pdfProps.cita}
            documento={pdfProps.documento}
            coordenadas={pdfProps.coordenadas}
            onClose={cerrarPdf}
          />
        )}
      </aside>
    </div>
  );
}

function CitaCard({ c, onPdf }: { c: Cita; onPdf: () => void }) {
  return (
    <div class="rounded-xl border border-stone-200 bg-white p-3.5 shadow-sm transition hover:border-stone-300">
      <div class="flex items-baseline justify-between gap-3">
        <span class="min-w-0 text-sm font-semibold text-emerald-800">{c.cita}</span>
        <span class="max-w-[45%] shrink-0 truncate text-xs text-stone-400" title={c.fuente}>
          {c.fuente}
        </span>
      </div>
      <p class="mt-1.5 line-clamp-3 text-sm leading-relaxed text-stone-600">{c.texto}</p>
      <div class="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        {c.coordenadas && (
          <button
            onClick={onPdf}
            class="inline-flex items-center gap-1 font-medium text-emerald-700 transition hover:text-emerald-900"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M7 8h10M7 12h6" />
            </svg>
            Ver en el PDF
          </button>
        )}
        <a
          href={`${DATA_REPO}/${c.archivo}`}
          target="_blank"
          rel="noreferrer"
          class="text-stone-400 underline-offset-2 hover:text-emerald-700 hover:underline"
        >
          Texto oficial ↗
        </a>
        {c.pdf && (
          <a
            href={c.pdf}
            target="_blank"
            rel="noreferrer"
            class="text-stone-400 underline-offset-2 hover:text-emerald-700 hover:underline"
          >
            PDF oficial ↗
          </a>
        )}
      </div>
    </div>
  );
}
