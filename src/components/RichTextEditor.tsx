import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { useEffect } from "react";
import { RICH_TEXT_CLASS } from "../lib/richTextPreview";

// A small WYSIWYG editor for the admin back office. Non-technical admins format
// text with toolbar buttons instead of writing raw HTML; the editor emits the
// same restricted HTML the server sanitizes on save (server/lib/richText.ts),
// so the security boundary is unchanged — this is purely an authoring surface.
//
// Every back-office editor (FAQs, careers, announcements) uses this same
// component with the same full toolbar, so the formatting experience is
// identical everywhere. Enter starts a new paragraph; Shift+Enter inserts a
// line break — both are preserved through the server allowlist.

type Props = {
  value: string;
  onChange: (html: string) => void;
  ariaLabel: string;
  /** Minimum editing height, e.g. "12rem". */
  minHeight?: string;
};

function buildExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3, 4] },
      link: {
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      },
      // Not part of the shared allowlist — keep them off.
      codeBlock: false,
      code: false,
      horizontalRule: false,
    }),
  ];
}

// Padding/sizing/focus for the editing surface, plus the shared rich-text
// styling so what's typed matches the preview and the live site.
const CONTENT_CLASS = `px-3 py-2 text-body text-fg-strong focus:outline-none ${RICH_TEXT_CLASS}`;

export function RichTextEditor({
  value,
  onChange,
  ariaLabel,
  minHeight = "8rem",
}: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: buildExtensions(),
    content: value || "",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
        class: CONTENT_CLASS,
      },
    },
    onUpdate: ({ editor }) => {
      // Collapse Tiptap's empty document ("<p></p>") to "" so the existing
      // server-side "required" validation still triggers on empty input.
      onChange(editor.isEmpty ? "" : editor.getHTML());
    },
  });

  // Keep the editor in sync when the form's value changes from the outside
  // (switching which item is being edited, or resetting after save).
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (value !== current) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [editor, value]);

  const active = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            bold: editor.isActive("bold"),
            italic: editor.isActive("italic"),
            underline: editor.isActive("underline"),
            strike: editor.isActive("strike"),
            link: editor.isActive("link"),
            bulletList: editor.isActive("bulletList"),
            orderedList: editor.isActive("orderedList"),
            h2: editor.isActive("heading", { level: 2 }),
            h3: editor.isActive("heading", { level: 3 }),
          }
        : null,
  });

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return; // cancelled
    const chain = editor.chain().focus().extendMarkRange("link");
    if (url.trim() === "") chain.unsetLink().run();
    else chain.setLink({ href: url.trim() }).run();
  };

  const buttons: {
    label: React.ReactNode;
    title: string;
    isActive: boolean;
    run: () => void;
  }[] = [
    {
      label: "H2",
      title: "Heading",
      isActive: !!active?.h2,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "H3",
      title: "Subheading",
      isActive: !!active?.h3,
      run: () => editor?.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      label: <span className="font-bold">B</span>,
      title: "Bold",
      isActive: !!active?.bold,
      run: () => editor?.chain().focus().toggleBold().run(),
    },
    {
      label: <span className="italic">I</span>,
      title: "Italic",
      isActive: !!active?.italic,
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: <span className="underline">U</span>,
      title: "Underline",
      isActive: !!active?.underline,
      run: () => editor?.chain().focus().toggleUnderline().run(),
    },
    {
      label: <span className="line-through">S</span>,
      title: "Strikethrough",
      isActive: !!active?.strike,
      run: () => editor?.chain().focus().toggleStrike().run(),
    },
    {
      label: "• List",
      title: "Bulleted list",
      isActive: !!active?.bulletList,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: "1. List",
      title: "Numbered list",
      isActive: !!active?.orderedList,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "Link",
      title: "Add or edit link",
      isActive: !!active?.link,
      run: setLink,
    },
  ];

  return (
    <div>
      <div
        className="flex flex-wrap gap-1"
        role="toolbar"
        aria-label={`${ariaLabel} formatting`}
      >
        {buttons.map((b, i) => (
          <button
            key={i}
            type="button"
            title={b.title}
            aria-label={b.title}
            aria-pressed={b.isActive}
            onClick={b.run}
            className={`inline-flex h-8 min-w-8 items-center justify-center border px-2 text-body-sm transition ${
              b.isActive
                ? "border-cyan bg-cyan/10 text-cyan"
                : "border-rule-strong text-fg-strong hover:border-cyan hover:text-cyan"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div
        className="mt-2 border border-rule-strong bg-navy-900 transition focus-within:border-cyan [&_.ProseMirror]:min-h-[var(--rte-min)] [&_.ProseMirror]:outline-none"
        style={{ "--rte-min": minHeight } as React.CSSProperties}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
