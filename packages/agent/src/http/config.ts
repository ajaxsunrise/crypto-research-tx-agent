import { config as loadDotenv } from "dotenv";

export type ServerConfig = {
  readonly httpHost: string;
  readonly httpPort: number;
  /** The one Postgres schema every tenant's rows live in. */
  readonly schema: string;
  readonly connectionString: string;
  readonly sandboxRoot: string;
  readonly defaultModel: string;
  readonly catalogPath: string;
  readonly tenantTokens: string;
  readonly webDistPath: string | undefined;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing ${name}.`);
  }
  return value.trim();
}

function requiredPort(env: NodeJS.ProcessEnv, name: string): number {
  const raw = required(env, name);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer port.`);
  }
  return port;
}

export function connectionStringFrom(input: {
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
}): string {
  const url = new URL("postgres://localhost");
  url.hostname = input.host;
  url.port = String(input.port);
  url.username = input.user;
  url.password = input.password;
  url.pathname = `/${input.name}`;
  return url.toString();
}

export function loadServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const password = env.DB_PASSWORD ?? "";
  const webDist = env.WEB_DIST?.trim();
  const schema = env.SCHEMA?.trim();
  return {
    httpHost: required(env, "HTTP_HOST"),
    httpPort: requiredPort(env, "HTTP_PORT"),
    schema: schema === undefined || schema === "" ? "crypto_agent" : schema,
    sandboxRoot: required(env, "SANDBOX_ROOT"),
    defaultModel: required(env, "DEFAULT_MODEL"),
    catalogPath: required(env, "CATALOG_PATH"),
    tenantTokens: required(env, "TENANT_TOKENS"),
    webDistPath: webDist === undefined || webDist === "" ? undefined : webDist,
    connectionString: connectionStringFrom({
      host: required(env, "DB_HOST"),
      port: requiredPort(env, "DB_PORT"),
      user: required(env, "DB_USER"),
      password,
      name: required(env, "DB_NAME"),
    }),
  };
}

export function loadEnvFile(path = ".env"): void {
  loadDotenv({ path });
}
