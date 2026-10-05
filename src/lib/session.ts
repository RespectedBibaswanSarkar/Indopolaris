import "server-only";

import { cookies } from "next/headers";

import type { User, UserRole } from "@/generated/prisma/client";

/**
 * Demo session.
 *
 * The real Phase 6 work is Auth.js v5 with OIDC/Google SSO; `AUTH_SECRET` and
 * `next-auth` are already wired into the schema (`User.passwordHash` is
 * nullable precisely so SSO can be added without a migration). That is not
 * built yet, so this module is the smallest thing that makes role-gated flows
 * real rather than decorative: a signed cookie holding a `User.id`, verified
 * against the database on every read.
 *
 * Deliberate properties:
 *  - No password. A prototype that ships bcrypt auth is a worse prototype,
 *    because it looks finished. This is obviously not production auth and the
 *    UI says so.
 *  - The cookie stores an id, never a role. Roles are re-read from the DB every
 *    request, so promoting or demoting someone takes effect immediately instead
 *    of lasting until their cookie expires.
 *  - Signed with AUTH_SECRET via node:crypto. Unsigned cookies would let anyone
 *    mint an admin session by editing one value.
 *
 * Delete this file (and call `requireUser()` from real auth) once Auth.js lands.
 */

const COOKIE = "ip_demo_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

async function secret(): Promise<string> {
  // Imported lazily: `env()` requires every var, and this module is imported by
  // pages that render during `next build` with no .env present.
  const { env } = await import("@/lib/env");
  return env().AUTH_SECRET;
}

/** Sign a payload with HMAC-SHA256. Format: `<value>.<sig>` */
async function sign(value: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const mac = createHmac("sha256", await secret()).update(value).digest("base64url");
  return `${value}.${mac}`;
}

/** Verify and unwrap. Returns null on any tampering, expiry or bad signature. */
async function unsign(token: string): Promise<string | null> {
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const value = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", await secret()).update(value).digest("base64url");

  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return value;
}

export type SessionUser = Pick<User, "id" | "name" | "email" | "role" | "institution">;

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  institution: true,
} as const;

/** Current user, or null when anonymous. Never throws. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;

  const userId = await unsign(token);
  if (!userId) return null;

  const { prisma } = await import("@/lib/db");
  return prisma.user.findUnique({ where: { id: userId }, select: userSelect });
}

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to do that") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Require a signed-in user of at least `role`. Throws `ForbiddenError`. */
export async function requireUser(minimum?: UserRole): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) {
    throw new ForbiddenError("Sign in to continue");
  }
  if (minimum && !hasRole(user.role, minimum)) {
    throw new ForbiddenError(`This action requires the ${minimum} role`);
  }
  return user;
}

const RANK: Record<UserRole, number> = {
  public: 0,
  contributor: 1,
  editor: 2,
  admin: 3,
};

export function hasRole(actual: UserRole, minimum: UserRole): boolean {
  return RANK[actual] >= RANK[minimum];
}

/** Set the signed session cookie. Called by the demo sign-in route. */
export async function startSession(userId: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, await sign(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/** Seeded accounts offered on the demo sign-in page. */
export async function demoAccounts(): Promise<
  { id: string; name: string; email: string; role: UserRole; institution: string | null }[]
> {
  const { prisma } = await import("@/lib/db");
  return prisma.user.findMany({
    select: { ...userSelect, institution: true },
    orderBy: { role: "desc" },
  });
}
