import { connection } from "next/server";

import { IngestStudio } from "@/components/ingest-studio";
import { Card, SectionHeading } from "@/components/ui";
import { hasRole } from "@/lib/session";

export const metadata = { title: "Studio" };

/**
 * `/studio` — the ingest pipeline, end to end in one page.
 *
 * Server component: it loads the expedition list and the viewer's role so the
 * client form can disable itself, then hands off to the interactive form.
 */
export default async function StudioPage() {
  await connection();

  const [{ prisma }, { currentUser }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/session"),
  ]);

  const [expeditions, user] = await Promise.all([
    prisma.expedition.findMany({
      select: { slug: true, title: true },
      orderBy: { startDate: "desc" },
    }),
    currentUser().catch(() => null),
  ]);

  const canUpload = Boolean(user && hasRole(user.role, "contributor"));

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Phases 2 + 6"
        title="Ingest studio"
        description="Upload → classify → draft → human approval → bandit-chosen publish → feedback. Each stage shows its real output from Postgres and the ML service, including what happens when either is unavailable."
      />

      {!canUpload ? (
        <Card>
          <p className="text-sm">
            You are not signed in as a contributor. The form below will submit but
            the API rejects it with <code className="text-ice">403</code> — the role
            gate is enforced on the server, not just hidden in the UI.
          </p>
        </Card>
      ) : null}

      <IngestStudio expeditions={expeditions} canUpload={canUpload} />
    </div>
  );
}
