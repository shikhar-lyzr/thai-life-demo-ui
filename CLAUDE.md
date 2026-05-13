@AGENTS.md

# Thai Life PoC — Claude session instructions

## Read first, every session

Before any non-trivial work in this repo, read in this order:

1. `docs/session-brief-2026-05-13.md` — most recent session summary. Picks up where the prior Claude left off, with current diagnosis, decisions made with Parshva, and where the chunking-architecture brainstorming paused.
2. `docs/architecture-handoff.md` — durable architecture description of the deployed system (Next.js app, wrapper-free, agent IDs, Lyzr endpoints).
3. The user-memory index at `/Users/shikhar-agrawal/.claude/projects/-Users-shikhar-agrawal-vlm-reparse-wrapper/memory/MEMORY.md` and any entries it points to that are relevant to the task. The index is auto-loaded into context already; read the linked files when their topic applies.

If a newer session brief exists (`docs/session-brief-YYYY-MM-DD.md`), read the newest one. Older briefs are historical context.

## Always use superpowers

The user has the superpowers plugin installed. **Before any non-trivial work — including clarifying questions — invoke the relevant skill via the `Skill` tool.** Skills override default behavior; do not skip them. Specific expectations:

- **`superpowers:systematic-debugging`** — invoke when diagnosing any bug, test failure, or unexpected behavior. Phase 1 (evidence gathering) before any fix attempt. The user has flagged this expectation in their memory (`feedback_systematic_debugging`).
- **`superpowers:brainstorming`** — invoke before designing any feature, component, or architectural change. The brainstorming flow ends with a written design doc in `docs/superpowers/specs/` and a transition to `superpowers:writing-plans` — do not skip these steps.
- **`superpowers:verification-before-completion`** — invoke before claiming any work is done. Evidence before assertions, always. Run the actual test, look at the actual output, then report.
- **`superpowers:test-driven-development`** — invoke before writing implementation code for any feature or bugfix.

When unsure whether a skill applies, briefly check the index first rather than skipping. Even a 1% chance a skill might apply means invoke it.

## Communication style

- Terse. No narration of internal reasoning. Direct sentences only.
- Slack drafts should sound like Shikhar would write them — human, not corporate. Avoid emoji unless asked.
- When the user redirects ("are you sure?", "stop guessing", "is that not happening?") — stop, return to Phase 1 of systematic-debugging, gather evidence before re-asserting.
- Honest about uncertainty. "I asserted that without proof; let me actually test it" is better than confident speculation.

## Project-specific constraints (durable)

These are non-negotiable across sessions unless Shikhar explicitly unlocks them:

- **Do not modify `lib/lyzr.ts::VLM_QUERY_PARAMS` shape.** The query-string form is the only one that works.
- **Do not add `specific_pages`, `start_page`, or `end_page` to upload params** without explicit authorization.
- **Do not proxy `LYZR_API_KEY` through the frontend.** All `/v3/*` calls happen server-side in Next.js route handlers.
- **Do not commit secrets or customer PDFs.** `.env.local` and `*.pdf` are gitignored.
- **Do not reintroduce the standalone wrapper service.** It was removed in commit 10330b8.
- **Do not switch configured models** (`gpt-4o` for VLM, `claude-sonnet-4-5` for agents) without explicit authorization — each model change invalidates prior validation runs.
- **Do not touch the three agent prompts in Lyzr Studio** without explicit authorization for that round. The user has unlocked prompt edits before, but each edit invalidates validation; coordinate first.

## Where the code lives

- This Next.js app is the only production-relevant codebase. Wrapper repo at `/Users/shikhar-agrawal/vlm-reparse-wrapper` is deprecated.
- `lib/lyzr.ts` — Lyzr API helpers (upload + agent call with retry).
- `lib/orchestrator.ts` — `processPdf`: single upload + 3 parallel agents via `Promise.allSettled`.
- `lib/types.ts` — `AGENTS` constant (agent_id, user_id, message per agent — locked).
- `lib/env.ts` — zod env schema.
- `app/api/jobs/` and `app/jobs/[id]/page.tsx` — REST surface and job-detail UI.

## Macros to remember

- The `Skill` tool is invoked by name (e.g., `superpowers:systematic-debugging`), not by Read-ing files in the skill directory.
- macOS bash is 3.2 — no `declare -A`, no `date +%s%3N`. Diagnostic scripts in `/tmp/` are written against this constraint.
- Render free tier has cold-start latency (~30s wake) and in-memory state is wiped on restart/deploy.
- The current Beryl8 demo is gated on the scanned-PDF parsing bug; see the session brief for the full picture and the planned chunking workaround.
