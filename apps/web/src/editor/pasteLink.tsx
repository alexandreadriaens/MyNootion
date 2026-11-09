import { Extension, type Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Fragment, type Mark, type MarkType, type Node as PMNode, type ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { AtSign, Bookmark, Link as LinkIcon, Loader2, PlayCircle } from "lucide-react";
import { pluginNodeName, t } from "@nootion/shared";
import { linkHandler } from "../plugins/registry";

/**
 * A link pasted alone, as in Notion: it is first written as a link, and a menu offers to turn it into a mention (the
 * page's title with its site's icon), a bookmark card or an embed (a video player…). Typing, moving the cursor or
 * Escape keeps the plain link. Bookmarks and embeds are blocks of the plugin offering them (the "Embeds" plugin).
 */

/** The class of a link shown as a mention. It stays a plain link for exports, search and Markdown. */
export const MENTION_CLASS = "nootion-link-mention";

type Choice = "url" | "mention" | "bookmark" | "embed";
interface PastedLink {
  from: number;
  to: number;
  url: string;
  /** The choice picked with the arrow keys, -1 before. */
  active: number;
  /** The choice being prepared (the page's title or preview is read first). */
  busy: Choice | null;
}

export const pasteLinkKey = new PluginKey<PastedLink | null>("pasteLink");

/** The web address the pasted text is, when it is one and nothing else. */
export function pastedUrl(text: string): string | null {
  const s = text.trim();
  if (s.length > 2048 || !/^https?:\/\/\S+$/i.test(s)) return null;
  try {
    const url = new URL(s);
    return url.protocol === "http:" || url.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/** What the link can become: a bookmark and an embed need a plugin offering them, and an embed a site it knows. */
function choicesFor(url: string): Choice[] {
  const handler = linkHandler();
  const choices: Choice[] = ["url", "mention"];
  if (handler) choices.push("bookmark");
  if (handler?.embed(url)) choices.push("embed");
  return choices;
}

export const PasteLinkMenu = Extension.create({
  name: "pasteLinkMenu",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<PastedLink | null>({
        key: pasteLinkKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(pasteLinkKey) as PastedLink | null | undefined;
            if (meta !== undefined) return meta;
            if (!value) return null;
            const from = tr.mapping.map(value.from, 1);
            const to = tr.mapping.map(value.to, -1);
            // Typing, moving the cursor or clicking elsewhere keeps the plain link.
            if (from >= to || !tr.selection.empty || tr.selection.from !== to) return null;
            return from === value.from && to === value.to ? value : { ...value, from, to };
          },
        },
        props: {
          handlePaste(view, event) {
            if (!view.editable || event.clipboardData?.files.length) return false;
            const url = pastedUrl(event.clipboardData?.getData("text/plain") ?? "");
            const { state } = view;
            const link = state.schema.marks.link;
            // Pasted over a selection, the link goes on the selected text (as before).
            if (!url || !link || !state.selection.empty) return false;
            const { $from } = state.selection;
            if ($from.parent.type.spec.code || !$from.parent.type.allowsMarkType(link)) return false;
            const marks = $from.marks().filter((m) => m.type !== link);
            const tr = state.tr.replaceSelectionWith(state.schema.text(url, [...marks, link.create({ href: url })]), false);
            const to = tr.selection.from;
            tr.setMeta(pasteLinkKey, { from: to - url.length, to, url, active: -1, busy: null } satisfies PastedLink);
            view.dispatch(tr.scrollIntoView());
            return true;
          },
          // Links grow with what is typed at their end (to finish typing an address). Not a space after an address,
          // nor anything after a mention: that is the text that follows. (TipTap only unlinks a space typed alone.)
          handleTextInput(view, from, to, text) {
            const link = view.state.schema.marks.link;
            const ended = link && from === to ? linkEndingAt(view.state.doc.resolve(from), link) : null;
            if (!ended || !(isMention(ended.mark) || (ended.text === ended.mark.attrs.href && /^\s/.test(text)))) return false;
            view.dispatch(view.state.tr.insertText(text, from, to).removeMark(from, from + text.length, link));
            return true;
          },
          handleKeyDown(view, event) {
            const pasted = pasteLinkKey.getState(view.state);
            if (!pasted || pasted.busy) return false;
            const choices = choicesFor(pasted.url);
            if (event.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(pasteLinkKey, null));
              return true;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              const n = choices.length;
              const active = event.key === "ArrowDown" ? (pasted.active + 1) % n : pasted.active <= 0 ? n - 1 : pasted.active - 1;
              view.dispatch(view.state.tr.setMeta(pasteLinkKey, { ...pasted, active }));
              return true;
            }
            // Enter picks the choice reached with the arrows; otherwise it starts a new line, as usual.
            if (event.key === "Enter" && pasted.active >= 0) {
              void choosePasteOption(editor, choices[pasted.active]!);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

/** Turns the pasted link into what was chosen. */
export async function choosePasteOption(editor: Editor, choice: Choice): Promise<void> {
  const view = editor.view;
  const pasted = pasteLinkKey.getState(view.state);
  if (!pasted || pasted.busy) return;
  if (choice === "url") {
    view.dispatch(view.state.tr.setMeta(pasteLinkKey, null));
    view.focus();
    return;
  }
  const handler = linkHandler();
  view.dispatch(view.state.tr.setMeta(pasteLinkKey, { ...pasted, busy: choice }));
  let title = "";
  let data: Record<string, unknown> | null = null;
  try {
    if (choice === "mention") title = (await handler?.title(pasted.url)) ?? "";
    else if (handler) data = choice === "embed" ? handler.embed(pasted.url) : await handler.bookmark(pasted.url);
  } catch {
    // The page couldn't be read: a mention shows the address instead, a bookmark is not made.
  }
  // Typing or clicking elsewhere meanwhile kept the plain link.
  const now = view.isDestroyed ? null : pasteLinkKey.getState(view.state);
  if (!now || now.url !== pasted.url || now.busy !== choice) return;
  // Not TipTap's autolink: it would take a title's last "…" or "—" for a space and leave it out of the link.
  const tr = view.state.tr.setMeta(pasteLinkKey, null).setMeta("preventAutolink", true);
  if (choice === "mention") toMention(tr, now, title.trim() || shortAddress(now.url));
  else {
    const type = handler && view.state.schema.nodes[pluginNodeName(handler.pluginId, handler.blockId)];
    if (type && data) insertBlock(tr, now, type.create({ data: JSON.stringify(data) }));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** "youtube.com/watch?v=…", for a mention whose page has no title. */
function shortAddress(url: string): string {
  const text = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** A title short enough for a line of text, cut between words. */
function shortTitle(title: string, max = 100): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

function toMention(tr: Transaction, pasted: PastedLink, title: string) {
  const link = tr.doc.type.schema.marks.link!;
  const others = (tr.doc.nodeAt(pasted.from)?.marks ?? []).filter((m) => m.type !== link);
  const text = shortTitle(title);
  tr.replaceWith(pasted.from, pasted.to, tr.doc.type.schema.text(text, [...others, link.create({ href: pasted.url, class: MENTION_CLASS })]));
  tr.setSelection(TextSelection.create(tr.doc, pasted.from + text.length));
}

/** The link that ends right before this position (not going on after it), with its text. */
function linkEndingAt($pos: ResolvedPos, link: MarkType): { mark: Mark; text: string } | null {
  const mark = $pos.nodeBefore && link.isInSet($pos.nodeBefore.marks);
  if (!mark || ($pos.nodeAfter && mark.isInSet($pos.nodeAfter.marks))) return null;
  let text = "";
  for (let i = $pos.index() - 1; i >= 0; i--) {
    const node = $pos.parent.child(i);
    if (!node.isText || !mark.isInSet(node.marks)) break;
    text = node.text + text;
  }
  return { mark, text };
}

/**
 * The block takes the place of the line when the link was alone on it (with an empty line after it, to keep writing,
 * when it ends the page); otherwise the link leaves the text and the block goes under the line.
 */
function insertBlock(tr: Transaction, pasted: PastedLink, block: PMNode) {
  const $from = tr.doc.resolve(pasted.from);
  const depth = $from.depth;
  const line = $from.parent;
  const container = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  let onlyText = true;
  line.forEach((n) => (onlyText &&= n.isText));
  const alone = onlyText && line.textContent.trim() === tr.doc.textBetween(pasted.from, pasted.to);
  if (alone && container.canReplaceWith(index, index + 1, block.type)) {
    const start = $from.before(depth);
    const paragraph = tr.doc.type.schema.nodes.paragraph;
    const withLine = paragraph && index === container.childCount - 1 ? Fragment.from([block, paragraph.create()]) : null;
    tr.replaceWith(start, $from.after(depth), withLine && container.canReplace(index, index + 1, withLine) ? withLine : block);
    tr.setSelection(Selection.near(tr.doc.resolve(start + block.nodeSize)));
    return;
  }
  const after = $from.after(depth);
  const outer = $from.after(1);
  tr.delete(pasted.from, pasted.to);
  tr.insert(tr.mapping.map(container.canReplaceWith(index + 1, index + 1, block.type) ? after : outer), block);
}

const CHOICES: Record<Choice, { icon: typeof LinkIcon; label: () => string; help: () => string }> = {
  url: { icon: LinkIcon, label: () => t("pasteLink.url"), help: () => t("pasteLink.urlHelp") },
  mention: { icon: AtSign, label: () => t("pasteLink.mention"), help: () => t("pasteLink.mentionHelp") },
  bookmark: { icon: Bookmark, label: () => t("pasteLink.bookmark"), help: () => t("pasteLink.bookmarkHelp") },
  embed: { icon: PlayCircle, label: () => t("pasteLink.embed"), help: () => t("pasteLink.embedHelp") },
};

/** The menu under a pasted link. */
export function PasteLinkMenuView({ editor }: { editor: Editor }) {
  const pasted = useEditorState({ editor, selector: ({ editor: e }) => (e ? (pasteLinkKey.getState(e.state) ?? null) : null) });
  const choices = pasted ? choicesFor(pasted.url) : [];
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="pasteLinkMenu"
      shouldShow={({ state }) => !!pasteLinkKey.getState(state)}
      options={{ placement: "bottom-start", offset: 6, flip: true, shift: { padding: 8 } }}
      className="z-30 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      {/* The width is set here: the menu's own box is sized to its content ("max-content"). */}
      <div role="menu" aria-label={t("pasteLink.menu")} className="w-64 max-w-[calc(100vw-2rem)]">
        {choices.map((choice, i) => {
          const { icon: Icon, label, help } = CHOICES[choice];
          return (
            <button
              key={choice}
              type="button"
              role="menuitem"
              disabled={!!pasted?.busy}
              // Keeps the cursor in the page, after the link.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void choosePasteOption(editor, choice)}
              className={`flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left disabled:cursor-wait ${
                pasted?.active === i ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              {pasted?.busy === choice ? (
                <Loader2 size={16} className="shrink-0 animate-spin text-neutral-500" />
              ) : (
                <Icon size={16} className="shrink-0 text-neutral-500" />
              )}
              <span className="min-w-0 flex-1 overflow-hidden">
                <span className="block text-sm">{label()}</span>
                <span className="block truncate text-xs text-neutral-500">{help()}</span>
              </span>
            </button>
          );
        })}
      </div>
    </BubbleMenu>
  );
}

/** A small globe, for sites without an icon. */
const GLOBE =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
  );

function mentionIcon(href: string) {
  return () => {
    const img = document.createElement("img");
    img.className = "nootion-link-mention__icon";
    img.alt = "";
    img.draggable = false;
    img.referrerPolicy = "no-referrer";
    img.setAttribute("aria-hidden", "true");
    img.onerror = () => {
      img.onerror = null;
      img.src = GLOBE;
    };
    try {
      const url = new URL(href);
      img.src = url.protocol === "http:" || url.protocol === "https:" ? `${url.origin}/favicon.ico` : GLOBE;
    } catch {
      img.src = GLOBE;
    }
    return img;
  };
}

const isMention = (m: Mark) => m.type.name === "link" && String(m.attrs.class ?? "").split(/\s+/).includes(MENTION_CLASS);

/** The site's icon before each mention (drawn, not stored: the page keeps a plain link). */
function mentionIcons(doc: PMNode): DecorationSet {
  const icons: Decoration[] = [];
  let previous: { mark: Mark; end: number } | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find(isMention);
    if (mark && !(previous && previous.end === pos && previous.mark.eq(mark)))
      icons.push(Decoration.widget(pos, mentionIcon(String(mark.attrs.href)), { side: 1, key: `mention-icon:${mark.attrs.href}` }));
    previous = mark ? { mark, end: pos + node.nodeSize } : null;
    return false;
  });
  return DecorationSet.create(doc, icons);
}

const mentionIconsKey = new PluginKey<DecorationSet>("linkMentionIcons");

/** Draws mentions of links with their site's icon, in the editor and on public pages. */
export const LinkMentions = Extension.create({
  name: "linkMentions",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: mentionIconsKey,
        state: {
          init: (_, state) => mentionIcons(state.doc),
          apply: (tr, icons) => (tr.docChanged ? mentionIcons(tr.doc) : icons),
        },
        props: { decorations: (state) => mentionIconsKey.getState(state) },
      }),
    ];
  },
});
