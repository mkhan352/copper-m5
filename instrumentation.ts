// Next.js runs register() once when the server starts. Module 5 uses it to
// send every AI call to Langfuse (lib/ai/tracing.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTracing } = await import("@/lib/ai/tracing");
    startTracing();
  }
}
