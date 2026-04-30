import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "../../components/Hero";
import { Marquee } from "../../components/Marquee";
import { Benefits } from "../../components/Benefits";
import { Pricing } from "../../components/Pricing";
import { Hosts } from "../../components/Hosts";
import { FAQ } from "../../components/FAQ";

export const Route = createFileRoute("/plus/")({
  component: PlusPage,
});

function PlusPage() {
  return (
    <>
      <Hero />
      <Marquee />
      <Benefits />
      <Pricing />
      <Hosts />
      <FAQ />
    </>
  );
}
