import { z } from "zod";

const Schema = z.object({
  LYZR_API_KEY: z.string().min(1),
  LYZR_BASE_URL: z.string().url().default("https://agent-prod.studio.lyzr.ai"),
});

export function loadEnv() {
  const parsed = Schema.parse(process.env);
  return {
    lyzrApiKey: parsed.LYZR_API_KEY,
    lyzrBaseUrl: parsed.LYZR_BASE_URL,
  };
}

export type Env = ReturnType<typeof loadEnv>;
