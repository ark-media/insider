import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PlaceholderSection } from "../components/PageShell";

export const Route = createFileRoute("/about")({
  component: AboutPage,
});

function AboutPage() {
  return (
    <PageShell
      eyebrow="About"
      title="Ark Media."
      lede="An independent media company built around long-form journalism, serious conversations, and the audiences that show up for both."
    >
      <PlaceholderSection
        title="Our shows"
        body="A short note on each of our podcasts and newsletters."
      />
      <PlaceholderSection
        title="The team"
        body="Hosts, editors, and producers."
      />
      <PlaceholderSection
        title="Contact"
        body="Press, partnerships, and listener mail."
      />
    </PageShell>
  );
}
