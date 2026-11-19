// Module 5: the AI judge. Gemini reads the question, what a good answer does
// and Ask Copper's reply (with its tool calls), and grades it. It goes through
// callObject (lib/ai/call.ts) like every other AI call, so it's logged and
// traced too.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import type { GoldenItem } from "@/lib/copper/eval/golden-set";

export const JUDGE_INSTRUCTIONS = `You grade replies from Ask Copper, the customer support chatbot of Copper State Labs.
You get the customer's question, what a good answer does, the tools the chatbot called (with what came back), and its reply.
Grade only against "what a good answer does". Facts that came back from a tool count as true. Small differences in wording, tone or extra friendly sentences don't matter. A wrong number, a missing required fact, a promise it isn't allowed to make, or doing something the expected answer rules out does matter.
Score from 1 to 5: 5 does everything expected, 4 does it with a small slip, 3 is partly right, 2 is mostly wrong, 1 is wrong or harmful.
pass is true only for a score of 4 or 5. Keep the reason to one short sentence.`;

export const verdictSchema = z.object({
  score: z.number().int().min(1).max(5),
  pass: z.boolean(),
  reason: z.string(),
});

export type Verdict = z.infer<typeof verdictSchema>;

export type ToolCall = { name: string; input?: unknown; output?: unknown };

export async function judgeReply(
  item: GoldenItem,
  reply: string,
  toolCalls: ToolCall[],
): Promise<Verdict> {
  const tools = toolCalls.length
    ? toolCalls
        .map(
          (call) =>
            `- ${call.name}(${JSON.stringify(call.input ?? {})}) → ${JSON.stringify(call.output ?? null).slice(0, 600)}`,
        )
        .join("\n")
    : "(none)";
  const { output } = await callObject(
    { module: 5, feature: "eval-judge" },
    {
      instructions: JUDGE_INSTRUCTIONS,
      prompt: `Question: ${item.question}

What a good answer does: ${item.expected}

Tools called:
${tools}

Reply:
${reply}`,
      schema: verdictSchema,
    },
  );
  // The pass mark follows the score, whatever the judge wrote for pass.
  return { ...output, pass: output.score >= 4 };
}

/** The hard rules in `item.checks`, read from the tool calls. */
export function checkTools(
  item: GoldenItem,
  toolCalls: ToolCall[],
): { ok: boolean; problem?: string } {
  const { mustCall, mustNotCall = [] } = item.checks ?? {};
  for (const name of mustNotCall) {
    if (toolCalls.some((call) => call.name === name))
      return { ok: false, problem: `called ${name}` };
  }
  if (mustCall) {
    const calls = toolCalls.filter((call) => call.name === mustCall.tool);
    if (!calls.length)
      return { ok: false, problem: `didn't call ${mustCall.tool}` };
    if (
      mustCall.status &&
      !calls.some(
        (call) =>
          (call.output as { status?: string } | undefined)?.status ===
          mustCall.status,
      )
    )
      return {
        ok: false,
        problem: `${mustCall.tool} didn't return ${mustCall.status}`,
      };
  }
  return { ok: true };
}
