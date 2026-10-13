/**
 * Run by the crash tests as a separate process. It starts a run whose sandbox call kills the
 * process, so the parent sees exactly what a worker dying mid-tool leaves behind.
 *
 * argv: <scenario: read|order> <target: directory | postgres:<schema>>
 */
import type { Lease } from "@crypto/domain/lease";

import { createResearchAgent, openAgentWorker } from "../src/index.js";
import { call, crashTenant, scripted } from "./fixtures.js";

const [scenario, target] = process.argv.slice(2);

function dieInSandbox(_lease: Lease): never {
  // A hard exit: no finally blocks, no harness close, the connection just drops.
  process.exit(9);
}

const reply =
  scenario === "order"
    ? call("place-order", { symbol: "BTC", side: "buy", quantity: "1" })
    : call("read-market", { symbol: "BTC" });
const { models, model } = scripted([reply]);

const agent =
  target?.startsWith("postgres:") === true
    ? await openAgentWorker({
        schema: target.slice("postgres:".length),
        connectionString: process.env.CRYPTO_TEST_POSTGRES ?? "postgres:///crypto_research_test",
        models: () => models,
        model,
        sandbox: async (lease) => dieInSandbox(lease),
      })
    : await createResearchAgent({
        directory: target,
        models,
        model,
        sandbox: async (lease) => dieInSandbox(lease),
      });

const started = await agent.execute({
  kind: "start",
  tenantId: crashTenant,
  idempotencyKey: "crash",
  brief: { question: "What changed?", horizon: "24h" },
});
// For an order the run parks; approving it is what reaches the sandbox.
if (
  scenario === "order" &&
  started.kind === "ok" &&
  started.view.status.kind === "awaiting-approval"
) {
  process.stdout.write(`${JSON.stringify({ sessionId: started.view.sessionId })}\n`);
  await agent.execute({
    kind: "approve",
    tenantId: crashTenant,
    sessionId: started.view.sessionId,
    callId: started.view.status.callId,
    operationId: started.view.status.operationId,
    decision: "grant",
  });
}
// Reaching here means the sandbox was never called, which the parent reports as a failure.
process.exit(0);
