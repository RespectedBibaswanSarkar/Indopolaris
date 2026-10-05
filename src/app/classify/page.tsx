import { connection } from "next/server";

import { ClassifierLab } from "@/components/classifier-lab";
import { SectionHeading } from "@/components/ui";

export const metadata = { title: "Classifier lab" };

/** `/classify` — inspect the discipline classifier's behaviour interactively. */
export default async function ClassifyPage() {
  await connection();

  return (
    <div>
      <SectionHeading
        eyebrow="Phase 2 · ML service"
        title="Classifier lab"
        description="Send text to the Python service and see the full distribution across all 21 NASA GES DISC research-area labels, not just the winning tag. This is the same /classify endpoint the upload pipeline calls, minus the database write."
      />
      <ClassifierLab />
    </div>
  );
}
