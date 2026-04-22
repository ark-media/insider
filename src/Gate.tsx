import { Show, SignInButton, SignUpButton } from "@clerk/react";
import type { ReactNode } from "react";

export function Gate({ children }: { children: ReactNode }) {
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <div className="flex min-h-dvh items-center justify-center bg-navy-900 px-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-navy-800 p-8 text-center">
            <p className="font-display text-xs uppercase tracking-[0.2em] text-cyan">
              Preview access
            </p>
            <h1 className="mt-3 font-display text-2xl text-white">
              Insider is in testing
            </h1>
            <p className="mt-2 text-sm text-white/60">
              Sign in to continue.
            </p>
            <div className="mt-6 flex flex-col gap-2">
              <SignInButton mode="modal">
                <button className="w-full rounded-lg bg-cyan px-4 py-2 font-medium text-navy-900 hover:brightness-110">
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button className="w-full rounded-lg border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/5">
                  Create account
                </button>
              </SignUpButton>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
