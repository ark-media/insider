import { HostArtwork } from "./HostArtwork";

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
    role: "Regular",
    bio: "Columnist at Yedioth Ahronoth. Author of Revolt. One of Israel's most read journalists.",
    initials: "NE",
    headshot: "/hosts/nadav-eyal.jpg",
  },
  {
    name: "Amit Segal",
    role: "Regular",
    bio: "Chief political analyst for Channel 12 News. The most quoted political voice in Israel.",
    initials: "AS",
    headshot: "/hosts/amit-segal.jpg",
  },
];

export function Hosts() {
  return (
    <section className="relative bg-navy-800/40">
      <div className="mx-auto max-w-[1280px] px-6 py-20 sm:px-10 md:pb-48">
        <div className="mb-16 max-w-2xl">
          <div className="inside-tab text-[13px]">The bylines</div>
          <h2 className="mt-10 text-fg-strong">
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

        <div className="grid grid-cols-1 gap-x-10 gap-y-16 md:grid-cols-3">
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
                variant={i % 2 === 0 ? "primary" : "secondary"}
                className="mb-6"
              />
              <h3 className="display-upright text-[22px] leading-tight text-fg-strong">
                {h.name}
              </h3>
              <p className="mt-2 max-w-sm text-[13px] leading-[1.55] text-fg-muted">
                {h.bio}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
