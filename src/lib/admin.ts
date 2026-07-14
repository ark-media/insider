// Admin back-office API client. Auth rides the httpOnly session cookie
// (credentials:'include'); the server independently re-verifies the "admin"
// role on each request (server/lib/session.ts), so this client is only as
// trusted as that gate.

import type { Announcement } from "./announcements";
import type { Career } from "./careers";
import type { Faq } from "./faqs";
import type { Promo } from "../../shared/promo";
import type { BeehiivDraft, DiscussThread } from "../../shared/discuss-thread";
import type {
  CancellationFilter,
  CancellationSummary,
} from "../../shared/cancellation";
import type { NewsletterSlug } from "../data/newsletters";

export type { Promo, BeehiivDraft, DiscussThread };
export type { CancellationSummary, CancellationFilter };

// Kept as a thin indirection so call sites stay uniform; the session now
// rides the cookie, so this only forwards any extra headers (e.g. content-type).
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...(extra ?? {}) };
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export type AdminMe = { isAdmin: boolean; email: string | null };

export async function fetchAdminMe(): Promise<AdminMe> {
  try {
    const res = await fetch("/api/admin/me", {
      headers: await authHeaders(),
      credentials: "include",
    });
    if (!res.ok) return { isAdmin: false, email: null };
    return (await res.json()) as AdminMe;
  } catch {
    return { isAdmin: false, email: null };
  }
}

// --- Cancellations -------------------------------------------------------

// Serializes the optional outcome/reason filters into a query string (empty
// when nothing is set). Shared by the summary fetch and the CSV export.
function cancellationQuery(filter?: CancellationFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter?.outcome) params.set("outcome", filter.outcome);
  if (filter?.reason) params.set("reason", filter.reason);
  return params;
}

