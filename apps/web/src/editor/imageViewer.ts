import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { t } from "@nootion/shared";

/**
 * Shows an image of a page full screen, over everything: a click on it switches between "fit the screen" and its real
 * size (then the view scrolls, with the mouse or a finger); Escape, the close button or a click beside it closes.
 * Plain DOM, so that it works the same in the editor, read-only pages and public links.
 */
export function openImageViewer(src: string, alt = ""): void {
  if (!src || document.querySelector(".nootion-image-viewer")) return;
  const previousFocus = document.activeElement as HTMLElement | null;

  const overlay = document.createElement("div");
  overlay.className = "nootion-image-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", alt || t("imageViewer.label"));

  const scroller = document.createElement("div");
  scroller.className = "nootion-image-viewer__scroller";

  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  img.draggable = false;
  img.title = t("imageViewer.zoom");
  scroller.append(img);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "nootion-image-viewer__close";
  close.setAttribute("aria-label", t("imageViewer.close"));
  close.title = t("imageViewer.close");
  close.textContent = "×";

  const original = document.createElement("a");
  original.className = "nootion-image-viewer__action";
  original.href = src;
  original.target = "_blank";
  original.rel = "noopener noreferrer";
  original.textContent = t("imageViewer.original");

  const download = document.createElement("a");
  download.className = "nootion-image-viewer__action";
  download.href = downloadUrl(src);
  // The server names the file (its original name); for an image from another site, the browser decides.
  download.setAttribute("download", "");
  download.textContent = t("imageViewer.download");

  const actions = document.createElement("div");
  actions.className = "nootion-image-viewer__actions";
  actions.append(original, download);

  overlay.append(scroller, close, actions);
  const controls: HTMLElement[] = [close, original, download];

  const zoom = (on: boolean, at?: { x: number; y: number }) => {
    overlay.classList.toggle("is-zoomed", on);
    img.title = on ? t("imageViewer.fit") : t("imageViewer.zoom");
    // Keep the clicked spot under the pointer once at real size.
    if (on && at) {
      const rect = img.getBoundingClientRect();
      requestAnimationFrame(() => {
        scroller.scrollLeft = (at.x / rect.width) * img.naturalWidth - scroller.clientWidth / 2;
        scroller.scrollTop = (at.y / rect.height) * img.naturalHeight - scroller.clientHeight / 2;
      });
    }
  };
  const shut = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    document.body.style.overflow = bodyOverflow;
    previousFocus?.focus?.({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      shut();
    } else if (e.key === "Tab") {
      // The focus stays in the viewer, going round its controls.
      e.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement);
      controls[(at + (e.shiftKey ? controls.length - 1 : 1)) % controls.length]!.focus();
    }
  };

  img.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = img.getBoundingClientRect();
    zoom(!overlay.classList.contains("is-zoomed"), { x: e.clientX - rect.left, y: e.clientY - rect.top });
  });
  // An image too small to gain anything from its real size: no zoom offered.
  img.addEventListener("load", () => {
    if (img.naturalWidth <= scroller.clientWidth && img.naturalHeight <= scroller.clientHeight) {
      img.style.cursor = "default";
      img.title = "";
      img.addEventListener("click", (e) => e.stopImmediatePropagation(), { capture: true });
    }
  });
  scroller.addEventListener("click", (e) => e.target === scroller && shut());
  close.addEventListener("click", shut);
  document.addEventListener("keydown", onKey, true);

  const bodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.body.append(overlay);
  close.focus({ preventScroll: true });
}

/**
 * Address that downloads the image: Nootion's own files (pages and public links) are sent as a download, with their
 * original name; an image from another site keeps its address.
 */
export function downloadUrl(src: string): string {
  if (!/^\/api\/(public\/[^/?#]+\/)?attachments\/[0-9a-f-]{36}(\?|$)/.test(src)) return src;
  return `${src}${src.includes("?") ? "&" : "?"}download`;
}

/** The image node a DOM element belongs to, if it is the picture of an image block of the page. */
function imageAt(view: EditorView, target: EventTarget | null): { src: string; alt: string } | null {
  if (!(target instanceof HTMLImageElement) || !view.dom.contains(target)) return null;
  try {
    const node = view.state.doc.nodeAt(view.posAtDOM(target, 0));
    if (node?.type.name !== "image" || !node.attrs.src) return null;
    return { src: String(node.attrs.src), alt: String(node.attrs.alt ?? "") };
  } catch {
    return null;
  }
}

/**
 * Opens images full screen: a click when the page is read-only (viewers, public links), a double click while editing
 * (a single click selects the image, to move or delete it). The block menu also offers it.
 */
export const ImageViewer = Extension.create({
  name: "imageViewer",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("imageViewer"),
        props: {
          handleDOMEvents: {
            click: (view, event) => {
              if (editor.isEditable || event.button !== 0) return false;
              const image = imageAt(view, event.target);
              if (!image) return false;
              event.preventDefault();
              openImageViewer(image.src, image.alt);
              return true;
            },
            dblclick: (view, event) => {
              if (!editor.isEditable) return false;
              const image = imageAt(view, event.target);
              if (!image) return false;
              event.preventDefault();
              openImageViewer(image.src, image.alt);
              return true;
            },
          },
        },
      }),
    ];
  },
});
