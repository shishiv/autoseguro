# Ending and CSAT

A customer can end a resolved quote, choose one of three ratings, and reach a durable closed state on rich, fallback, and CLI-shaped paths.

## Sub-features

- `ending-actions` offers a new quote, human help, or service end after success.
- `csat-choice` accepts `csat_great`, `csat_regular`, and `csat_bad` only after service end.
- `csat-persistence` stores the rating and writes the CSAT audit event.
- `channel-parity` covers rich Meta, numbered Meta list and button fallbacks, and numbered CLI/replay choices.

## How to get to it (user POV)

- Complete a quote and choose `Encerrar atendimento`.
- Choose `Ótimo`, `Regular`, or `Ruim`.
- When rich delivery fails, choose the number shown beside the same option.
- In CLI/replay, choose the displayed number for the same plan and date.

## Driving it with verify.mjs

Preconditions:

- Run from the AutoSeguro repository root with Node.js 22.18 or newer and installed npm dependencies.
- Let Doctor create and own the disposable server. Use no existing server.

- **Drive Meta and CLI.** Run `node .cursor/skills/verify-autoseguro/verify.mjs --feature ending-csat`. The mapped journey closes a real Meta-webhook quote and runs the real CLI replay against the same loopback peers.
- **Observe closure.** Open the reported `journeys.jsonl` row. It records `closed`, the selected rating, and the `csat` audit event.
- **Prove parity.** Run `node .cursor/skills/verify-autoseguro/verify.mjs`. The full run requires every plan on each rich, list-fallback, button-fallback, and CLI/replay path to reach the same closed state and quote/CSAT audit outcome.

## Gotchas

- CSAT is accepted only after `service_end` sets `awaiting_csat`.
- A failed rich interaction must be followed by numbered text before the helper sends a number.
- A closed conversation stays closed until the customer starts a new quote.
