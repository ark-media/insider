type EventAccess = "ark-plus" | "public";

export type EventFormat = "audio-room" | "video-ama" | "watch-party" | "in-person";

export type ArkEvent = {
  id: string;
  title: string;
  /** ISO timestamp — UTC */
  startsAt: string;
  durationMinutes: number;
  format: EventFormat;
  /**
   * Human label for the format. Set when a source (e.g. Circle's `location_type`)
   * carries a label that doesn't map cleanly onto `format`; the UI prefers it
   * over `FORMAT_LABEL[format]` when present.
   */
  formatLabel?: string;
  access: EventAccess;
  hosts: string[];
  description: string;
  /** Where the event lives. Always Circle for member events; mixed for public ones. */
  location: "circle-app" | "youtube-live" | "in-person";
  /** Optional venue (for in-person) */
  venue?: string;
  /**
   * Ready-to-use deep link into the app for this event, already SSO-wrapped by
   * the data layer. Optional — Circle does not return one for every event.
   */
  deepLink?: string;
};
