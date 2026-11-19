"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// Module 4: on the Support page the chat also sends the Refund Console's
// "desk" (the auto-refund limit and the refunds so far) and which agent is
// talking. Copper can hand the conversation to the Refund agent, a second
// agent with its own instructions and tools, and the Refund agent can hand it
// back. The agent that ends the turn answers the next message too.
// Module 5: each turn is one Langfuse trace ("ask-copper-turn"), with one
// "agent" observation per agent that spoke, and its model calls and tool
// calls inside it.
import {
  getActiveTraceId,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { defaultModel } from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";
import {
  COPPER_HANDOFF,
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
  SINGLE_AGENT_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import type {
  Agent,
  Progress,
  ToolStep,
} from "@/lib/copper/assistant/progress";
import {
  copperTools,
  refundAgentTools,
  singleAgentTools,
  transferToRefundAgent,
} from "@/lib/copper/assistant/tools";
import type { Desk } from "@/lib/copper/orders";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The Refund Console's limit and refunds (Support page only). */
  desk?: Desk;
  /** Who answers first: whoever ended the last turn. Copper by default. */
  agent?: Agent;
  /**
   * Module 5: "multi" (default) is Copper plus the Refund agent; "single" is
   * one support agent with every tool. The golden-set eval runs both.
   */
  mode?: "multi" | "single";
};

export type AskCopperResult = {
  progress: Live<Progress>;
  /** The turn's Langfuse trace (empty when tracing is off). */
  traceId?: string;
};

/** At most this many model steps (tool calls plus the reply) per agent. */
const MAX_STEPS = 5;

/** Copper → Refund agent → Copper at most, so a turn can't bounce forever. */
const MAX_HANDOFFS = 2;

const HANDOFF_TOOLS: Record<string, Agent> = {
  transfer_to_refund_agent: "refund",
  transfer_to_copper: "copper",
};

// A handoff ends the agent's turn: the other agent answers.
const STOP = [
  stepCountIs(MAX_STEPS),
  hasToolCall("transfer_to_refund_agent", "transfer_to_copper"),
];

/** How each agent is named in Langfuse. */
const AGENT_NAMES: Record<Agent, string> = {
  copper: "copper-agent",
  refund: "refund-agent",
};

const SORRY = "Sorry, something went wrong on my end. Please try again.";

/** Module 5: the single support agent, with every tool and no handoffs. */
function singleAgentCall(messages: ChatMessage[], desk: Desk) {
  return callStream(
    { module: 5, feature: "single-agent" },
    {
      messages,
      providerOptions: THOUGHT_SUMMARIES,
      instructions: SINGLE_AGENT_INSTRUCTIONS,
      tools: singleAgentTools(desk),
      stopWhen: stepCountIs(MAX_STEPS),
    },
  );
}

/** One agent's call: its instructions and only its own tools. */
function agentCall(agent: Agent, messages: ChatMessage[], desk?: Desk) {
  if (agent === "refund" && desk)
    return callStream(
      { module: 4, feature: "refund-agent" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: REFUND_AGENT_INSTRUCTIONS,
        tools: refundAgentTools(desk),
        stopWhen: STOP,
      },
    );
  return callStream(
    { module: 2, feature: "ask-copper" },
    {
      messages,
      providerOptions: THOUGHT_SUMMARIES,
      instructions: desk
        ? `${COPPER_INSTRUCTIONS}\n\n${COPPER_HANDOFF}`
        : COPPER_INSTRUCTIONS,
      tools: desk
        ? { ...copperTools, transfer_to_refund_agent: transferToRefundAgent }
        : copperTools,
      stopWhen: STOP,
    },
  );
}

export async function askCopper({
  messages,
  useTools,
  desk,
  agent = "copper",
  mode = "multi",
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  const first: Agent = desk && useTools ? agent : "copper";
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: first,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  // Tool call ids are per agent call, so each call's are kept apart.
  let call = 0;
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep =>
        step.type === "tool" && step.id === `${call}:${id}`,
    );

  /** Reads one agent's stream into progress. Returns who to hand off to. */
  async function follow(
    current: Agent,
    result: ReturnType<typeof callStream>,
  ): Promise<Agent | undefined> {
    let handoff: Agent | undefined;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking" && last.agent === current)
            last.text += part.text;
          else
            progress.steps.push({
              type: "thinking",
              text: part.text,
              agent: current,
            });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: `${call}:${part.id}`,
            agent: current,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: `${call}:${part.toolCallId}`,
              agent: current,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          if (part.toolName in HANDOFF_TOOLS)
            handoff = HANDOFF_TOOLS[part.toolName];
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    const used = await result.totalUsage;
    const usage = (progress.usage ??= {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    usage.inputTokens += used.inputTokens ?? 0;
    usage.outputTokens += used.outputTokens ?? 0;
    usage.costUsd = costUsd(
      defaultModel(),
      usage.inputTokens,
      usage.outputTokens,
    );
    return handoff;
  }

  /** One agent's part of the turn, as an "agent" in the Langfuse trace. */
  function traceAgent(
    agent: Agent,
    run: () => Promise<Agent | undefined>,
    name = AGENT_NAMES[agent],
  ): Promise<Agent | undefined> {
    return startActiveObservation(
      name,
      async (observation) => {
        const replyBefore = progress.reply;
        const handoff = await run();
        observation.update({
          output: handoff
            ? { handoff_to: AGENT_NAMES[handoff] }
            : progress.reply || replyBefore,
        });
        return handoff;
      },
      { asType: "agent" },
    );
  }

  const single = mode === "single" && Boolean(desk) && useTools;
  let traceId: string | undefined;
  const lastQuestion = messages.findLast((m) => m.role === "user")?.content;

  // Read the stream in the background, so the panel gets the first update now.
  void propagateAttributes(
    {
      traceName: "ask-copper-turn",
      tags: [
        desk ? "support-page" : "home-page",
        useTools ? "tools" : "no-tools",
        single ? "single-agent" : "multi-agent",
      ],
      metadata: { first_agent: first, messages: String(messages.length) },
    },
    () =>
      startActiveObservation("ask-copper-turn", (turn) => {
        traceId = getActiveTraceId();
        return runTurn(turn);
      }),
  );

  async function runTurn(turn: {
    update: (attributes: { input?: unknown; output?: unknown }) => unknown;
  }) {
    turn.update({ input: lastQuestion });
    try {
      if (!useTools) {
        // Without tools, send no instructions either: "always use your
        // tools" with no tools makes the model answer with nothing.
        await traceAgent("copper", () =>
          follow(
            "copper",
            callStream(
              { module: 2, feature: "ask-copper" },
              { messages, providerOptions: THOUGHT_SUMMARIES },
            ),
          ),
        );
      } else if (single && desk) {
        await traceAgent(
          "copper",
          () => follow("copper", singleAgentCall(messages, desk)),
          "support-agent",
        );
      } else {
        let current = first;
        for (let handoffs = 0; ; handoffs++) {
          const speaker = current;
          const next = await traceAgent(speaker, () =>
            follow(speaker, agentCall(speaker, messages, desk)),
          );
          if (!next || next === current || handoffs >= MAX_HANDOFFS) break;
          progress.steps.push({ type: "handoff", from: current, to: next });
          progress.agent = current = next;
          progress.reply = "";
          call++;
          update(snapshot());
        }
      }
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
    } catch {
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
    }
    turn.update({
      output: {
        reply: progress.reply,
        agent: AGENT_NAMES[progress.agent ?? "copper"],
        status: progress.status,
      },
    });
    done(snapshot());
  }

  return { progress: live, traceId };
}
