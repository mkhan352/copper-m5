// npm run push-secrets: copies the keys CI needs from .env.local into your
// GitHub repo's Actions secrets, without printing them. Reads .env.local the
// way Node does (quotes and spaces removed), so CI gets the same values.
import { execFileSync } from "node:child_process";

const NAMES = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
];

process.loadEnvFile(".env.local");
// Your own repo (origin), not the class repo (upstream).
const repo = execFileSync("git", ["remote", "get-url", "origin"], {
  encoding: "utf8",
}).trim();
for (const name of NAMES) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.log(`${name}: not set in .env.local, skipped`);
    continue;
  }
  execFileSync("gh", ["secret", "set", name, "--repo", repo], {
    input: value,
    stdio: ["pipe", "ignore", "inherit"],
  });
  console.log(`${name}: copied (${value.length} characters)`);
}
