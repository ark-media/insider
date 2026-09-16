// Small play-triangle icon shown on episode/show cards. Inherits color via
// `currentColor` and is decorative (aria-hidden).
export function PlayGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M2 1.2v7.6a.4.4 0 0 0 .61.34l6.1-3.8a.4.4 0 0 0 0-.68L2.61.86A.4.4 0 0 0 2 1.2Z" />
    </svg>
  );
}
