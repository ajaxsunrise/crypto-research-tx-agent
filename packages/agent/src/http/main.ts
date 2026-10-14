import { openAgentWorker } from "../worker.js";
import { createJwtAuth, createTenantAuthenticator, withJwtAuth } from "./auth.js";
import { catalogView, readCatalog, registerCatalog } from "./catalog.js";
import { loadEnvFile, loadServerConfig } from "./config.js";
import { openLogger } from "./logger.js";
import { createAgentHttp, listenAgentHttp } from "./server.js";
import { postgresThreads, type TenantThreads } from "./threads.js";
import { postgresUsers, type UserDirectory } from "./users.js";

loadEnvFile();
const config = loadServerConfig(process.env);
const log = openLogger(process.env);
const jwt = createJwtAuth(config.jwtSecret, config.jwtTtlSeconds);
const authenticate = withJwtAuth(createTenantAuthenticator(config.tenantTokens), jwt);
const catalog = await readCatalog(config.catalogPath);
const models = registerCatalog(catalog);
const worker = await openAgentWorker({
  connectionString: config.connectionString,
  schema: config.schema,
  sandboxRoot: config.sandboxRoot,
  skillsRoot: config.skillsRoot,
  codeSandbox: config.codeSandbox,
  firecrawlApiKey: config.firecrawlApiKey,
  model: config.defaultModel,
  models,
});
log.info("worker opened", {
  schema: config.schema,
  model: config.defaultModel,
  codeSandbox: config.codeSandbox.kind,
});
let threads: TenantThreads | undefined;
let users: UserDirectory | undefined;
let listening: Awaited<ReturnType<typeof listenAgentHttp>> | undefined;
let closing: Promise<void> | undefined;

async function closeResources(): Promise<void> {
  const results = await Promise.allSettled([listening?.close(), worker.close()]);
  results.push(...(await Promise.allSettled([threads?.close(), users?.close()])));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Server close failed.",
    );
  }
}

const initialized = (async () => {
  try {
    threads = await postgresThreads({
      connectionString: config.connectionString,
      schema: config.schema,
    });
    users = await postgresUsers({
      connectionString: config.connectionString,
      schema: config.schema,
    });
    const app = createAgentHttp({
      agent: worker,
      threads,
      users,
      jwt,
      models,
      defaultModel: config.defaultModel,
      catalog: catalogView(catalog, config.defaultModel),
      authenticate,
      log,
      webDistPath: config.webDistPath,
    });
    listening = await listenAgentHttp(app, config.httpHost, config.httpPort);
    return listening;
  } catch (error) {
    log.error("server initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await closeResources();
    } catch (closeError) {
      await log.close();
      throw new AggregateError([error, closeError], "Server initialization failed.");
    }
    await log.close();
    throw error;
  }
})();

function shutdown(): Promise<void> {
  closing ??= (async () => {
    try {
      await closeResources();
      log.info("server stopped");
    } finally {
      await log.close();
    }
  })();
  return closing;
}

function reportFailure(error: unknown): void {
  log.error("server failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown().catch(reportFailure);
  });
}
void worker.recovery.catch((error: unknown) => {
  reportFailure(error);
  void shutdown().catch(reportFailure);
});

const server = await initialized;
log.info("server listening", { url: server.url });
