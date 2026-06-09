import { useEffect, useRef, useState } from "preact/hooks";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Este módulo (con pdf.js, ~pesado) se carga BAJO DEMANDA vía import() dinámico
// desde app.tsx, para no inflar el bundle inicial. Renderiza el CUERPO del panel
// lateral (sin backdrop): llena el contenedor que le da el padre.

export interface Rect {
  page: number;
  x0: number;
  top: number;
  x1: number;
  bottom: number;
}
export interface Coordenadas {
  pagina: number;
  page_w: number;
  page_h: number;
  rects: Rect[];
}

interface Props {
  cita: string;
  documento: string; // clave del documento → /pdf/<documento>.pdf
  coordenadas: Coordenadas;
  onClose: () => void;
}

interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function PdfViewer({ cita, documento, coordenadas, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [rects, setRects] = useState<CssRect[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setRects([]);
    (async () => {
      try {
        const doc = await pdfjsLib.getDocument({ url: `/pdf/${documento}.pdf` }).promise;
        const page = await doc.getPage(coordenadas.pagina);
        if (cancelled) return;

        const base = page.getViewport({ scale: 1 });
        const targetW = Math.max(280, (scrollRef.current?.clientWidth ?? 820) - 32);
        const scale = targetW / base.width;
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d")!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (cancelled) return;

        // pdfplumber da top desde arriba; el viewport (sin rotación) escala
        // puntos→píxeles 1:1, así que la conversión es directa.
        const css = coordenadas.rects
          .filter((r) => r.page === coordenadas.pagina)
          .map((r) => ({
            left: r.x0 * scale,
            top: r.top * scale,
            width: (r.x1 - r.x0) * scale,
            height: (r.bottom - r.top) * scale,
          }));
        setRects(css);
        setLoading(false);
        if (css[0] && scrollRef.current) {
          scrollRef.current.scrollTop = Math.max(0, css[0].top - 120);
        }
      } catch {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [coordenadas.pagina, cita, documento]);

  return (
    <div class="flex h-full flex-col bg-white">
      <div class="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3">
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold text-stone-800">{cita}</div>
          <div class="text-xs text-stone-400">PDF oficial · página {coordenadas.pagina}</div>
        </div>
        <button
          onClick={onClose}
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
          aria-label="Cerrar visor de PDF"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div ref={scrollRef} class="scroll-thin grow overflow-auto bg-stone-100 p-4">
        {loading && (
          <div class="py-24 text-center text-sm text-stone-400">Cargando PDF…</div>
        )}
        {error && (
          <div class="py-24 text-center text-sm text-red-600">
            No se pudo cargar el PDF.
          </div>
        )}
        <div class="relative mx-auto w-max" style={{ display: error ? "none" : "block" }}>
          <canvas ref={canvasRef} class="block rounded-sm bg-white shadow-md" />
          {rects.map((r, i) => (
            <div
              key={i}
              class="pointer-events-none absolute rounded-[2px]"
              style={{
                left: `${r.left}px`,
                top: `${r.top}px`,
                width: `${r.width}px`,
                height: `${r.height}px`,
                background: "rgba(250, 204, 21, 0.4)",
                mixBlendMode: "multiply",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
