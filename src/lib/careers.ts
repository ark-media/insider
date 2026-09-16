// Public careers data. The description arrives already sanitized by the server
// (server/lib/careers.ts), so the detail page can hand it straight to
// html-react-parser without re-sanitizing.

export type { Career } from "../../shared/career";
import type { Career } from "../../shared/career";

export async function fetchCareers(): Promise<Career[]> {
  try {
    const res = await fetch("/api/careers");
    if (!res.ok) return [];
    const data = (await res.json()) as { careers: Career[] };
    return data.careers ?? [];
  } catch {
    return [];
  }
}

export async function fetchCareer(slug: string): Promise<Career | null> {
  try {
    const res = await fetch(`/api/careers?slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { career: Career | null };
    return data.career ?? null;
  } catch {
    return null;
  }
}
