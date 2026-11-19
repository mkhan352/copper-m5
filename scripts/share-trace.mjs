// npm run share-trace: makes a Langfuse trace public and prints its link, so
// anyone can open it without a Langfuse account. With no argument it shares
// the latest refund conversation (a trace where request_refund was called);
// or pass a trace id: npm run share-trace -- <traceId>
import { registerHooks } from "node:module";
import { LangfuseClient } from "@langfuse/client";
import { startObservation } from "@langfuse/tracing";

const root = new URL("../", import.meta.url);
registerHooks({
  load: (url, context, next) =>
    next(
      url,
      url.endsWith(".ts")
        ? { ...context, format: "module-typescript" }
        : context,
    ),
});
try {
  process.loadEnvFile(new URL(".env.local", root));
} catch {
  // No .env.local: the keys may already be in the environment.
}

const { flushTracing, startTracing } = await import("../lib/ai/tracing.ts");
if (!startTracing()) {
  console.error(
    "share-trace: add the three LANGFUSE_* keys to .env.local first.",
  );
  process.exit(1);
}

const langfuse = new LangfuseClient();
let traceId = process.argv[2];
if (!traceId) {
  const { data } = await langfuse.api.observations.getMany({
    name: "request_refund",
    limit: 1,
  });
  traceId = data[0]?.traceId;
  if (!traceId) {
    console.error(
      "share-trace: no refund conversation yet. Ask Copper for a refund on the Support page first.",
    );
    process.exit(1);
  }
}

// Langfuse marks a trace public when any span in it says so: add a tiny one
// under the trace's first observation.
const { data: roots } = await langfuse.api.observations.getMany({
  traceId,
  isRootObservation: true,
  limit: 1,
});
if (!roots[0]) {
  console.error(`share-trace: no trace ${traceId} in this Langfuse project.`);
  process.exit(1);
}
startObservation(
  "shared",
  {},
  {
    parentSpanContext: { traceId, spanId: roots[0].id, traceFlags: 1 },
  },
)
  .setTraceAsPublic()
  .end();
await flushTracing();

const { data: projects } = await langfuse.api.projects.get();
const base = process.env.LANGFUSE_BASE_URL.replace(/\/+$/, "");
console.log(`Public link: ${base}/project/${projects[0].id}/traces/${traceId}`);
