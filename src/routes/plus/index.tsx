import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "../../components/Hero";
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
      <Benefits />
      <Pricing />
      <Hosts />
      <FAQ />
    </>
  );
}
