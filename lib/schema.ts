import { z } from "zod";

export const MAX_CLAIM_LENGTH = 1500;

export const CLAIM_TYPES = [
  "factual", "causal", "predictive", "normative", "value_judgment",
  "definition", "philosophical", "mixed", "ambiguous",
] as const;

export const RequestSchema = z.object({
  claim: z.string().trim().min(1, "Put a claim on the pad first.")
    .max(MAX_CLAIM_LENGTH, `Keep the claim under ${MAX_CLAIM_LENGTH} characters.`),
  mode: z.enum(["mine", "other"]).default("mine"),
  model: z.enum(["26b", "31b"]).optional(),
  fresh: z.boolean().optional(),
  stream: z.boolean().optional(),
});

const FallacySchema = z.object({
  name: z.string().describe("Common, well-established fallacy name"),
  severity: z.enum(["minor", "moderate", "major"]),
  confidence: z.number().min(0).max(1).describe("Classification confidence"),
  excerpt: z.string().describe("Exact phrase from the argument"),
  explanation: z.string(),
  whyItMatters: z.string(),
  suggestedRepair: z.string(),
});

const DimensionSchema = z.object({
  score: z.number().int().min(0).max(4),
  reason: z.string(),
});

const StageSchema = z.object({
  stage: z.number().int().min(1).max(3),
  title: z.string(),
  argument: z.string(),
  weaknesses: z.array(z.string()),
  anticipatedObjections: z.array(z.string()),
  improvements: z.array(z.string()),
  requiresExternalEvidence: z.boolean(),
  evidenceRequirements: z.array(z.string()),
  fallacies: z.array(FallacySchema),
  score: z.object({
    logicalRigor: DimensionSchema,
    relevance: DimensionSchema,
    resistanceToRebuttal: DimensionSchema,
  }),
});

/** What the model must return. The total is NOT requested: the server computes it. */
export const ModelOutputSchema = z.object({
  claim: z.string(),
  claimType: z.enum(CLAIM_TYPES),
  interpretation: z.string(),
  originalAnalysis: z.object({ fallacies: z.array(FallacySchema) }),
  stages: z.array(StageSchema).length(3),
});

export function modelJsonSchema() {
  const s = z.toJSONSchema(ModelOutputSchema) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
