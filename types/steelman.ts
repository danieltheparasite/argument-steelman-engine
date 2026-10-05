import type { z } from "zod";
import type { ModelOutputSchema } from "@/lib/schema";

type Raw = z.infer<typeof ModelOutputSchema>;
export type Fallacy = Raw["originalAnalysis"]["fallacies"][number];
export type Stage = Omit<Raw["stages"][number], "score"> & {
  score: Raw["stages"][number]["score"] & { total: number };
};
export type Analysis = Omit<Raw, "stages"> & { stages: Stage[] };
