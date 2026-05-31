import { useEffect, useState } from "react";
import type { ShowSlug } from "../data/shows";
import { fetchShowDescription } from "./simplecast";

/**
 * Loads the live Simplecast show description for a single show. Returns an
 * empty string while loading, when the show has no Simplecast podcast, or on
 * failure — callers fall back to the hand-written tagline in that case.
 */
export function useShowDescription(slug: ShowSlug): string {
  const [description, setDescription] = useState("");
  useEffect(() => {
    let live = true;
    void fetchShowDescription(slug).then((d) => live && setDescription(d));
    return () => {
      live = false;
    };
  }, [slug]);
  return description;
}

/**
 * Batch variant for grids: loads descriptions for several shows at once and
 * returns a slug → description map. Slugs missing from the map (still loading,
 * no podcast, or failed) should fall back to the tagline.
 */
export function useShowDescriptions(
  slugs: ShowSlug[],
): Record<string, string> {
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  // Re-run only when the set of slugs changes, not on every render (the caller
  // typically passes a freshly-mapped array).
  const key = slugs.join(",");
  useEffect(() => {
    let live = true;
    void Promise.all(
      slugs.map(
        async (slug) => [slug, await fetchShowDescription(slug)] as const,
      ),
    ).then((entries) => {
      if (live) setDescriptions(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return descriptions;
}
