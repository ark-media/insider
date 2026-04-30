import { useCallback, useState } from "react";
import { Modal } from "./Modal";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

export function SignInModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const handleClose = useCallback(() => {
    setStatus({ kind: "idle" });
    setEmail("");
    onClose();
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus({ kind: "loading" });
    try {
      const res = await fetch("/api/sc/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        bypass?: boolean;
      };
      if (!res.ok) {
        setStatus({
          kind: "error",
          message: data.error ?? "Something went wrong. Please try again.",
        });
        return;
      }
      if (data.bypass) {
        // Dev-only path: server already issued the session cookie. Do a full
        // reload so /api/me runs fresh with the new cookie before /setup mounts.
        window.location.href = "/setup";
        return;
      }
      setStatus({ kind: "sent", email: email.trim() });
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    }
  };

  return (
    <Modal open={open} onClose={handleClose} className="max-w-md">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cyan">
        Subscriber Access
      </p>
      <h2 className="display-upright mt-3 text-[clamp(1.6rem,3vw,2rem)] leading-[1.05] text-white">
        Sign in
      </h2>

      {status.kind === "sent" ? (
        <div className="mt-6 space-y-3 text-sm text-white/80">
          <p>
            Check <span className="font-semibold text-white">{status.email}</span>{" "}
            for a sign-in link. It may take a moment to arrive.
          </p>
          <p className="text-white/55">
            Click the link in that email to finish signing in. You'll land
            back here, ready to set up your private feed.
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="mt-4 w-full border border-white/30 px-4 py-2.5 text-sm font-semibold uppercase tracking-wider transition hover:border-cyan hover:bg-cyan hover:text-navy"
          >
            Close
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <p className="text-sm text-white/70">
            Enter the email associated with your membership. We'll send you a
            secure link to sign in.
          </p>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/55">
              Email
            </span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={status.kind === "loading"}
              placeholder="you@example.com"
              className="mt-2 w-full border border-white/20 bg-transparent px-3 py-2.5 text-white placeholder-white/30 outline-none transition focus:border-cyan disabled:opacity-50"
            />
          </label>
          {status.kind === "error" ? (
            <p className="text-[13px] text-signal/90">{status.message}</p>
          ) : null}
          <button
            type="submit"
            disabled={status.kind === "loading"}
            className="w-full border border-cyan bg-cyan px-4 py-2.5 text-sm font-semibold uppercase tracking-wider text-navy transition hover:bg-transparent hover:text-cyan disabled:opacity-60"
          >
            {status.kind === "loading" ? "Sending…" : "Send sign-in link"}
          </button>
        </form>
      )}
    </Modal>
  );
}
