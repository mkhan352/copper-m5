// npm run eval: the golden-set evaluation (Module 5). Kept apart from
// `npm test` because it calls Gemini for real and takes a few minutes.
import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local (CI): the keys come from the environment.
}

// Gemini's free plan allows 15 requests a minute: stay just under it.
process.env.AI_MAX_RPM ??= "14";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 900_000,
  },
});
