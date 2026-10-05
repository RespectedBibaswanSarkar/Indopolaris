"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Badge, buttonClass } from "@/components/ui";

type DemoAccount = {
  id: string;
  name: string;
  email: string;
  role: string;
  institution: string | null;
};

const ROLE_BLURB: Record<string, string> = {
  public: "Read-only. Can browse expeditions and published stories.",
  contributor: "Can upload reports and datasets into the studio.",
  editor: "Can review drafts and publish outreach stories.",
  admin: "Everything an editor can do, plus the model registry and bandit state.",
};

/**
 * Demo sign-in.
 *
 * Posts a seeded `User.id` to `/api/session`. No password — see
 * `src/lib/session.ts`. The role list is not decoration: each role unlocks a
 * different part of the prototype, so switching accounts is how you inspect the
 * role gates from the other side.
 */
export function SignInPanel({ accounts }: { accounts: DemoAccount[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(userId: string) {
    setBusy(userId);
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `Sign-in failed (${response.status})`);
        return;
      }
      startTransition(() => {
        router.refresh();
        router.push("/");
      });
    } catch {
      setError("Could not reach the app. Is the dev server running?");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {accounts.length === 0 ? (
        <p className="text-sm text-muted">
          No seeded accounts found. Run <code className="text-ice">npm run db:seed</code>.
        </p>
      ) : null}

      {accounts.map((account) => (
        <button
          key={account.id}
          type="button"
          onClick={() => signIn(account.id)}
          disabled={busy !== null}
          className="flex w-full items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4 text-left transition hover:border-ice/60 disabled:opacity-60"
        >
          <span className="min-w-0">
            <span className="block font-semibold">{account.name}</span>
            <span className="block truncate text-xs text-muted">{account.email}</span>
            <span className="mt-1 block text-xs text-muted">
              {ROLE_BLURB[account.role] ?? account.role}
            </span>
          </span>
          <Badge tone={account.role === "admin" ? "violet" : account.role === "editor" ? "ice" : "neutral"}>
            {busy === account.id ? "signing in…" : account.role}
          </Badge>
        </button>
      ))}

      {pending ? <p className="text-xs text-muted">Refreshing…</p> : null}
      {error ? <p className="text-sm text-bad">{error}</p> : null}
    </div>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className={buttonClass("ghost", "w-full")}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/session/signout", { method: "POST" }).catch(() => {});
        router.refresh();
        router.push("/");
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
