// @vitest-environment node
// Module 5: tracing. Each Ask Copper turn becomes one trace with an "agent"
// observation per agent and the model calls inside, named after the feature.
// Spans are kept in memory here instead of being sent to Langfuse.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { OpenTelemetry } from "@ai-sdk/otel";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: undefined },
    usage: {
      inputTokens: {
        total: 500,
        noCache: 500,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 50, text: 50, reasoning: undefined },
    },
  },
];

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  provider.register();
  registerTelemetry(new OpenTelemetry());
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await provider.shutdown();
});

describe("tracing", () => {
  it("is off until all three Langfuse variables are set", async () => {
    const { isTracingConfigured, startTracing } =
      await import("@/lib/ai/tracing");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    vi.stubEnv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com");
    expect(isTracingConfigured()).toBe(false);
    expect(startTracing()).toBe(false);
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    expect(isTracingConfigured()).toBe(true);
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
  });

  it("traces an Ask Copper turn: one trace, the agent, the model call", async () => {
    exporter.reset();
    model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream(says("We ship in 2 days.")),
      }),
    });
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const final = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "How fast do you ship?" }],
          useTools: true,
        })
      ).progress,
    );
    expect(final.reply).toBe("We ship in 2 days.");
    await provider.forceFlush();
    // The turn's trace closes just after the panel's last update.
    await vi.waitFor(() =>
      expect(exporter.getFinishedSpans().map((s) => s.name)).toContain(
        "ask-copper-turn",
      ),
    );

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name === "ask-copper-turn")!;
    const agent = spans.find((s) => s.name === "copper-agent")!;
    expect(agent, "an agent observation for Copper").toBeDefined();
    expect(agent.attributes["langfuse.observation.type"]).toBe("agent");
    expect(agent.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);

    // Every span of the turn is in the same trace.
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);

    // The model call is named after its feature and carries its tokens.
    const attributes = spans.map((s) => JSON.stringify(s.attributes));
    expect(attributes.some((a) => a.includes("ask-copper"))).toBe(true);
    expect(
      spans.some((s) => s.attributes["gen_ai.usage.input_tokens"] === 500),
    ).toBe(true);
  });
});
