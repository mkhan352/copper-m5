// @vitest-environment node
// Module 5: the golden-set evaluation. `npm run eval` (and CI on every pull
// request) sends every golden question to Ask Copper twice: once to the two
// agents (Copper + the Refund agent) and once to one support agent that does
// everything. An AI judge grades each reply; the scores, cost and speed go to
// Langfuse as two runs of the "copper-golden-set" dataset, so you can compare
// them side by side. It fails when the two agents pass fewer than PASS_MARK.
import { mkdirSync, writeFileSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import { describe, expect, it } from "vitest";
import { isAiConfigured, pacingWait } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import { defaultModel } from "@/lib/ai/models";
import {
  flushTracing,
  isTracingConfigured,
  startTracing,
} from "@/lib/ai/tracing";
import { askCopper } from "@/lib/copper/assistant/ask";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import { GOLDEN_SET, type GoldenItem } from "@/lib/copper/eval/golden-set";
import { checkTools, judgeReply } from "@/lib/copper/eval/judge";
import { DEFAULT_LIMIT_USD } from "@/lib/copper/orders";

/** The two agents must pass at least this share of the golden set. */
const PASS_MARK = 0.8;
const DATASET = "copper-golden-set";
const MODES = [
  { mode: "multi", label: "Two agents (Copper + Refund agent)" },
  { mode: "single", label: "Single support agent" },
] as const;
type Mode = (typeof MODES)[number]["mode"];

type Output = {
  reply: string;
  agent?: string;
  toolCalls: { name: string; input?: unknown; output?: unknown }[];
  costUsd: number;
  latencyMs: number;
};

export type ItemResult = {
  id: string;
  category: GoldenItem["category"];
  pass: boolean;
  score: number;
  reason: string;
  costUsd: number;
  latencyMs: number;
};

export type ModeResult = {
  mode: Mode;
  label: string;
  runName: string;
  runUrl?: string;
  passRate: number;
  passed: number;
  total: number;
  avgScore: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  items: ItemResult[];
};

const ready = isAiConfigured() && isTracingConfigured();
// In CI a missing key must fail the check, not skip it.
if (process.env.CI && !ready)
  throw new Error(
    "The eval needs GOOGLE_GENERATIVE_AI_API_KEY and the three LANGFUSE_* secrets in the repo's Actions secrets.",
  );

/** Sends one golden question to Ask Copper and waits for the whole answer. */
async function ask(item: GoldenItem, mode: Mode): Promise<Output> {
  const waited = { ms: 0 };
  return pacingWait.run(waited, async () => {
    const out = await askOnce(item, mode);
    // Speed leaves out the time spent waiting for Gemini's rate limit.
    return { ...out, latencyMs: Math.max(0, out.latencyMs - waited.ms) };
  });
}

async function askOnce(item: GoldenItem, mode: Mode): Promise<Output> {
  const started = performance.now();
  const { progress } = await askCopper({
    messages: [{ role: "user", content: item.question }],
    useTools: true,
    mode,
    desk: {
      limitUsd: item.desk?.limitUsd ?? DEFAULT_LIMIT_USD,
      refunds: item.desk?.refunds ?? [],
    },
  });
  const final = await finalValue(progress);
  return {
    reply: final.reply,
    agent: final.agent,
    toolCalls: toolCallsOf(final),
    costUsd: final.usage?.costUsd ?? 0,
    latencyMs: Math.round(performance.now() - started),
  };
}

/** Puts the golden set in Langfuse as a dataset (updates it if it's there). */
async function syncDataset(langfuse: LangfuseClient) {
  await langfuse.api.datasets.create({
    name: DATASET,
    description: "Module 5: Ask Copper's golden questions on the Support page.",
  });
  for (const item of GOLDEN_SET) {
    await langfuse.api.datasetItems.create({
      datasetName: DATASET,
      id: `${DATASET}-${item.id}`,
      input: { question: item.question, desk: item.desk ?? null },
      expectedOutput: item.expected,
      metadata: { goldenId: item.id, category: item.category },
    });
  }
  return langfuse.dataset.get(DATASET);
}

function runLabel() {
  const sha = process.env.GITHUB_SHA?.slice(0, 7);
  const pr = process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\//)?.[1];
  if (sha) return pr ? `PR #${pr} · ${sha}` : sha;
  return `local ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
}

describe.skipIf(!ready)("golden-set eval (live Gemini + Langfuse)", () => {
  it("grades both agent setups and the two agents pass the mark", async () => {
    startTracing();
    const langfuse = new LangfuseClient();
    const dataset = await syncDataset(langfuse);
    const byId = new Map(GOLDEN_SET.map((item) => [item.id, item]));
    const label = runLabel();
    const results: ModeResult[] = [];

    for (const { mode, label: modeLabel } of MODES) {
      const runName = `${mode === "multi" ? "two-agents" : "single-agent"} · ${label}`;
      const run = await dataset.runExperiment({
        name: `Ask Copper: ${modeLabel}`,
        runName,
        description: `${modeLabel} on the golden set, model ${defaultModel()}.`,
        metadata: { mode, model: defaultModel() },
        // A few at a time keeps under Gemini's free rate limit.
        maxConcurrency: 3,
        task: async ({ metadata }) =>
          ask(byId.get((metadata as { goldenId: string }).goldenId)!, mode),
        evaluators: [
          async ({ output, metadata }) => {
            const item = byId.get((metadata as { goldenId: string }).goldenId)!;
            const out = output as Output;
            const verdict = await judgeReply(item, out.reply, out.toolCalls);
            const tools = checkTools(item, out.toolCalls);
            const pass = verdict.pass && tools.ok;
            const reason = tools.ok
              ? verdict.reason
              : `${verdict.reason} Tool check failed: ${tools.problem}.`;
            return [
              { name: "pass", value: pass ? 1 : 0, comment: reason },
              {
                name: "judge_score",
                value: verdict.score,
                comment: verdict.reason,
              },
              {
                name: "tool_check",
                value: tools.ok ? 1 : 0,
                comment: tools.problem ?? "ok",
              },
              { name: "cost_usd", value: out.costUsd },
              { name: "latency_s", value: out.latencyMs / 1000 },
            ];
          },
        ],
        runEvaluators: [
          async ({ itemResults }) => {
            const share = (name: string) =>
              itemResults.reduce(
                (sum, r) =>
                  sum +
                  Number(
                    r.evaluations.find((e) => e.name === name)?.value ?? 0,
                  ),
                0,
              ) / Math.max(itemResults.length, 1);
            return [
              { name: "pass_rate", value: share("pass") },
              { name: "avg_judge_score", value: share("judge_score") },
              { name: "avg_cost_usd", value: share("cost_usd") },
              { name: "avg_latency_s", value: share("latency_s") },
            ];
          },
        ],
      });

      const items: ItemResult[] = run.itemResults.map((r) => {
        const goldenId = (r.item.metadata as { goldenId: string }).goldenId;
        const value = (name: string) =>
          Number(r.evaluations.find((e) => e.name === name)?.value ?? 0);
        const out = r.output as Output | undefined;
        return {
          id: goldenId,
          category: byId.get(goldenId)!.category,
          pass: value("pass") === 1,
          score: value("judge_score"),
          reason: String(
            r.evaluations.find((e) => e.name === "pass")?.comment ??
              "the agent errored",
          ),
          costUsd: out?.costUsd ?? 0,
          latencyMs: out?.latencyMs ?? 0,
        };
      });
      const avg = (pick: (i: ItemResult) => number) =>
        items.reduce((sum, i) => sum + pick(i), 0) / Math.max(items.length, 1);
      const passed = items.filter((i) => i.pass).length;
      results.push({
        mode,
        label: modeLabel,
        runName,
        runUrl: run.datasetRunUrl,
        passRate: passed / GOLDEN_SET.length,
        passed,
        total: GOLDEN_SET.length,
        avgScore: avg((i) => i.score),
        avgCostUsd: avg((i) => i.costUsd),
        avgLatencyMs: avg((i) => i.latencyMs),
        items,
      });
    }

    await langfuse.score.flush();
    await flushTracing();

    // scripts/eval-report.mjs turns this into the pull request's check summary.
    mkdirSync(".eval", { recursive: true });
    writeFileSync(
      ".eval/results.json",
      JSON.stringify(
        { model: defaultModel(), passMark: PASS_MARK, label, results },
        null,
        2,
      ),
    );
    for (const r of results)
      console.log(
        `${r.label}: ${r.passed}/${r.total} passed (${Math.round(r.passRate * 100)}%), avg judge ${r.avgScore.toFixed(2)}/5, avg $${r.avgCostUsd.toFixed(5)}, avg ${(r.avgLatencyMs / 1000).toFixed(1)}s`,
      );

    const multi = results.find((r) => r.mode === "multi")!;
    expect(
      multi.passRate,
      `The two agents passed ${multi.passed}/${multi.total}; they need ${PASS_MARK * 100}%.`,
    ).toBeGreaterThanOrEqual(PASS_MARK);
  }, 900_000);
});
