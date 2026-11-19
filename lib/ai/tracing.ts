// Module 5: tracing. Every AI call is sent to Langfuse, so you can open a
// trace and see each agent, its tool calls, the tokens, cost and time.
//
// How it works: the AI SDK reports each call as OpenTelemetry "spans" (one
// for the call, one per model step, one per tool). Langfuse's span processor
// sends those spans to your Langfuse project. Ask Copper groups one chat turn
// (Copper, any handoff, the Refund agent) into a single trace with `traced`.
//
// Without the three LANGFUSE_* variables nothing is sent and the app works
// exactly as before.
import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim() &&
    process.env.LANGFUSE_BASE_URL?.trim(),
  );
}

let processor: LangfuseSpanProcessor | undefined;

/**
 * Starts sending AI calls to Langfuse. Called once when the server starts
 * (instrumentation.ts) and at the top of scripts. Safe to call twice.
 * Returns false (and does nothing) when the Langfuse keys aren't set.
 */
export function startTracing(): boolean {
  if (processor) return true;
  if (!isTracingConfigured()) return false;
  processor = new LangfuseSpanProcessor({
    // Serverless functions (Vercel) can freeze right after replying, so send
    // each span straight away there; locally, batch them.
    exportMode: process.env.VERCEL ? "immediate" : "batched",
    environment: process.env.VERCEL_ENV ?? "development",
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();
  registerTelemetry(new OpenTelemetry());
  return true;
}

/** Sends any spans still waiting. Scripts call this before they exit. */
export async function flushTracing(): Promise<void> {
  await processor?.forceFlush();
}
