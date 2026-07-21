// Narrow an unknown caught value to a display string, falling back when it
// isn't an Error. Replaces the `err instanceof Error ? err.message : "…"`
// idiom repeated across the admin forms and account pages.
export function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
