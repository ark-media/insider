import { createFileRoute } from "@tanstack/react-router";
import { HeroArtwork, type ArtVariant } from "../../components/HeroArtwork";

/**
 * TEMPORARY — side-by-side of the candidate /plus hero artworks so a direction
 * can be picked. Delete this route (and the losing variants in HeroArtwork)
 * once one is chosen.
 */
export const Route = createFileRoute("/plus/art-preview")({
  component: ArtPreview,
});

const OPTIONS: { variant: ArtVariant; title: string; note: string }[] = [
  {
    variant: "plus",
    title: "1 — The Plus",
    note: "The brand mark is the picture. The whole roster collaged and punched out in the shape of the Ark+ plus, Dan filling the crossing. Faces that meet the edge get sliced by it — it should read as a cut-out, not a grid of avatars.",
  },
  {
    variant: "nowplaying",
    title: "2 — The Membership",
    note: "The card is the product, and Ark+ is two things — so it is two panels: the private feed mid-playback on top, the community underneath. The level meter on the playing row is the moving part.",
  },
  {
    variant: "stickers",
    title: "3 — Sticker Sheet",
    note: "The roster as die-cut stickers, scattered and overlapping, mixed with a few graphic ones. Photos stay in full colour — the paper edge already hides the mismatched backgrounds.",
  },
  {
    variant: "marquee",
    title: "4 — Marquee",
    note: "Three ticker rows running in opposite directions at different speeds. The motion is the hook — nothing else on the page moves. Rows fade at both edges so the loop has no seam.",
  },
  {
    variant: "dial",
    title: "5 — Radio Dial",
    note: "The card is a tuner: a band of hosts sliding past a cyan playhead, sharp and full size at the centre and dimming away toward the edges, over a dial scale carrying the whole roster as stations.",
  },
];

function ArtPreview() {
  return (
    <section className="section-hero ark-bg grain-overlay relative overflow-hidden">
      <div className="page-gutter relative py-16">
        <div className="eyebrow flex items-center gap-3">
          <span className="h-px w-10 bg-cyan" />
          Hero artwork — options
        </div>

        <div className="mt-12 grid grid-cols-1 gap-16 md:grid-cols-2 md:gap-10 xl:grid-cols-3">
          {OPTIONS.map((o) => (
            <div key={o.variant}>
              <div id={`opt-${o.variant}`} className="relative mx-auto max-w-[380px]">
                <HeroArtwork variant={o.variant} />
              </div>
              <div className="mx-auto mt-8 max-w-[380px]">
                <div className="display-upright text-[22px] text-fg-strong">{o.title}</div>
                <p className="mt-2 text-body-sm text-fg-muted">{o.note}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
