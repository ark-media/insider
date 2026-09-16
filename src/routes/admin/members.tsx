import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminShell } from "../../components/AdminShell";
import {
  listMembers,
  type MemberDirectoryEntry,
  type MemberDirectoryFilter,
} from "../../lib/admin";
import { adminField, adminFieldLabel } from "../../lib/admin-styles";
import { formatTimestamp } from "../../../shared/format-date";

export const Route = createFileRoute("/admin/members")({
  component: MembersAdmin,
});

type TierFilter = "" | "ark-plus" | "circle" | "bundle";
type ActivationFilter = "" | "activated" | "unactivated";

// Short labels for the tier column/filter. `free` only appears via email search
// (a Stripe customer who isn't a paying member).
function tierLabel(tier: MemberDirectoryEntry["tier"]): string {
  switch (tier) {
    case "ark-plus":
      return "Ark+";
    case "circle":
      return "The Fold";
    case "bundle":
      return "Ark+ & The Fold";
    case "free":
      return "Free";
    default:
      return "—";
  }
}

function fmtDate(iso: string | null): string {
  return formatTimestamp(iso) || "—";
}

function MembersAdmin() {
  // Committed filters that drive the fetch. The email box has its own draft
  // state so typing doesn't fire a request per keystroke.
  const [emailDraft, setEmailDraft] = useState("");
  const [email, setEmail] = useState("");
  const [tier, setTier] = useState<TierFilter>("");
  const [activation, setActivation] = useState<ActivationFilter>("");
  const [offset, setOffset] = useState(0);

  const [members, setMembers] = useState<MemberDirectoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Retry button to re-run the current filter.
  const [reloadNonce, setReloadNonce] = useState(0);

  const searching = email.length > 0;

  const filter: MemberDirectoryFilter & { offset?: number } = useMemo(
    () => ({
      email: email || undefined,
      tier: tier || undefined,
      activation: activation || undefined,
      // Email search returns a single result set — offset is ignored server-side.
      offset: searching ? undefined : offset,
    }),
    [email, tier, activation, offset, searching],
  );

  const refresh = useCallback(() => setReloadNonce((n) => n + 1), []);

  // The fetch this render wants. `loading` is derived: it stays true until a
  // response for exactly this request lands, so a filter change or a retry
  // shows the spinner without the effect having to set state synchronously.
  const request = useMemo(() => ({ filter, reloadNonce }), [filter, reloadNonce]);
  const [loaded, setLoaded] = useState<typeof request | null>(null);
  const loading = loaded !== request;

  useEffect(() => {
    let live = true;
    listMembers(request.filter).then(
      (page) => {
        if (!live) return;
        setMembers(page.members);
        setHasMore(page.hasMore);
        setError(null);
        setLoaded(request);
      },
      (err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : "Failed to load.");
        setLoaded(request);
      },
    );
    return () => {
      live = false;
    };
  }, [request]);

  // Any filter change starts back at the first page.
  const changeTier = (v: TierFilter) => {
    setTier(v);
    setOffset(0);
  };
  const changeActivation = (v: ActivationFilter) => {
    setActivation(v);
    setOffset(0);
  };
  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setEmail(emailDraft.trim());
    setOffset(0);
  };
  const clearSearch = () => {
    setEmailDraft("");
    setEmail("");
    setOffset(0);
  };

  return (
    <AdminShell active="members" title="Members">
      <p className="max-w-2xl text-body-sm text-fg-muted">
        The directory is drawn from Stripe (for the email) joined to our
        membership records (for the tier). Members without a Stripe customer —
        redeemed gifts, comps, staff — appear with a blank email and no Stripe
        link.
      </p>

      <form
        onSubmit={submitSearch}
        className="mt-6 flex flex-wrap items-end gap-4"
      >
        <div className="grow">
          <label htmlFor="m-email" className={adminFieldLabel}>
            Search email
          </label>
          <input
            id="m-email"
            type="email"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            placeholder="member@example.com"
            className={`mt-2 ${adminField}`}
          />
        </div>

        <div>
          <label htmlFor="m-tier" className={adminFieldLabel}>
            Tier
          </label>
          <select
            id="m-tier"
            value={tier}
            onChange={(e) => changeTier(e.target.value as TierFilter)}
            className={`mt-2 ${adminField}`}
          >
            <option value="">All tiers</option>
            <option value="ark-plus">Ark+</option>
            <option value="bundle">Ark+ &amp; The Fold</option>
            <option value="circle">The Fold</option>
          </select>
        </div>

        <div>
          <label htmlFor="m-activation" className={adminFieldLabel}>
            Feed activation
          </label>
          <select
            id="m-activation"
            value={activation}
            onChange={(e) => changeActivation(e.target.value as ActivationFilter)}
            className={`mt-2 ${adminField}`}
          >
            <option value="">All</option>
            <option value="activated">Activated</option>
            <option value="unactivated">Not activated</option>
          </select>
        </div>

        <button
          type="submit"
          className="inline-flex min-h-11 items-center justify-center border border-cyan bg-cyan px-5 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Search
        </button>
        {searching ? (
          <button
            type="button"
            onClick={clearSearch}
            className="inline-flex min-h-11 items-center border border-rule-strong px-4 button-text font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Clear
          </button>
        ) : null}
      </form>

      {activation ? (
        <p className="mt-3 text-body-sm text-fg-muted">
          Activation is looked up by email, so this filter applies within each
          loaded page — a page may show fewer than 25 rows.
        </p>
      ) : null}

      {loading ? (
        <p className="mt-8 text-fg-muted">Loading…</p>
      ) : error ? (
        <div className="mt-8">
          <p className="text-body-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-3 inline-flex min-h-10 items-center border border-rule-strong px-4 button-text font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Retry
          </button>
        </div>
      ) : (
        <MembersTable members={members} searching={searching} />
      )}

      {!loading && !error && !searching && (offset > 0 || hasMore) ? (
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - 25))}
            className="inline-flex min-h-10 items-center border border-rule-strong px-4 button-text font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-40 disabled:hover:border-rule-strong disabled:hover:text-fg-strong"
          >
            ← Prev
          </button>
          <button
            type="button"
            disabled={!hasMore}
            onClick={() => setOffset((o) => o + 25)}
            className="inline-flex min-h-10 items-center border border-rule-strong px-4 button-text font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-40 disabled:hover:border-rule-strong disabled:hover:text-fg-strong"
          >
            Next →
          </button>
        </div>
      ) : null}
    </AdminShell>
  );
}

