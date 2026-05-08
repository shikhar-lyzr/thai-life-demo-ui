import { describe, it, expect, beforeEach } from "vitest";
import { loadEnv } from "../env";

describe("loadEnv", () => {
  beforeEach(() => {
    delete process.env.LYZR_API_KEY;
    delete process.env.LYZR_BASE_URL;
  });

  it("returns config when all vars set", () => {
    process.env.LYZR_API_KEY = "sk-test";
    process.env.LYZR_BASE_URL = "https://lyzr.example";
    const env = loadEnv();
    expect(env.lyzrApiKey).toBe("sk-test");
    expect(env.lyzrBaseUrl).toBe("https://lyzr.example");
  });

  it("uses default for LYZR_BASE_URL when not set", () => {
    process.env.LYZR_API_KEY = "sk-test";
    const env = loadEnv();
    expect(env.lyzrBaseUrl).toBe("https://agent-prod.studio.lyzr.ai");
  });

  it("throws when LYZR_API_KEY missing", () => {
    expect(() => loadEnv()).toThrow(/LYZR_API_KEY/);
  });
});
