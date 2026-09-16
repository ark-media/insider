// Public announcement banner data. The body arrives already sanitized by the
// server (server/lib/announcements.ts), so the banner can hand it straight to
// html-react-parser without re-sanitizing.

export type { Announcement } from "../../shared/announcement";
import type { Announcement } from "../../shared/announcement";

export async function fetchActiveAnnouncement(): Promise<Announcement | null> {
  try {
    const res = await fetch("/api/announcements/active");
    if (!res.ok) return null;
    const data = (await res.json()) as { announcement: Announcement | null };
    return data.announcement ?? null;
  } catch {
    return null;
  }
}
