import { describe, it, expect, beforeEach } from "vitest";
import { loadEnv } from "../env";

describe("loadEnv", () => {
  beforeEach(() => {
    delete process.env.LYZR_API_KEY;
    delete process.env.WRAPPER_KEY;
    delete process.env.WRAPPER_URL;
    delete process.env.LYZR_BASE_URL;
  });

  it("returns config when all vars set", () => {
    process.env.LYZR_API_KEY = "sk-test";
    process.env.WRAPPER_KEY = "wk-test";
    process.env.WRAPPER_URL = "https://wrapper.example";
    process.env.LYZR_BASE_URL = "https://lyzr.example";
    const env = loadEnv();
    expect(env.lyzrApiKey).toBe("sk-test");
    expect(env.wrapperKey).toBe("wk-test");
    expect(env.wrapperUrl).toBe("https://wrapper.example");
    expect(env.lyzrBaseUrl).toBe("https://lyzr.example");
  });

  it("uses defaults for WRAPPER_URL and LYZR_BASE_URL when not set", () => {
    process.env.LYZR_API_KEY = "sk-test";
    process.env.WRAPPER_KEY = "wk-test";
    const env = loadEnv();
    expect(env.wrapperUrl).toBe("https://vlm-reparse-wrapper.onrender.com");
    expect(env.lyzrBaseUrl).toBe("https://agent-prod.studio.lyzr.ai");
  });

  it("throws when LYZR_API_KEY missing", () => {
    process.env.WRAPPER_KEY = "wk-test";
    expect(() => loadEnv()).toThrow(/LYZR_API_KEY/);
  });

  it("throws when WRAPPER_KEY missing", () => {
    process.env.LYZR_API_KEY = "sk-test";
    expect(() => loadEnv()).toThrow(/WRAPPER_KEY/);
  });
});
