import { Masthead } from "../components/Masthead";
import { Hero } from "../components/Hero";
import { Marquee } from "../components/Marquee";
import { Benefits } from "../components/Benefits";
import { PullQuote } from "../components/PullQuote";
import { Pricing } from "../components/Pricing";
import { Hosts } from "../components/Hosts";
import { FAQ } from "../components/FAQ";
import { Footer } from "../components/Footer";

export function Home() {
  return (
    <div className="min-h-dvh font-sans text-ink">
      <Masthead />
      <Hero />
      <Marquee />
      <Benefits />
      <PullQuote />
      <Pricing />
      <Hosts />
      <FAQ />
      <Footer />
    </div>
  );
}
