import { readFile } from "node:fs/promises";

import { createModels, createProvider, type Model, type Models } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { z } from "zod";

const catalogSchema = z.object({
  providers: z.record(
    z.string(),
    z.object({
      baseUrl: z.string().min(1),
      apiKey: z.string().min(1),
      api: z.enum(["anthropic-messages", "openai-responses"]),
      models: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).min(1),
    }),
  ),
});

export type CatalogFile = z.infer<typeof catalogSchema>;

export type ModelCatalogView = {
  readonly defaultModelId: string;
  readonly models: readonly {
    readonly provider: string;
    readonly id: string;
    readonly name: string;
  }[];
};

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function parseCatalog(value: unknown): CatalogFile {
  return catalogSchema.parse(value);
}

export async function readCatalog(path: string): Promise<CatalogFile> {
  const text = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  return parseCatalog(parsed);
}

export function catalogView(file: CatalogFile, defaultModel: string): ModelCatalogView {
  const models = Object.entries(file.providers).flatMap(([provider, entry]) =>
    entry.models.map((model) => ({ provider, id: model.id, name: model.name })),
  );
  const known = models.some((model) => `${model.provider}/${model.id}` === defaultModel);
  if (!known) {
    throw new Error(`DEFAULT_MODEL ${defaultModel} is not in the catalog.`);
  }
  return { defaultModelId: defaultModel, models };
}

export function registerCatalog(file: CatalogFile): Models {
  const models = createModels();
  for (const [providerId, entry] of Object.entries(file.providers)) {
    const api = entry.api === "anthropic-messages" ? anthropicMessagesApi() : openAIResponsesApi();
    const listed: Model<typeof entry.api>[] = entry.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: entry.api,
      provider: providerId,
      baseUrl: entry.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: zeroCost,
      contextWindow: 128_000,
      maxTokens: 8_192,
    }));
    models.setProvider(
      createProvider({
        id: providerId,
        name: providerId,
        baseUrl: entry.baseUrl,
        auth: {
          apiKey: {
            name: `${providerId} API key`,
            async resolve() {
              return { auth: { apiKey: entry.apiKey }, source: "model_providers.json" };
            },
          },
        },
        models: listed,
        api,
      }),
    );
  }
  return models;
}
