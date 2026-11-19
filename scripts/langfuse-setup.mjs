// npm run langfuse:setup: run once after adding the LANGFUSE_* keys.
// Tells your Langfuse project what each course model costs (the prices in
// lib/ai/pricing.ts), so every trace shows its cost in dollars. Safe to run
// again: it replaces the prices it added before.
import { registerHooks } from "node:module";
import { LangfuseClient } from "@langfuse/client";

const root = new URL("../", import.meta.url);
// Tell Node the app's TypeScript files are ES modules, so it doesn't warn.
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

const { MODELS } = await import("../lib/ai/models.ts");
const { PRICING } = await import("../lib/ai/pricing.ts");
const { isTracingConfigured } = await import("../lib/ai/tracing.ts");

if (!isTracingConfigured()) {
  console.error(
    "langfuse:setup: add LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL to .env.local first.",
  );
  process.exit(1);
}

const langfuse = new LangfuseClient();

// The prices this script added last time (custom models with the same names).
const existing = [];
for (let page = 1; ; page++) {
  const { data, meta } = await langfuse.api.models.list({ page, limit: 100 });
  existing.push(...data);
  if (page >= meta.totalPages) break;
}

for (const model of MODELS) {
  const price = PRICING[model.id];
  for (const old of existing) {
    if (old.modelName === model.id && !old.isLangfuseManaged)
      await langfuse.api.models.delete(old.id);
  }
  // Traces name the model the way Google does ("gemini-3.5-flash-lite").
  const name = model.googleId.replace(/[.]/g, "\\.");
  await langfuse.api.models.create({
    modelName: model.id,
    matchPattern: `(?i)^(google/)?(models/)?${name}$`,
    unit: "TOKENS",
    inputPrice: price.input / 1_000_000,
    outputPrice: price.output / 1_000_000,
  });
  console.log(
    `${model.id}: $${price.input} in / $${price.output} out per million tokens`,
  );
}
console.log("Langfuse now knows what each model costs.");
