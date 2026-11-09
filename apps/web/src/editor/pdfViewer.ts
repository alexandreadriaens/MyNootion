import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { t } from "@nootion/shared";

/**
 * PDFs drawn with PDF.js (Mozilla's reader), the same on every browser: a phone's browser often shows only the first
 * page of a PDF, or none. Loaded only when a page holds a PDF, and the file itself in parts (HTTP ranges).
 */
type PdfJs = typeof import("pdfjs-dist");
let lib: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  lib ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([pdf, worker]) => {
    pdf.GlobalWorkerOptions.workerSrc = worker.default;
    return pdf;
  });
  return lib;
}

// One loading per file, shared by its preview and its reader.
const documents = new Map<string, Promise<PDFDocumentProxy>>();
export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  let doc = documents.get(url);
  if (!doc) {
    doc = pdfjs().then((pdf) => pdf.getDocument({ url, isOffscreenCanvasSupported: false }).promise);
    doc.catch(() => documents.delete(url));
    documents.set(url, doc);
    if (documents.size > 20) documents.delete(documents.keys().next().value!);
  }
  return doc;
}

function draw(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number): RenderTask {
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  return page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
}

/** First page, `width` pixels wide, and the number of pages. */
export async function renderPdfPreview(url: string, canvas: HTMLCanvasElement, width: number): Promise<number> {
  const doc = await loadPdf(url);
  const page = await doc.getPage(1);
  await draw(page, canvas, width / page.getViewport({ scale: 1 }).width).promise;
  return doc.numPages;
}

const button = (label: string, text: string, onClick: () => void) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "nootion-pdf-viewer__button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
};

/** The PDF full screen: every page, zoom, page number, download. Escape or the close button closes it. */
export function openPdfViewer(opts: { url: string; name: string; downloadHref: string }): void {
  if (document.querySelector(".nootion-pdf-viewer")) return;
  const previousFocus = document.activeElement as HTMLElement | null;
  const overlay = document.createElement("div");
  overlay.className = "nootion-pdf-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", opts.name);

  const bar = document.createElement("div");
  bar.className = "nootion-pdf-viewer__bar";
  const title = document.createElement("div");
  title.className = "nootion-pdf-viewer__title";
  title.textContent = opts.name;
  const pageInfo = document.createElement("div");
  pageInfo.className = "nootion-pdf-viewer__pages";
  const download = document.createElement("a");
  download.className = "nootion-pdf-viewer__button";
  download.href = opts.downloadHref;
  download.setAttribute("download", "");
  download.title = t("file.download");
  download.setAttribute("aria-label", t("file.download"));
  download.textContent = "⬇";

  const scroller = document.createElement("div");
  scroller.className = "nootion-pdf-viewer__scroller";
  const status = document.createElement("div");
  status.className = "nootion-pdf-viewer__status";
  status.textContent = t("pdf.loading");
  scroller.append(status);

  let scale = 1;
  let fitScale = 1;
  let pages: { page: PDFPageProxy; box: HTMLDivElement; canvas: HTMLCanvasElement; drawn: number; task: RenderTask | null }[] = [];
  let closed = false;

  const layout = () => {
    for (const p of pages) {
      const v = p.page.getViewport({ scale });
      p.box.style.width = `${Math.floor(v.width)}px`;
      p.box.style.height = `${Math.floor(v.height)}px`;
    }
  };
  const render = (p: (typeof pages)[number]) => {
    if (p.drawn === scale || closed) return;
    p.task?.cancel();
    p.drawn = scale;
    p.task = draw(p.page, p.canvas, scale);
    p.task.promise.catch(() => (p.drawn = 0));
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const p = pages.find((x) => x.box === e.target);
        if (p) render(p);
      }
    },
    { root: scroller, rootMargin: "600px 0px" },
  );
  const setScale = (next: number) => {
    const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    scale = Math.min(4, Math.max(0.25, next));
    layout();
    scroller.scrollTop = ratio * scroller.scrollHeight;
    // Pages on screen are drawn again at the new size, the others when they come into view.
    for (const p of pages) {
      const r = p.box.getBoundingClientRect();
      if (r.bottom > -600 && r.top < window.innerHeight + 600) render(p);
    }
  };
  const updatePage = () => {
    if (!pages.length) return;
    const middle = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
    const at = pages.findIndex((p) => p.box.getBoundingClientRect().bottom > middle);
    pageInfo.textContent = t("pdf.page", { page: String((at < 0 ? pages.length - 1 : at) + 1), total: String(pages.length) });
  };
  scroller.addEventListener("scroll", updatePage, { passive: true });

  const zoomOut = button(t("pdf.zoomOut"), "−", () => setScale(scale / 1.25));
  const zoomIn = button(t("pdf.zoomIn"), "+", () => setScale(scale * 1.25));
  const fit = button(t("pdf.fitWidth"), "↔", () => setScale(fitScale));
  const close = button(t("imageViewer.close"), "×", () => shut());
  close.classList.add("nootion-pdf-viewer__close");
  bar.append(title, pageInfo, zoomOut, fit, zoomIn, download, close);
  overlay.append(bar, scroller);
  const controls: HTMLElement[] = [zoomOut, fit, zoomIn, download, close];

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      shut();
    } else if ((e.key === "+" || e.key === "=") && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setScale(scale * 1.25);
    } else if (e.key === "-" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setScale(scale / 1.25);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement);
      controls[(at + (e.shiftKey ? controls.length - 1 : 1)) % controls.length]!.focus();
    }
  };
  const bodyOverflow = document.body.style.overflow;
  function shut() {
    closed = true;
    observer.disconnect();
    for (const p of pages) p.task?.cancel();
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    document.body.style.overflow = bodyOverflow;
    previousFocus?.focus?.({ preventScroll: true });
  }
  document.addEventListener("keydown", onKey, true);
  document.body.style.overflow = "hidden";
  document.body.append(overlay);
  close.focus({ preventScroll: true });

  void (async () => {
    try {
      const doc = await loadPdf(opts.url);
      const list = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
      if (closed) return;
      // Fit the width of the screen (a phone), without going past 1.5× on a large one.
      const width = list[0]!.getViewport({ scale: 1 }).width;
      fitScale = Math.min(1.5, (scroller.clientWidth - 32) / width);
      scale = fitScale;
      status.remove();
      pages = list.map((page, i) => {
        const box = document.createElement("div");
        box.className = "nootion-pdf-viewer__page";
        box.setAttribute("aria-label", t("pdf.page", { page: String(i + 1), total: String(list.length) }));
        const canvas = document.createElement("canvas");
        box.append(canvas);
        scroller.append(box);
        observer.observe(box);
        return { page, box, canvas, drawn: 0, task: null };
      });
      layout();
      updatePage();
    } catch {
      if (closed) return;
      status.textContent = t("pdf.error");
      const link = download.cloneNode(true) as HTMLAnchorElement;
      link.className = "nootion-pdf-viewer__fallback";
      link.textContent = `⬇ ${t("file.download")}`;
      status.append(document.createElement("br"), link);
    }
  })();
}
