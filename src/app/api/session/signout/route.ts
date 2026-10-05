import { NextResponse } from "next/server";

import { endSession } from "@/lib/session";

/** `POST /api/session/signout` — clear the demo session cookie. */
export async function POST() {
  await endSession();
  return NextResponse.json({ ok: true });
}
