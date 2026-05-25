// Admin back-office API client. Every call attaches the Auth0 Bearer token;
// the server independently re-verifies the "admin" role on each request
// (server/lib/session.ts), so this client is only as trusted as that gate.

import { getToken } from "./tokenStore";
import type { Announcement } from "./announcements";
import type { Promo } from "../../shared/promo";

export type { Promo };

async function authHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await getToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
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
