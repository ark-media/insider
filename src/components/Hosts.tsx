import { HostArtwork } from "./HostArtwork";
import { PORTRAIT_SIZES } from "../lib/images";

const hosts = [
  {
    name: "Dan Senor",
    role: "Host",
    bio: "Author of The Genius of Israel and Start-Up Nation. Former foreign policy advisor.",
    initials: "DS",
    headshot: "/hosts/dan-senor.jpg",
  },
  {
    name: "Nadav Eyal",
    role: "Call Me Back Contributor",
    bio: "Columnist at Yedioth Ahronoth. Author of Revolt. One of Israel's most read journalists.",
    initials: "NE",
    headshot: "/hosts/nadav-eyal.jpg",
  },
  {
    name: "Amit Segal",
    role: "Call Me Back Contributor",
    bio: "Chief political analyst for Channel 12 News. The most quoted political voice in Israel.",
    initials: "AS",
    headshot: "/hosts/amit-segal.jpg",
  },
];

export function Hosts() {
  return (
    <section className="relative">
      <div className="page-section md:pb-24">
        <div className="mb-8 max-w-2xl">
          <h2 className="text-fg-strong">
            <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
              Three voices.
            </span>
            <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
              One <span className="display text-cyan">unusually good</span>
            </span>
            <span className="display-upright block text-[clamp(1.8rem,3.6vw,3rem)]">
              group chat.
            </span>
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-12 md:grid-cols-3 md:gap-x-10">
          {hosts.map((h, i) => (
            <article
              key={h.name}
              className={i === 1 ? "md:translate-y-14" : i === 2 ? "md:translate-y-28" : ""}
            >
              <HostArtwork
                initials={h.initials}
                role={h.role}
                photo={h.headshot}
                name={h.name}
                sizes={PORTRAIT_SIZES}
                variant={i % 2 === 0 ? "primary" : "secondary"}
                className="mb-6 max-w-[200px]"
              />
              <h3 className="display-upright text-[22px] leading-tight text-fg-strong">
                {h.name}
              </h3>
              <p className="mt-2 max-w-sm text-body-sm">
                {h.bio}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
