# AutoSeguro verification feature map

This directory is the maintained map for AutoSeguro's customer-visible WhatsApp and CLI behavior. Read the matching feature file, then use its literal command. Run the helper without `--feature` for the 200-journey matrix.

## Baseline preconditions

- Run from the repository root with Node.js 22.18 or newer and installed npm dependencies.
- Let `verify.mjs` launch the real app. It refuses to drive an instance it did not start and doctor.
- Use only the helper's random loopback ports and unique scratch state.

## Driving conventions

- Start each journey with a signed Meta-shaped request to production `POST /webhook`.
- Follow the exact action ID returned by the preceding outbound payload.
- Treat the quote, Meta Graph, and LLM processes as deterministic local peers, not app substitutes.
- Use `node .cursor/skills/verify-autoseguro/verify.mjs --run-id NAME` for the full matrix.

## Proof and cleanup

- Require action plus visible result, persisted state, audit, outbound order, and one quote operation per intended quote.
- Read the reported `.artifacts/verify-autoseguro/<run-id>/index.md`, then inspect the named JSONL evidence.
- Cleanup removes `.scratch` and recorded child processes. Evidence remains.

## Features

- [Greeting and plan selection](greeting-plan-selection.md): fresh greeting, persisted handoff recovery, catalog choice, and reselection.
- [Progressive quote success](progressive-quote-success.md): one field at a time through pending and final quote.
- [Pending asynchronous delivery](pending-async-delivery.md): fast acknowledgement, status, outbox, and ordering.
- [Failure and handoff](failure-handoff.md): retry, refusal, transport, language, media, and human paths.
- [Ending and CSAT](ending-csat.md): close action, all ratings, and rich/fallback/CLI parity.
- [Quote hire](quote-hire.md): interactive list choice, preserved quote job, and issuance handoff.
