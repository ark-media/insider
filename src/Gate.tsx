import { useState, type ReactNode } from "react";

const GATE_KEY = "insider_gate";
const GATE_PASSWORD = import.meta.env.VITE_GATE_PASSWORD as string | undefined;

function PasswordGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(
    () => sessionStorage.getItem(GATE_KEY) === GATE_PASSWORD,
  );
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  if (unlocked) return <>{children}</>;

  const submit = () => {
    if (input === GATE_PASSWORD) {
      sessionStorage.setItem(GATE_KEY, input);
      setUnlocked(true);
    } else {
      setError(true);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-navy-900 px-6">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-navy-800 p-8 text-center">
        <p className="font-display text-xs uppercase tracking-[0.2em] text-cyan">
          Preview access
        </p>
        <h1 className="mt-3 font-display text-2xl text-white">
          Insider is in testing
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Enter the team password to continue.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <input
            type="password"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(false); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Password"
            autoFocus
            className="w-full rounded-lg border border-white/15 bg-navy-900 px-4 py-2 text-white placeholder:text-white/30 focus:border-cyan focus:outline-none"
          />
          {error ? <p className="text-sm text-red-400">Incorrect password.</p> : null}
          <button
            onClick={submit}
            className="w-full rounded-lg bg-cyan px-4 py-2 font-medium text-navy-900 hover:brightness-110"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

export function Gate({ children }: { children: ReactNode }) {
  if (import.meta.env.DEV || !GATE_PASSWORD) return <>{children}</>;
  return <PasswordGate>{children}</PasswordGate>;
}
