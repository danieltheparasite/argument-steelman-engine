// Regression set: send each claim to /api/steelman and review by hand or script.
export const fixtures = [
  { claim: "Water boils at 100°C at sea level.", kind: "factual, strong", expectFallacies: 0 },
  { claim: "Free will is an illusion.", kind: "philosophical" },
  { claim: "Everyone I know got fired after AI arrived, so AI will end all jobs.", kind: "hasty generalization" },
  { claim: "Either we ban social media or society collapses.", kind: "false dilemma" },
  { claim: "It's better.", kind: "ambiguous" },
  { claim: "Remote work makes employees less productive.", kind: "causal, needs evidence" },
];
// Checks: draft 2 repairs draft 1's weaknesses; draft 3 repairs draft 2's; total equals the sum of parts;
// no invented citations; no fallacy labels on merely weak arguments; scores need not rise.