// Read-only survey aggregates for the back office. The filter narrows the
// recent-rows list (the counts stay global). Throws on a non-OK response so the
// page can show a retry.
export async function fetchCancellations(
  filter?: CancellationFilter,
): Promise<CancellationSummary> {
  const qs = cancellationQuery(filter).toString();
  const res = await fetch(`/api/admin/cancellations${qs ? `?${qs}` : ""}`, {
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as CancellationSummary;
}

// Downloads the filtered survey as a CSV. Fetches the blob (so the session
// cookie is sent and a non-OK response surfaces as an error) and triggers a
// save via a transient anchor.
export async function downloadCancellationsCsv(
  filter?: CancellationFilter,
): Promise<void> {
  const params = cancellationQuery(filter);
  params.set("format", "csv");
  const res = await fetch(`/api/admin/cancellations?${params.toString()}`, {
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = csvFilename(res);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Prefer the server's content-disposition filename; fall back to a stable name.
function csvFilename(res: Response): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const match = /filename="?([^"]+)"?/.exec(cd);
  return match?.[1] ?? "cancellations.csv";
}

// --- Announcements -------------------------------------------------------

// What the editor submits. The server sanitizes `body` and validates dates,
// colors, and the action URL before storing.
export type AnnouncementDraft = {
  body: string;
  actionUrl: string;
  barColor: string;
  textColor: string;
  dismissible: boolean;
  enabled: boolean;
  startsAt: string;
  endsAt: string;
};

export async function listAnnouncements(): Promise<Announcement[]> {
  const res = await fetch("/api/admin/announcements", {
    headers: await authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { announcements: Announcement[] }).announcements;
}

export async function saveAnnouncement(
  draft: AnnouncementDraft,
  id?: string,
): Promise<Announcement> {
  const url = id
    ? `/api/admin/announcements?id=${encodeURIComponent(id)}`
    : "/api/admin/announcements";
  const res = await fetch(url, {
    // PUT, not PATCH: the editor always submits the full record (full replace).
    method: id ? "PUT" : "POST",
    headers: await authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify(draft),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { announcement: Announcement }).announcement;
}

export async function deleteAnnouncement(id: string): Promise<void> {
  const res = await fetch(
    `/api/admin/announcements?id=${encodeURIComponent(id)}`,
    { method: "DELETE", headers: await authHeaders(), credentials: "include" },
  );
  if (!res.ok) throw new Error(await errorMessage(res));
}

// --- Careers -------------------------------------------------------------

// What the editor submits. The server derives/normalizes the slug, sanitizes
// the description, and validates the apply URL before storing.
export type CareerDraft = {
  slug: string;
  title: string;
  team: string;
  location: string;
  employmentType: string;
  summary: string;
  description: string;
  applyUrl: string;
  enabled: boolean;
  displayOrder: number;
};

export async function listCareers(): Promise<Career[]> {
  const res = await fetch("/api/admin/careers", {
    headers: await authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { careers: Career[] }).careers;
}

export async function saveCareer(draft: CareerDraft, id?: string): Promise<Career> {
  const url = id
    ? `/api/admin/careers?id=${encodeURIComponent(id)}`
    : "/api/admin/careers";
  const res = await fetch(url, {
    // PUT, not PATCH: the editor always submits the full record (full replace).
    method: id ? "PUT" : "POST",
    headers: await authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify(draft),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { career: Career }).career;
}

export async function deleteCareer(id: string): Promise<void> {
  const res = await fetch(`/api/admin/careers?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

// --- FAQs -----------------------------------------------------------------

// What the editor submits. The server sanitizes the question (plain text) and
// answer (rich HTML) before storing.
export type FaqDraft = {
  question: string;
  answer: string;
  enabled: boolean;
  displayOrder: number;
};

export async function listFaqs(): Promise<Faq[]> {
  const res = await fetch("/api/admin/faqs", {
    headers: await authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { faqs: Faq[] }).faqs;
}

export async function saveFaq(draft: FaqDraft, id?: string): Promise<Faq> {
  const url = id
    ? `/api/admin/faqs?id=${encodeURIComponent(id)}`
    : "/api/admin/faqs";
  const res = await fetch(url, {
    // PUT, not PATCH: the editor always submits the full record (full replace).
    method: id ? "PUT" : "POST",
    headers: await authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify(draft),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { faq: Faq }).faq;
}

export async function deleteFaq(id: string): Promise<void> {
  const res = await fetch(`/api/admin/faqs?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

// --- Promos (Stripe-native) ----------------------------------------------

export type PromoDraft = {
  code: string;
  name: string;
  discountType: "percent" | "amount";
  percentOff?: number;
  amountOffCents?: number;
  duration: "once" | "forever" | "repeating";
  durationInMonths?: number;
  plan: "" | "monthly" | "yearly";
  autoApply: boolean;
  // Flags the coupon for the cancel save flow instead of checkout auto-apply.
  retentionOffer?: boolean;
  maxRedemptions?: number;
  redeemBy?: string;
};

export async function listPromos(): Promise<Promo[]> {
  const res = await fetch("/api/admin/promos", {
    headers: await authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { promos: Promo[] }).promos;
}

export async function createPromo(draft: PromoDraft): Promise<Promo> {
  const res = await fetch("/api/admin/promos", {
    method: "POST",
    headers: await authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify(draft),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { promo: Promo }).promo;
}

export async function deletePromo(id: string): Promise<void> {
  const res = await fetch(`/api/admin/promos?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

// --- Discuss threads -----------------------------------------------------

export async function listBeehiivDrafts(
  newsletterSlug: NewsletterSlug,
): Promise<BeehiivDraft[]> {
  const res = await fetch(
    `/api/admin/beehiiv-drafts?newsletter=${encodeURIComponent(newsletterSlug)}`,
    { headers: await authHeaders(), credentials: "include" },
  );
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { drafts: BeehiivDraft[] }).drafts;
}

export async function listDiscussThreads(): Promise<DiscussThread[]> {
  const res = await fetch("/api/admin/discuss-threads", {
    headers: await authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ((await res.json()) as { threads: DiscussThread[] }).threads;
}

export type CreateDiscussThreadDraft = {
  newsletterSlug: NewsletterSlug;
  beehiivPostId: string;
  beehiivPostTitle: string;
  canonicalUrl?: string;
};

export async function createDiscussThread(
  draft: CreateDiscussThreadDraft,
): Promise<{ thread: DiscussThread; alreadyExisted: boolean }> {
  const res = await fetch("/api/admin/discuss-threads", {
    method: "POST",
    headers: await authHeaders({ "content-type": "application/json" }),
    credentials: "include",
    body: JSON.stringify(draft),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as { thread: DiscussThread; alreadyExisted: boolean };
}

export async function deleteDiscussThread(id: string): Promise<void> {
  const res = await fetch(
    `/api/admin/discuss-threads?id=${encodeURIComponent(id)}`,
    { method: "DELETE", headers: await authHeaders(), credentials: "include" },
  );
  if (!res.ok) throw new Error(await errorMessage(res));
}
