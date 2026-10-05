import type { ReactNode } from "react";

/**
 * Shared presentational primitives.
 *
 * Small on purpose: the prototype needs a consistent surface/card/badge/
 * button vocabulary, not a component library. Every piece is a plain server
 * component (no "use client") so pages stay server-rendered and the database
 * round-trips are not shipped to the browser.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <Tag
      className={cx(
        "rounded-xl border border-line bg-surface p-5",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        {eyebrow ? (
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-ice">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="font-display text-2xl font-bold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

const BADGE_TONES = {
  neutral: "border-line bg-surface-2 text-muted",
  ice: "border-ice/40 bg-ice/10 text-ice",
  violet: "border-violet/40 bg-violet/10 text-violet",
  amber: "border-amber/40 bg-amber/10 text-amber",
  good: "border-good/40 bg-good/10 text-good",
  bad: "border-bad/40 bg-bad/10 text-bad",
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

const BUTTON_VARIANTS = {
  primary:
    "bg-gradient-to-r from-ice to-violet text-[#070b14] hover:brightness-110",
  ghost: "border border-line bg-surface-2 text-ink hover:border-ice/60",
  danger: "border border-bad/50 bg-bad/10 text-bad hover:bg-bad/20",
  good: "border border-good/50 bg-good/10 text-good hover:bg-good/20",
} as const;

export function buttonClass(
  variant: keyof typeof BUTTON_VARIANTS = "primary",
  extra?: string,
): string {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
    BUTTON_VARIANTS[variant],
    extra,
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "ice" | "violet" | "good" | "bad" | "amber";
}) {
  const toneClass =
    tone === "good"
      ? "text-good"
      : tone === "bad"
        ? "text-bad"
        : tone === "amber"
          ? "text-amber"
          : tone === "violet"
            ? "text-violet"
            : "text-ice";
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
      <p className={cx("mt-1 font-display text-2xl font-bold", toneClass)}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface/40 p-10 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{description}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** Horizontal confidence meter. `value` is 0–1. */
export function Meter({ value, tone = "ice" }: { value: number; tone?: BadgeTone }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const bar =
    tone === "good"
      ? "bg-good"
      : tone === "bad"
        ? "bg-bad"
        : tone === "amber"
          ? "bg-amber"
          : tone === "violet"
            ? "bg-violet"
            : "bg-gradient-to-r from-ice to-violet";
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      role="img"
      aria-label={`${(pct / 100).toFixed(3)}`}
    >
      <div className={cx("h-full rounded-full", bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Monospace-ish label for values that are numbers, ids or code. */
export function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-xs tracking-tight text-muted">{children}</span>
  );
}
