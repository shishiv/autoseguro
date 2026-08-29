---
name: verify-autoseguro
description: Verify AutoSeguro end to end through its local Meta WhatsApp webhook/API surface. Use for E2E proof of signed webhook journeys, rich and fallback interactions, asynchronous quotes, retries, handoffs, persistence, audit, CLI parity, or customer copy without any live system.
---

# Verify AutoSeguro

Run from the repository root. Read the relevant [feature map](features/README.md) before choosing a narrow proof. The helper drives the production `/webhook` route and replaces only the Meta Graph, quote, and OpenAI-compatible boundaries with deterministic loopback HTTP peers.

## Launch

Run one mapped journey:

```bash
node .cursor/skills/verify-autoseguro/verify.mjs --feature progressive-quote-success
```

The command runs `npm run check`, allocates random loopback ports, creates a unique state directory, launches the real `src/server.ts`, and waits for `/health`. A `PASS` line and an evidence path mark completion. Any failed check returns nonzero.

## Doctor

Every drive runs Doctor before its first signed webhook. Run it alone when startup looks wrong:

```bash
node .cursor/skills/verify-autoseguro/verify.mjs --doctor
```

Doctor proves the Git SHA and source fingerprint, successful project check, child PID ownership, `127.0.0.1` socket ownership, matching health revision, webhook challenge, writable isolated state, fixed test configuration, local fake peers, and the outbound network fence. It reads health and configuration but sends no user message. Do not bypass a failed Doctor.

## Drive

Choose one feature:

```bash
node .cursor/skills/verify-autoseguro/verify.mjs --feature greeting-plan-selection
node .cursor/skills/verify-autoseguro/verify.mjs --feature progressive-quote-success
node .cursor/skills/verify-autoseguro/verify.mjs --feature pending-async-delivery
node .cursor/skills/verify-autoseguro/verify.mjs --feature failure-handoff
node .cursor/skills/verify-autoseguro/verify.mjs --feature ending-csat
```

Run the default full suite:

```bash
node .cursor/skills/verify-autoseguro/verify.mjs
```

The default reads `scenarios.json` and refuses drift from ten exclusive families, 20 complete journeys each, and 200 journeys total. Each journey starts with a correctly signed Meta-shaped inbound request. The helper follows action IDs from the outbound Meta payload, never an internal state setter or test-only route. The full run also proves numbered Meta fallbacks and a real CLI replay against the same local peers.

Use `--run-id NAME` for a stable artifact name. The helper refuses an existing name rather than overwriting proof.

## Evidence

Proof lands in `.artifacts/verify-autoseguro/<run-id>/`:

- `index.md` and `summary.json` hold the verdict and actual coverage counts.
- `journeys.jsonl` holds one sanitized row per complete journey: driven messages, outbound order, terminal state, quote attempts, timing, persistence and audit checks, and copy verdict.
- `requests.jsonl`, `responses.jsonl`, and `timeline.jsonl` hold signed webhook traffic plus local Meta, quote, and LLM boundary traffic.
- `audit-extract.jsonl` retains full internal quote correlation. `state-extract.jsonl` records sanitized persisted state.
- `doctor.jsonl`, `commands.log`, `build.log`, and `logs/` prove ownership, launch, checks, and process output.

A passing journey includes the action and visible result, typing-before-message order, persisted state, quote and outbox cardinality, audit events, and no duplicate operation. Customer copy must contain no API, HTTP, retry or attempt jargon, background-job language, or full UUID. Full correlation stays in internal evidence and never in customer copy.

The full suite fails if any family is not exactly 20 or if required plan, ActionId, retry, handoff, date, risk, pro-rata, waiting-period, rich/fallback, CLI, or CSAT coverage is empty.

## Cleanup

Cleanup runs in `finally` on success and failure. It sends signals only to recorded child PIDs, closes the local peer, and removes each run's `.scratch` state and intake. It preserves every evidence file listed above. Never use `pkill`, a shared port, `.runtime/`, or a live app for this proof.

After a run, confirm:

```bash
test -f .artifacts/verify-autoseguro/<run-id>/index.md
test ! -e .artifacts/verify-autoseguro/<run-id>/.scratch
```

## Helpers

`.cursor/skills/verify-autoseguro/verify.mjs` is the executable entry point. It accepts only `--feature`, `--doctor`, `--run-id`, and `--help`. It does not accept a remote base URL or credentials. Its child mode forces the app to loopback and rejects every non-loopback fetch; the hard-coded Meta Graph URL is redirected to the local peer before `src/server.ts` loads.

Show the command contract:

```bash
node .cursor/skills/verify-autoseguro/verify.mjs --help
```
