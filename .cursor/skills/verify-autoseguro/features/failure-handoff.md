# Failure and handoff

A customer gets a plain handoff when AutoSeguro cannot finish safely, while internal evidence retains the precise cause and attempt history.

## Sub-features

- `retry-recovery` covers timeout and 500, 502, or 503 recovery.
- `infrastructure-handoff` covers exhausted failures, network loss, malformed success, 400, and other 4xx responses.
- `eligibility-refusal` covers age and vehicle-age refusal without price.
- `conversation-handoff` covers human request, unsupported request, repeated ambiguity, unavailable language model, and media.
- `late-result` keeps a human handoff when an older quote returns later.

## How to get to it (user POV)

- Submit valid quote data and read the pending reply before a failure result.
- Ask for a person from the greeting or while a quote is pending.
- Send unsupported media, an out-of-scope request, or two ambiguous replies.
- Submit an ineligible age or vehicle year.

## Driving it with verify.mjs

Preconditions:

- Run from the AutoSeguro repository root with Node.js 22.18 or newer and installed npm dependencies.
- Let Doctor create and own the disposable server. Use no existing server.

- **Drive exhausted retries.** Run `node .cursor/skills/verify-autoseguro/verify.mjs --feature failure-handoff`. The local quote peer returns 500, 502, and 503 in order.
- **Observe the handoff.** Open the reported `journeys.jsonl` row. It shows the pending message, terminal handoff, three attempts, failed job, delivered outbox, and copy-policy verdict.
- **Prove every reason.** Run `node .cursor/skills/verify-autoseguro/verify.mjs`. `summary.json` reports every externally reachable handoff reason with a nonzero count.

## Gotchas

- Customer copy must omit HTTP status, retry language, raw failure reason, price, and full quote UUID.
- `quote_request_id` remains whole only in internal evidence.
- A late quote result must produce `quote_ignored` and must not replace a human handoff.
