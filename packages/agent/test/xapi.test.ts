import assert from "node:assert/strict";
import test from "node:test";

import { loadEnvFile } from "../src/http/config.js";
import { createResearchAgent, type ExecuteResult, type SessionView } from "../src/index.js";
import { call, lastToolResultText, question, say, scripted, tenant } from "./fixtures.js";

const live = process.env.CRYPTO_LIVE_TESTS === "1";
if (live) {
  loadEnvFile();
}
const hasKey = live && (process.env.XAPI_API_KEY ?? "") !== "";

function view(result: ExecuteResult): SessionView {
  if (result.kind !== "ok") {
    assert.fail(`expected ok, got ${JSON.stringify(result.rejection)}`);
  }
  return result.view;
}

const brief = `${question}\nHorizon: 24h`;

test("xapi 工具在缺少 key 时返回配置错误", async () => {
  const { models, model } = scripted([
    call("xapi-get", { action: "binance-web3-api.api_v1_dex_market_token_search" }),
    (context) => {
      assert.match(lastToolResultText(context), /XAPI_API_KEY is not configured/);
      return call("xapi-call", { action: "binance-web3-api.api_v1_dex_market_supported_chain" });
    },
    (context) => {
      assert.match(lastToolResultText(context), /XAPI_API_KEY is not configured/);
      return say("xapi unavailable");
    },
  ]);
  const saved = process.env.XAPI_API_KEY;
  delete process.env.XAPI_API_KEY;
  let agent: Awaited<ReturnType<typeof createResearchAgent>> | undefined;
  try {
    agent = await createResearchAgent({ models, model });
    const started = view(
      await agent.execute({
        kind: "start",
        tenantId: tenant,
        idempotencyKey: "xapi-unset",
        input: brief,
      }),
    );
    assert.equal(started.status.kind, "completed");
  } finally {
    await agent?.close();
    if (saved !== undefined) {
      process.env.XAPI_API_KEY = saved;
    }
  }
});

type XapiEnvelope = {
  success?: boolean;
  data?: { code?: number; msg?: string; data?: { tokenSymbol?: string }[] };
};

test("xapi 工具读取 Binance Web3 行情数据", { skip: !hasKey, timeout: 120_000 }, async () => {
  const { models, model } = scripted([
    call("xapi-get", { action: "binance-web3-api.api_v1_dex_market_candles" }),
    (context) => {
      const schema = lastToolResultText(context);
      assert.ok(schema.includes("binance-web3-api.api_v1_dex_market_candles"));
      assert.ok(schema.includes("GET"));
      return call("xapi-call", { action: "binance-web3-api.api_v1_dex_market_supported_chain" });
    },
    (context) => {
      const chains = JSON.parse(lastToolResultText(context)) as XapiEnvelope;
      assert.equal(chains.success, true);
      assert.equal(chains.data?.code, 0);
      return call("xapi-call", {
        action: "binance-web3-api.api_v1_dex_market_token_search",
        params: { chains: "56", search: "USDT" },
      });
    },
    (context) => {
      const search = JSON.parse(lastToolResultText(context)) as XapiEnvelope;
      assert.equal(search.data?.code, 0);
      assert.equal(search.data?.data?.[0]?.tokenSymbol, "USDT");
      return say("market data read");
    },
  ]);
  const agent = await createResearchAgent({ models, model });
  try {
    const started = view(
      await agent.execute({
        kind: "start",
        tenantId: tenant,
        idempotencyKey: "xapi-live",
        input: brief,
      }),
    );
    assert.equal(started.status.kind, "completed");
  } finally {
    await agent.close();
  }
});
