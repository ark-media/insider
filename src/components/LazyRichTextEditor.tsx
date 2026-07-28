import { Suspense, lazy } from "react";
import type { RichTextEditorProps } from "./RichTextEditor";

// TipTap + ProseMirror is ~190 kB gzipped — by far the largest thing the admin
// bundle pulls in, and it's only ever needed on the three back-office pages
// that author rich text. Loading it lazily lets the rest of those pages (the
// list, the plain-text fields, the preview) paint immediately instead of
// waiting on the editor.
const RichTextEditor = lazy(() =>
  import("./RichTextEditor").then((m) => ({ default: m.RichTextEditor })),
);

// Reserves the editor's height so swapping the real editor in doesn't shift the
// form underneath it.
function EditorPlaceholder({ minHeight }: { minHeight?: string }) {
  return (
    <div
      aria-hidden="true"
      className="rounded border border-rule bg-navy-900"
      style={{ minHeight: minHeight ?? "12rem" }}
    />
  );
}

export function LazyRichTextEditor(props: RichTextEditorProps) {
  return (
    <Suspense fallback={<EditorPlaceholder minHeight={props.minHeight} />}>
      <RichTextEditor {...props} />
    </Suspense>
  );
}