function MembersTable({
  members,
  searching,
}: {
  members: MemberDirectoryEntry[];
  searching: boolean;
}) {
  if (members.length === 0) {
    return (
      <p className="mt-8 text-body-sm text-fg-muted">
        {searching ? "No members match this email." : "No members match these filters."}
      </p>
    );
  }

  return (
    <div className="mt-8 overflow-x-auto">
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-rule text-left text-fg-muted">
            <th className="py-2 pr-4 font-normal">Email</th>
            <th className="py-2 pr-4 font-normal">Name</th>
            <th className="py-2 pr-4 font-normal">Tier</th>
            <th className="py-2 pr-4 font-normal">Feed</th>
            <th className="py-2 pr-4 font-normal">Status</th>
            <th className="py-2 pr-4 font-normal">Renews / ends</th>
            <th className="py-2 font-normal">Stripe</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m, i) => (
            <tr
              key={m.auth0Sub ?? m.stripeCustomerId ?? i}
              className="border-b border-rule/50 align-top"
            >
              <td className="py-2 pr-4 text-fg">{m.email ?? "—"}</td>
              <td className="py-2 pr-4 text-fg-muted">{m.name ?? "—"}</td>
              <td className="py-2 pr-4">
                <span className="inline-flex items-center border border-rule-strong px-2 py-0.5 label font-bold text-fg">
                  {tierLabel(m.tier)}
                </span>
              </td>
              <td className="py-2 pr-4">
                <span
                  className={`inline-flex items-center border px-2 py-0.5 label font-bold ${
                    m.activated
                      ? "border-cyan/60 text-cyan"
                      : "border-rule-strong text-fg-muted"
                  }`}
                >
                  {m.activated ? "activated" : "not set up"}
                </span>
              </td>
              <td className="py-2 pr-4 text-fg">{m.status ?? "—"}</td>
              <td className="py-2 pr-4 whitespace-nowrap text-fg-muted">
                {m.cancelAt ? `ends ${fmtDate(m.cancelAt)}` : fmtDate(m.currentPeriodEnd)}
              </td>
              <td className="py-2">
                {m.stripeCustomerUrl ? (
                  <a
                    href={m.stripeCustomerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="button-text font-bold text-cyan hover:underline"
                  >
                    Open →
                  </a>
                ) : (
                  <span className="text-fg-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
