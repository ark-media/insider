import { createFileRoute, Link } from "@tanstack/react-router";
import { AdminShell } from "../../components/AdminShell";

export const Route = createFileRoute("/admin/")({
  component: AdminHome,
});

const CARDS = [
  {
    to: "/admin/announcements",
    title: "Announcements",
    body: "Create and schedule the dismissible banner at the top of the site.",
  },
  {
    to: "/admin/promos",
    title: "Promo codes",
    body: "Create Stripe coupons and promotion codes. Auto-apply ones discount checkout immediately.",
  },
];

function AdminHome() {
  return (
    <AdminShell active="home" title="Overview">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {CARDS.map((card) => (
          <Link
            key={card.to}
            to={card.to}
            className="group block border border-rule p-6 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <h2 className="font-display text-lg text-fg-strong group-hover:text-cyan">
              {card.title}
            </h2>
            <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">
              {card.body}
            </p>
            <span className="mt-4 inline-block text-[12px] font-bold uppercase tracking-button text-cyan">
              Open →
            </span>
          </Link>
        ))}
      </div>
    </AdminShell>
  );
}
