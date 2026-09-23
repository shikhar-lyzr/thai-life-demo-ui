import { describe, it, expect } from "vitest";
import { extractAgentJson } from "../agent-json";

describe("extractAgentJson", () => {
  it("returns the last json fence after a Markdown report", () => {
    const raw = "# Report\n\n| a | b |\n\n```json\n{\"page_count\": 8, \"pages\": []}\n```\n";
    expect(extractAgentJson(raw)).toEqual({ page_count: 8, pages: [] });
  });

  it("skips a non-json preamble fence and parses the json one", () => {
    const raw = "```python\nimport anthropic\n```\n\n```json\n{\"case_id\": \"X-1\"}\n```";
    expect(extractAgentJson(raw)).toEqual({ case_id: "X-1" });
  });

  it("tolerates raw line breaks inside string values", () => {
    const raw = '```json\n{"section_3_risk_profile": "Medications:\n- Amitriptyline\t10 mg"}\n```';
    expect(extractAgentJson(raw)).toEqual({ section_3_risk_profile: "Medications:\n- Amitriptyline\t10 mg" });
  });

  it("tolerates unescaped quotes inside string values", () => {
    const raw = '```json\n{"financial_signals": "Payment: "Self Pay - P001" — full self-pay", "n": 1}\n```';
    expect(extractAgentJson(raw)).toEqual({ financial_signals: 'Payment: "Self Pay - P001" — full self-pay', n: 1 });
  });

  it("returns null when no fence parses", () => {
    expect(extractAgentJson("no json here")).toBeNull();
    expect(extractAgentJson("```json\n{broken\n```")).toBeNull();
  });
});
