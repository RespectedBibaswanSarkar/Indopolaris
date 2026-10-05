import Link from "next/link";

import { isMlConfigured, mlHealth } from "@/lib/ml";
import { currentUser } from "@/lib/session";
import { isLocalDriver } from "@/lib/storage";

import { NavLink } from "./nav-link";
import { Badge } from "./ui";

/**
 * Application shell: header, primary nav, ML service status, session slot.
 *
 * The status pill is not decoration. The classifier and the bandit degrade in
 * visibly different ways (a missing model means uploads save with tagging
 * pending; the bandit returns 503), so an operator needs to see which of the
 * two is down from any page rather than discovering it from a failed form.
 */

const NAV = [
  { href: "/expeditions", label: "Expeditions" },
  { href: "/search", label: "Search" },
  { href: "/classify", label: "Classifier lab" },
  { href: "/studio", label: "Studio" },
  { href: "/review", label: "Review" },
  { href: "/ops", label: "Ops" },
] as const;

/** Classify plus bandit health, collapsed into one pill. */
async function MlStatusPill() {
  if (!isMlConfigured()) {
    return (
      <Badge tone="bad" title="Set ML_SERVICE_URL to enable classification and the bandit">
        ML not configured
      </Badge>
    );
  }

  const health = await mlHealth().catch(() => null);
  if (!health?.reachable) {
    return <Badge tone="bad" title={health?.detail ?? "unreachable"}>ML offline</Badge>;
  }

  const modelLoaded = health.modelLoaded === true;
  const dbOk = health.checks?.database?.ok === true;
  return (
    <Badge
      tone={modelLoaded && dbOk ? "good" : "amber"}
      title={
        health.detail +
        (modelLoaded ? "" : " · no model artifact; tagging will be pending") +
        (dbOk ? "" : " · database unreachable")
      }
    >
      ML {modelLoaded ? `v${health.modelVersion ?? "?"}` : "no model"}
    </Badge>
  );
}

async function SessionSlot() {
  const user = await currentUser();

  if (!user) {
    return (
      <Link
        href="/signin"
        className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm font-semibold hover:border-ice/60"
      >
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Link href="/signin" className="text-right leading-tight">
        <span className="block text-sm font-semibold">{user.name}</span>
        <span className="block text-xs text-muted">
          {user.role}
          {user.institution ? ` · ${user.institution}` : ""}
        </span>
      </Link>
      <Badge
        tone={user.role === "admin" ? "violet" : user.role === "editor" ? "ice" : "neutral"}
      >
        {user.role}
      </Badge>
    </div>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-base/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-display text-xl font-bold tracking-tight">
            Indo<span className="text-ice">Polaris</span>
          </span>
          <span className="hidden text-xs text-muted sm:inline">
            India&apos;s Window to the Poles
          </span>
        </Link>

        <nav aria-label="Primary" className="order-3 w-full overflow-x-auto md:order-none md:w-auto">
          <ul className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <li key={item.href}>
                <NavLink href={item.href}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-3">
          <MlStatusPill />
          <SessionSlot />
        </div>
      </div>
    </header>
  );
}

export function StorageNotice() {
  if (!isLocalDriver()) return null;
  return (
    <p className="mx-auto max-w-7xl px-5 pt-3 text-xs text-muted">
      Local prototype: uploads are written to disk under{" "}
      <code className="text-ice">.local-storage/</code> instead of S3, and sign-in
      selects a seeded account without checking a password. Set{" "}
      <code className="text-ice">STORAGE_DRIVER=s3</code> to switch storage back.
    </p>
  );
}
