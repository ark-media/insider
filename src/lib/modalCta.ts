// Shared button class strings for the checkout/gift payment modals, so the two
// surfaces can't drift apart. Primary = filled cyan that inverts to outline on
// hover; secondary = neutral outline that fills cyan on hover. Callers prepend
// spacing utilities (e.g. `mt-4`) as needed.

export const modalPrimaryCta =
  "inline-flex min-h-12 w-full items-center justify-center border border-cyan bg-cyan px-4 text-sm font-semibold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60";

export const modalSecondaryCta =
  "inline-flex min-h-12 w-full items-center justify-center border border-rule-strong px-4 text-sm font-semibold uppercase tracking-button transition hover:border-cyan hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";
