export type AgentJson = Record<string, unknown>;

/**
 * Pulls the structured JSON out of an agent response.
 *
 * Agents wrap it in a ```json fence, sometimes after a Markdown report or a
 * stray preamble (Summarisation has emitted a ```python block first).
 * Summarisation also puts raw line breaks and unescaped quotes inside string
 * values, which JSON.parse rejects, so those are repaired first. Tries fences
 * last-first and returns the first object that parses.
 */
export function extractAgentJson(raw: string): AgentJson | null {
  const fence = /```json\s*([\s\S]*?)```/g;
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(raw)) !== null) bodies.push(m[1]);

  for (const body of bodies.reverse()) {
    try {
      const parsed: unknown = JSON.parse(repairStrings(body));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as AgentJson;
    } catch {
      // try the previous fence
    }
  }
  return null;
}

/**
 * Escapes raw control characters inside string literals, and any quote inside
 * a string whose next non-space character could not follow a closing quote
 * (e.g. `"Payment: "Self Pay" — full"`).
 */
function repairStrings(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') {
        const next = s.slice(i + 1).match(/\S/)?.[0];
        if (next === undefined || ",:}]".includes(next)) inString = false;
        else { out += '\\"'; continue; }
      }
      else if (c === "\n") { out += "\\n"; continue; }
      else if (c === "\r") { out += "\\r"; continue; }
      else if (c === "\t") { out += "\\t"; continue; }
    } else if (c === '"') {
      inString = true;
    }
    out += c;
  }
  return out;
}
