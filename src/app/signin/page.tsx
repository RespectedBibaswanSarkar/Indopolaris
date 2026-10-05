import { connection } from "next/server";

import { SignInPanel, SignOutButton } from "@/components/sign-in-panel";
import { Card, SectionHeading } from "@/components/ui";
import { demoAccounts, currentUser } from "@/lib/session";

export const metadata = { title: "Sign in" };

/**
 * `/signin` — demo account picker.
 *
 * Reads the session server-side so a signed-in user sees their own account
 * highlighted rather than the full list, then hands the button behaviour to a
 * client component.
 */
export default async function SignInPage() {
  await connection();

  const [user, accounts] = await Promise.all([
    currentUser().catch(() => null),
    demoAccounts().catch(() => []),
  ]);

  return (
    <div className="mx-auto max-w-2xl">
      <SectionHeading
        eyebrow="Prototype access"
        title="Choose a seeded account"
        description="There is no password. This is a signed demo session so the prototype's role gates can be exercised — contributor uploads, editor review, admin model registry. Real Auth.js SSO replaces it later; see src/lib/session.ts."
      />

      {user ? (
        <Card className="mb-6">
          <p className="text-sm">
            Signed in as <span className="font-semibold">{user.name}</span>{" "}
            <span className="text-muted">
              ({user.role}
              {user.institution ? `, ${user.institution}` : ""})
            </span>
          </p>
          <div className="mt-4">
            <SignOutButton />
          </div>
        </Card>
      ) : null}

      <SignInPanel accounts={accounts} />
    </div>
  );
}
