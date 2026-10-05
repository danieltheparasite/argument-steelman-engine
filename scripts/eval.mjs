// Usage: npm run dev, then  node scripts/eval.mjs [http://localhost:3000]
// Posts each fixture to /api/steelman and checks structural honesty. Pass the base URL to test a deployment.
const base = process.argv[2] || "http://localhost:3000";
const cases = [
  { claim: "Water boils at 100°C at sea level.", note: "strong factual: expect no fallacies", maxFallacies: 0 },
  { claim: "Free will is an illusion.", note: "philosophical" },
  { claim: "Everyone I know got fired after AI arrived, so AI will end all jobs.", note: "expect Hasty Generalization somewhere", expectName: /generaliz/i },
  { claim: "Either we ban social media or society collapses.", note: "expect False Dilemma", expectName: /dilemma/i },
  { claim: "It's better.", note: "ambiguous", claimType: "ambiguous" },
  { claim: "Remote work makes employees less productive.", note: "causal: should require external evidence", evidence: true },
];
let bad = 0;
for (const mode of ["mine", "other"]) for (const c of cases) {
  const issues = [], t0 = Date.now();
  try {
    const r = await fetch(base + "/api/steelman", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claim: c.claim, mode, fresh: true }) });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    const d = j.data, all = d.stages.flatMap((s) => s.fallacies);
    if (d.stages.length !== 3) issues.push("not 3 stages");
    d.stages.forEach((s, i) => {
      const q = s.score, sum = q.logicalRigor.score + q.relevance.score + q.resistanceToRebuttal.score;
      if (q.total !== sum) issues.push(`stage ${i + 1} total != sum`);
      if ([q.logicalRigor, q.relevance, q.resistanceToRebuttal].some((x) => x.score < 0 || x.score > 4)) issues.push(`stage ${i + 1} score out of range`);
      s.fallacies.forEach((f) => { if (!f.excerpt || !s.argument.includes(f.excerpt)) issues.push(`stage ${i + 1} excerpt not found in argument: ${f.name}`); });
    });
    if (/https?:\/\/|doi\.org/i.test(JSON.stringify(d.stages.map((s) => s.argument)))) issues.push("argument contains a URL/citation");
    if (c.maxFallacies !== undefined && all.length > c.maxFallacies) issues.push(`expected ≤${c.maxFallacies} fallacies, got ${all.length}`);
    if (c.expectName && ![...all, ...d.originalAnalysis.fallacies].some((f) => c.expectName.test(f.name))) issues.push("expected fallacy not flagged (soft)");
    if (c.claimType && d.claimType !== c.claimType) issues.push(`claimType ${d.claimType} (wanted ${c.claimType})`);
    if (c.evidence && !d.stages.some((s) => s.requiresExternalEvidence)) issues.push("no external evidence requested");
    console.log(`${issues.length ? "✗" : "✓"} [${mode}] ${c.claim.slice(0, 48)} (${((Date.now() - t0) / 1000).toFixed(0)}s) scores ${d.stages.map((s) => s.score.total).join("→")}`, issues.join("; "));
  } catch (e) { issues.push(String(e.message || e)); console.log(`✗ [${mode}] ${c.claim.slice(0, 48)}`, issues.join("; ")); }
  bad += issues.length;
}
console.log(bad ? `\n${bad} issue(s) — review manually; model output varies.` : "\nAll checks passed.");
process.exit(bad ? 1 : 0);
