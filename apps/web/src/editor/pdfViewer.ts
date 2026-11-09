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

/**
 * Prints the PDF: its pages drawn as images at 150 dpi, alone on the paper (the app hidden), then the browser's print
 * dialog. Done this way rather than printing the file in a frame: Safari, and phones, can't print a PDF from a frame.
 */
let printing = false;
export async function printPdf(url: string): Promise<void> {
  if (printing) return;
  printing = true;
  const urls: string[] = [];
  const container = document.createElement("div");
  container.className = "nootion-pdf-print";
  // Edge to edge, and without the browser's header and footer (address, date), only while this PDF prints.
  const pageStyle = document.createElement("style");
  pageStyle.textContent = "@page { margin: 0; }";
  try {
    const doc = await loadPdf(url);
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const canvas = document.createElement("canvas");
      const viewport = page.getViewport({ scale: 150 / 72 });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) continue;
      const img = document.createElement("img");
      img.src = URL.createObjectURL(blob);
      urls.push(img.src);
      img.alt = "";
      container.append(img);
    }
    document.head.append(pageStyle);
    document.body.append(container);
    document.body.classList.add("nootion-printing-pdf");
    await Promise.all([...container.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
    await new Promise<void>((resolve) => {
      window.addEventListener("afterprint", () => resolve(), { once: true });
      window.print();
      // Some browsers (Safari, phones) don't send "afterprint", or send it before printing: cleaned up later anyway.
      setTimeout(resolve, 60_000);
    });
  } finally {
    document.body.classList.remove("nootion-printing-pdf");
    container.remove();
    pageStyle.remove();
    for (const u of urls) URL.revokeObjectURL(u);
    printing = false;
  }
}

/** A print button's text while the pages are prepared. */
export function printWith(buttonEl: HTMLElement, url: string, label: string): void {
  buttonEl.textContent = t("pdf.preparingPrint");
  buttonEl.setAttribute("aria-busy", "true");
  void printPdf(url).finally(() => {
    buttonEl.textContent = label;
    buttonEl.removeAttribute("aria-busy");
  });
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
  let fitPageScale = 1;
  let fitWidthScale = 1;
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
  // Two fits, as in usual readers: the whole page on the screen (the default), or the width of the screen.
  const fitPage = button(t("pdf.fitPage"), "⤢", () => setScale(fitPageScale));
  const fit = button(t("pdf.fitWidth"), "↔", () => setScale(fitWidthScale));
  const close = button(t("imageViewer.close"), "×", () => shut());
  close.classList.add("nootion-pdf-viewer__close");
  const print = button(t("pdf.print"), "🖨", () => printWith(print, opts.url, "🖨"));
  bar.append(title, pageInfo, zoomOut, fitPage, fit, zoomIn, print, download, close);
  overlay.append(bar, scroller);
  const controls: HTMLElement[] = [zoomOut, fitPage, fit, zoomIn, print, download, close];

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
      // The first page whole on the screen. On a phone the width is what limits, so it fills the width there.
      const first = list[0]!.getViewport({ scale: 1 });
      fitWidthScale = (scroller.clientWidth - 32) / first.width;
      fitPageScale = Math.min(fitWidthScale, (scroller.clientHeight - 32) / first.height);
      scale = fitPageScale;
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
