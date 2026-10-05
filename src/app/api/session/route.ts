import { NextResponse } from "next/server";
import { z } from "zod";

import { startSession } from "@/lib/session";

/**
 * `POST /api/session` — demo sign-in.
 *
 * Takes a seeded `User.id` and sets the signed session cookie. This is not
 * authentication: there is no password check, and anyone who can reach the app
 * can sign in as anyone. It exists so the prototype's role-gated flows
 * (contributor uploads → editor reviews → admin reads the model registry) are
 * actually exercised rather than stubbed behind a login that does not exist.
 *
 * Real Auth.js replaces this; see `src/lib/session.ts`.
 */
const BODY = z.object({ userId: z.string().min(1) });

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "Body is not valid JSON" } },
      { status: 400 },
    );
  }

  const parsed = BODY.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "userId is required" } },
      { status: 400 },
    );
  }

  const { prisma } = await import("@/lib/db");
  const user = await prisma.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, name: true, role: true },
  });

  if (!user) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "No such seeded account" } },
      { status: 404 },
    );
  }

  await startSession(user.id);
  return NextResponse.json({ ok: true, user });
}
