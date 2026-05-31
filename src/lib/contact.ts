import { contactTopics, type ContactTopic } from "../config/urls";

/**
 * Posts a "Get in touch" submission to `/api/contact`, which forwards it to the
 * inbox for the chosen topic server-side. Returns `ok: true` on success, with a
 * user-facing `error` string otherwise. Mirrors `subscribeEmail` in beehiiv.ts.
 */
export async function sendContactMessage(input: {
  name: string;
  email: string;
  topic: ContactTopic;
  message: string;
}): Promise<{ ok: boolean; error?: string }> {
  const name = input.name.trim();
  const email = input.email.trim();
  const message = input.message.trim();

  if (!name) return { ok: false, error: "Please add your name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "That doesn't look like a valid email." };
  }
  if (!contactTopics.some((t) => t.value === input.topic)) {
    return { ok: false, error: "Please choose a topic." };
  }
  if (!message) return { ok: false, error: "Please add a message." };

  try {
    const res = await fetch("/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name, email, topic: input.topic, message }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    switch (body.error) {
      case "invalid_email":
        return { ok: false, error: "That doesn't look like a valid email." };
      case "too_many_requests":
        return { ok: false, error: "Too many attempts. Please wait a moment." };
      default:
        return { ok: false, error: "Could not send. Please try again." };
    }
  } catch {
    return { ok: false, error: "Network error. Please try again." };
  }
}
