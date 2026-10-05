import { connection } from "next/server";

import { Badge, Card, Meter, Mono, SectionHeading, Stat } from "@/components/ui";
import { isMlConfigured, mlHealth } from "@/lib/ml";

export const metadata = { title: "Ops" };

/**
 * `/ops` — Section 8.4's dashboard.
 *
 * Every figure is read from a table: the accuracy and macro-F1 come from the
 * `MLModelVersion` row the training script wrote, and the arm posteriors come
 * from `BanditArmState`. Nothing here is a constant in the source, which is the
 * whole point — a dashboard whose numbers are typed into the component is a
 * decoration, not an instrument.
 */
export default async function OpsPage() {
  await connection();

  const { prisma, reads } = await import("@/lib/db");

  // Sequential, not Promise.all — see `reads()` in lib/db.ts. PGlite serves one
  // connection and parallel queries desynchronise its prepared statements.
  const [model, models, arms, events, classifications, mlHealthState] = await reads(
    () =>
      prisma.mLModelVersion.findFirst({
        where: { isActive: true },
        orderBy: { trainedAt: "desc" },
      }),
    () => prisma.mLModelVersion.findMany({ orderBy: { trainedAt: "desc" }, take: 10 }),
    () => prisma.banditArmState.findMany({ orderBy: { alpha: "desc" } }),
    () =>
      prisma.engagementEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          channel: true,
          timeSlotBucket: true,
          impressions: true,
          clicks: true,
          reward: true,
          isSimulated: true,
          createdAt: true,
        },
      }),
    () =>
      prisma.classificationLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          sourceType: true,
          sourceId: true,
          predictedTags: true,
          confidenceScores: true,
          modelVersion: true,
          createdAt: true,
        },
      }),
    () => (isMlConfigured() ? mlHealth().catch(() => null) : Promise.resolve(null)),
  );

  // Prior-arm rows so all 9 are shown even before any feedback lands. Matches
  // `bandit.prior_arms()` on the Python side.
  const CHANNELS = ["website", "twitter", "instagram"] as const;
  const SLOTS = ["morning", "afternoon", "evening"] as const;
  const armRows = CHANNELS.flatMap((channel) =>
    SLOTS.map((slot) => {
      const name = `${channel}_${slot}`;
      const row = arms.find((a) => a.arm === name);
      return {
        arm: name,
        channel,
        slot,
        alpha: row?.alpha ?? 1,
        beta: row?.beta ?? 1,
        pulls: row?.totalPulls ?? 0,
        reward: row?.totalReward ?? 0,
        seen: Boolean(row),
      };
    }),
  ).sort((a, b) => b.alpha / (b.alpha + b.beta) - a.alpha / (a.alpha + a.beta));

  const totalPulls = armRows.reduce((sum, a) => sum + a.pulls, 0);
  const totalReward = armRows.reduce((sum, a) => sum + a.reward, 0);

  return (
    <div className="space-y-8">
      <SectionHeading
        eyebrow="Section 8.4"
        title="Model registry and bandit state"
        description="Read live from Postgres and the ML service. The accuracy shown is the measured number on the NASA GES DISC corpus — see the README section on honest numbers for why it is 0.44 and not 0.88."
      />

      {/* Service ---------------------------------------------------------- */}
      <section>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="ML service"
            value={
              !isMlConfigured()
                ? "not configured"
                : mlHealthState?.reachable
                  ? "reachable"
                  : "offline"
            }
            tone={
              !isMlConfigured() || !mlHealthState?.reachable
                ? "bad"
                : mlHealthState.modelLoaded
                  ? "good"
                  : "amber"
            }
            hint={mlHealthState?.detail ?? "set ML_SERVICE_URL"}
          />
          <Stat
            label="Model version"
            value={mlHealthState?.modelVersion ? `v${mlHealthState.modelVersion}` : "—"}
            hint={model ? `${model.name}:${model.version}` : "no active registry row"}
          />
          <Stat
            label="Accuracy"
            value={model ? model.accuracy.toFixed(4) : "—"}
            tone={model ? "ice" : undefined}
            hint={model ? "from MLModelVersion" : "run npm run ml:train"}
          />
          <Stat
            label="Macro-F1"
            value={model ? model.macroF1.toFixed(4) : "—"}
            tone={model ? "violet" : undefined}
            hint={model ? "from MLModelVersion" : undefined}
          />
        </div>
      </section>

      {/* Registry --------------------------------------------------------- */}
      <section>
        <h3 className="mb-3 font-display text-lg font-semibold">Model registry</h3>
        {models.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">
              No rows. <code className="text-ice">npm run ml:train</code> registers one.
            </p>
          </Card>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-4 py-3">name</th>
                  <th className="px-4 py-3">version</th>
                  <th className="px-4 py-3 text-right">accuracy</th>
                  <th className="px-4 py-3 text-right">macro-F1</th>
                  <th className="px-4 py-3">trained</th>
                  <th className="px-4 py-3">provenance</th>
                </tr>
              </thead>
              <tbody>
                {models.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-4 py-3 font-mono text-xs">
                      {row.name}
                      {row.isActive ? (
                        <Badge tone="good" title="served by /classify">
                          active
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{row.version}</td>
                    <td className="px-4 py-3 text-right font-semibold text-ice">
                      {row.accuracy.toFixed(4)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-violet">
                      {row.macroF1.toFixed(4)}
                    </td>
                    <td className="px-4 py-3">
                      <Mono>{row.trainedAt.toISOString().slice(0, 19)}Z</Mono>
                    </td>
                    <td className="max-w-md px-4 py-3 text-xs text-muted">
                      {row.datasetSource}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Bandit ----------------------------------------------------------- */}
      <section>
        <h3 className="mb-3 font-display text-lg font-semibold">Bandit arms</h3>
        <p className="mb-3 text-sm text-muted">
          3 channels × 3 time slots, each a Beta(α, β) posterior seeded at
          Beta(1,1). {totalPulls} pulls recorded,{" "}
          {totalReward.toFixed(3)} cumulative reward. The table is sorted by
          posterior mean, which is what Thompson sampling maximises.
        </p>

        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="px-4 py-3">arm</th>
                <th className="px-4 py-3 text-right">α</th>
                <th className="px-4 py-3 text-right">β</th>
                <th className="px-4 py-3 text-right">pulls</th>
                <th className="px-4 py-3 text-right">reward</th>
                <th className="px-4 py-3 w-48">posterior mean</th>
              </tr>
            </thead>
            <tbody>
              {armRows.map((arm) => {
                const mean = arm.alpha / (arm.alpha + arm.beta);
                return (
                  <tr key={arm.arm} className="border-t border-line">
                    <td className="px-4 py-3 font-mono text-xs">
                      {arm.arm}
                      {!arm.seen ? (
                        <span className="ml-2 text-[10px] uppercase text-muted">
                          prior
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {arm.alpha.toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {arm.beta.toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {arm.pulls}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {arm.reward.toFixed(3)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <Meter value={mean} tone={mean > 0.5 ? "good" : "ice"} />
                        </div>
                        <span className="w-16 text-right font-mono text-xs">
                          {mean.toFixed(4)}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Events + classifications ----------------------------------------- */}
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 font-display text-lg font-semibold">
            Engagement events
          </h3>
          {events.length === 0 ? (
            <Card>
              <p className="text-sm text-muted">
                No feedback yet. Run the studio flow, or{" "}
                <code className="text-ice">npm run ml:simulate</code>.
              </p>
            </Card>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-2 uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-3 py-2">arm</th>
                    <th className="px-3 py-2 text-right">impr</th>
                    <th className="px-3 py-2 text-right">clicks</th>
                    <th className="px-3 py-2 text-right">reward</th>
                    <th className="px-3 py-2">kind</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id} className="border-t border-line">
                      <td className="px-3 py-2 font-mono">
                        {event.channel}_{event.timeSlotBucket}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {event.impressions}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {event.clicks}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-ice">
                        {event.reward.toFixed(4)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={event.isSimulated ? "amber" : "good"}>
                          {event.isSimulated ? "simulated" : "real"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-3 font-display text-lg font-semibold">
            Recent classifications
          </h3>
          {classifications.length === 0 ? (
            <Card>
              <p className="text-sm text-muted">
                No <code>ClassificationLog</code> rows. Submit through the studio,
                or the lab with a sourceId.
              </p>
            </Card>
          ) : (
            <ul className="space-y-2">
              {classifications.map((row) => {
                const scores = row.confidenceScores as Record<string, number>;
                const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
                return (
                  <li key={row.id} className="rounded-xl border border-line bg-surface p-3">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-muted">
                        {row.sourceType}:{row.sourceId.slice(0, 8)}
                      </span>
                      <Badge tone="ice">v{row.modelVersion}</Badge>
                    </div>
                    <p className="mt-1 text-sm">
                      {row.predictedTags.length > 0 ? (
                        <>
                          <span className="text-ice">{row.predictedTags.join(", ")}</span>
                        </>
                      ) : (
                        <span className="text-amber">
                          nothing above threshold
                        </span>
                      )}
                    </p>
                    {top ? (
                      <p className="text-xs text-muted">
                        top score {top[1].toFixed(4)} ({top[0]})
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
