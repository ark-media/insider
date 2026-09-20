// Public Open House data for the /fold page. The server has already filtered
// to upcoming sessions and sorted them (server/routes/open-houses.ts), so the
// page renders what it gets in the order it arrives.

export type { OpenHouseSession } from "../../shared/open-house";
import type { OpenHouseSession } from "../../shared/open-house";

/**
 * Never rejects: an outage arrives as an empty list, which the section reads as
 * "nothing scheduled" and hides. A marketing band is not worth an error state.
 */
export async function fetchUpcomingOpenHouses(): Promise<OpenHouseSession[]> {
  try {
    const res = await fetch("/api/open-houses");
    if (!res.ok) return [];
    const data = (await res.json()) as { sessions?: OpenHouseSession[] };
    return data.sessions ?? [];
  } catch {
    return [];
  }
}
