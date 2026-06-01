/**
 * Inline "this section couldn't load" card with an in-place retry. Rendered in
 * place of content that failed to fetch from an external service, so the rest of
 * the page keeps working. Matches the site's card styling (border-rule /
 * navy-800) and the outlined-button treatment used by HomeButton in StatusPage.
 */
export function ContentError({
  message = "We couldn't load this right now.",
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="border border-rule bg-navy-800/40 p-8 sm:p-10"
    >
      <p className="eyebrow text-fg-muted">Something went wrong</p>
      <p className="mt-4 max-w-md text-body-sm">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 inline-flex items-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        <span aria-hidden="true">↻</span>
        Refresh
      </button>
    </div>
  );
}
