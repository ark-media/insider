// Shared Tailwind class strings for the admin back-office forms, so the promo
// and retention-offer forms can't drift apart visually.

export const adminField =
  "w-full border border-rule-strong bg-navy-900 px-3 py-2 text-body text-fg-strong placeholder:text-fg-faint focus:border-cyan focus:outline-none";

export const adminFieldLabel =
  "block button-text font-display font-bold text-fg-strong";

// The primary (filled cyan) submit button used to save/create in every admin
// form, and the secondary (outline) cancel button.
export const adminPrimaryButton =
  "inline-flex min-h-11 items-center justify-center border border-cyan bg-cyan px-5 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60";

export const adminSecondaryButton =
  "inline-flex min-h-11 items-center justify-center border border-rule-strong px-5 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan";
