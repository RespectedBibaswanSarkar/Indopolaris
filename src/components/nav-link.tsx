"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cx } from "./ui";

/**
 * Primary-nav link with an active state.
 *
 * Isolated in its own client module because `usePathname` requires a client
 * boundary, and the header around it should stay server-rendered — it performs
 * two health checks that must not be shipped to the browser.
 */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "block rounded-lg px-3 py-1.5 font-medium transition",
        active ? "bg-ice/10 text-ice" : "text-muted hover:bg-surface-2 hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}
