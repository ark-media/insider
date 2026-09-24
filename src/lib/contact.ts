import { contactTopics, type ContactTopic } from "../config/urls";
import {
  isListenerQuestionShow,
  type ListenerQuestionShow,
} from "../data/shows";

/**
 * Posts a "Get in touch" submission to `/api/contact`, which forwards it to the
 * inbox for the chosen topic server-side. Returns `ok: true` on success, with a
 * user-facing `error` string otherwise. Mirrors `subscribeEmail` in beehiiv.ts.
 */
export async function sendContactMessage(input: {
  firstName: string;
  lastName: string;
  email: string;
  /** Optional: where the sender listens from. */
  location?: string;
  topic: ContactTopic;
  /** Required when `topic` is "questions"; ignored otherwise. */
  show?: ListenerQuestionShow | "";
  message: string;
}): Promise<{ ok: boolean; error?: string }> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const email = input.email.trim();
  const location = input.location?.trim() ?? "";
  const message = input.message.trim();

  if (!firstName) return { ok: false, error: "Please add your first name." };
  if (!lastName) return { ok: false, error: "Please add your last name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "That doesn't look like a valid email." };
  }
  if (!contactTopics.some((t) => t.value === input.topic)) {
    return { ok: false, error: "Please choose a topic." };
  }
  const show = input.topic === "questions" ? input.show : undefined;
  if (input.topic === "questions" && !isListenerQuestionShow(show)) {
    return { ok: false, error: "Please choose a show." };
  }
  if (!message) return { ok: false, error: "Please add a message." };

  try {
    const res = await fetch("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        firstName,
        lastName,
        email,
        location,
        topic: input.topic,
        show,
        message,
      }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    switch (body.error) {
      case "invalid_email":
        return { ok: false, error: "That doesn't look like a valid email." };
      case "invalid_show":
        return { ok: false, error: "Please choose a show." };
      case "too_many_requests":
        return { ok: false, error: "Too many attempts. Please wait a moment." };
      default:
        return { ok: false, error: "Could not send. Please try again." };
    }
  } catch {
    return { ok: false, error: "Network error. Please try again." };
  }
}
