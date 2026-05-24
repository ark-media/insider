import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/plus/redeem")({
  component: RedeemPage,
});

type RedeemResult =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok"; expiresAt: string }
  | { kind: "error"; message: string };

/**
 * Mock redeem endpoint. Real implementation would:
 *  1. POST /api/gift/redeem with { code, email }
 *  2. The server looks up the gift code, marks it consumed, creates a
 *     fixed-term entitlement, and returns the expiry.
 */
async function mockRedeem(
  code: string,
  email: string,
): Promise<RedeemResult> {
  await new Promise((r) => setTimeout(r, 600));
  const trimmed = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,16}$/.test(trimmed)) {
    return { kind: "error", message: "That code doesn't look right." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return { kind: "error", message: "Please enter a valid email." };
  }
  if (trimmed === "EXPIRED") {
    return { kind: "error", message: "That code has expired." };
  }
  if (trimmed === "USED") {
    return { kind: "error", message: "That code has already been redeemed." };
  }
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);
  return { kind: "ok", expiresAt: expires.toISOString() };
}

const inputClass =
  "w-full border border-rule-strong bg-transparent px-3 py-2.5 text-fg-strong placeholder:text-fg-muted outline-none transition focus:border-cyan disabled:opacity-50";

function RedeemPage() {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<RedeemResult>({ kind: "idle" });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResult({ kind: "submitting" });
    setResult(await mockRedeem(code, email));
  };

  return (
    <main className="relative">
      <section className="relative">
        <div className="mx-auto max-w-[1280px] px-6 pt-16 pb-24 sm:px-10">
          <div className="grid grid-cols-1 gap-14 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <div className="inside-tab text-[13px]">Redeem an Ark+ gift</div>
              <h1 className="mt-10 text-fg-strong">
                <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                  Got a code?
                </span>
                <span className="display-upright block text-[clamp(1.9rem,4vw,3.2rem)]">
                  <span className="display text-cyan">Redeem</span> it.
                </span>
              </h1>
              <p className="mt-6 max-w-md text-[14px] leading-[1.6] text-fg">
                Enter the code from your gift email along with the email you
                want associated with your Ark+ membership. We'll handle the
                rest.
              </p>
            </div>

            <div className="lg:col-span-7">
              {result.kind === "ok" ? (
                <div className="border border-cyan/40 bg-navy-800/40 p-8">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                    You're in
                  </div>
                  <h2 className="mt-4 font-display text-[28px] leading-tight text-fg-strong">
                    Welcome to Ark+.
                  </h2>
                  <p className="mt-4 max-w-md text-[14px] leading-[1.6] text-fg">
                    Your gift has been redeemed. Your access runs through{" "}
                    <strong className="text-fg-strong">
                      {new Date(result.expiresAt).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </strong>
                    . We've sent a sign-in link to {email}.
                  </p>
                  <Link
                    to="/welcome"
                    className="mt-6 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan"
                  >
                    Set up your access →
                  </Link>
                </div>
              ) : (
                <form onSubmit={onSubmit} className="border border-rule bg-navy-800/50 p-8">
                  <label
                    htmlFor="redeem-code"
                    className="block text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted"
                  >
                    Gift code
                  </label>
                  <input
                    id="redeem-code"
                    type="text"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="ARK-XXXX-XXXX"
                    className={`${inputClass} mt-3 font-mono uppercase`}
                  />

                  <label
                    htmlFor="redeem-email"
                    className="mt-6 block text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted"
                  >
                    Your email
                  </label>
                  <input
                    id="redeem-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className={`${inputClass} mt-3`}
                  />

                  <button
                    type="submit"
                    disabled={result.kind === "submitting"}
                    className="group mt-8 inline-flex w-full items-center justify-between bg-cyan px-5 py-3 font-display text-[13px] font-bold uppercase tracking-[0.08em] text-navy transition hover:bg-fg-strong hover:text-navy-900 disabled:opacity-60"
                  >
                    {result.kind === "submitting" ? "Redeeming…" : "Redeem"}
                    <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                      →
                    </span>
                  </button>

                  {result.kind === "error" ? (
                    <p
                      className="mt-3 text-[12px] text-danger"
                      aria-live="polite"
                    >
                      {result.message}
                    </p>
                  ) : null}
                </form>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
