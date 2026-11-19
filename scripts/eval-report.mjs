// CI step after `npm run eval`: shows the golden-set scores on the pull
// request. Writes a table to the check's summary page and one annotation per
// agent setup (they appear on the PR's Checks tab). Locally, prints the table.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const file = ".eval/results.json";
if (!existsSync(file)) {
  console.log(
    "::error title=Golden-set eval::The eval didn't finish, so there are no scores.",
  );
  process.exit(1);
}
const { model, passMark, label, results } = JSON.parse(
  readFileSync(file, "utf8"),
);

const pct = (x) => `${Math.round(x * 100)}%`;
const usd = (x) => `$${x.toFixed(5)}`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

const lines = [
  `## Golden-set eval: ${label}`,
  "",
  `${results[0].total} golden questions, graded by an AI judge (Gemini, \`${model}\`). The two agents must pass ${pct(passMark)}.`,
  "",
  "| Setup | Pass rate | Avg judge score | Avg cost per answer | Avg time per answer | Langfuse run |",
  "| --- | --- | --- | --- | --- | --- |",
  ...results.map(
    (r) =>
      `| ${r.label} | **${r.passed}/${r.total} (${pct(r.passRate)})** | ${r.avgScore.toFixed(2)} / 5 | ${usd(r.avgCostUsd)} | ${secs(r.avgLatencyMs)} | ${r.runUrl ? `[${r.runName}](${r.runUrl})` : r.runName} |`,
  ),
  "",
];
for (const r of results) {
  lines.push(
    `<details><summary>${r.label}: each question</summary>`,
    "",
    "| Question | Result | Judge | Cost | Time | Why |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.items.map(
      (i) =>
        `| ${i.id} | ${i.pass ? "✅ pass" : "❌ fail"} | ${i.score}/5 | ${usd(i.costUsd)} | ${secs(i.latencyMs)} | ${i.reason.replace(/\|/g, "/").replace(/\n/g, " ")} |`,
    ),
    "",
    "</details>",
    "",
  );
}
const markdown = lines.join("\n");

if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
else console.log(markdown);

for (const r of results) {
  const level =
    r.mode === "multi" && r.passRate < passMark ? "error" : "notice";
  console.log(
    `::${level} title=Eval: ${r.label}::${r.passed}/${r.total} passed (${pct(r.passRate)}) · judge ${r.avgScore.toFixed(2)}/5 · ${usd(r.avgCostUsd)} per answer · ${secs(r.avgLatencyMs)} per answer`,
  );
}
