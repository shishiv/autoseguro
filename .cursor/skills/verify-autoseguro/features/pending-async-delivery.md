# Pending asynchronous delivery

A customer receives a quick acknowledgement while the quote runs, then receives the terminal result as a separate outbound message.

## Sub-features

- `webhook-ack` accepts the signed event before quote completion.
- `pending-copy` confirms receipt without showing a price.
- `typing-order` sends typing presence before immediate and final messages.
- `async-final` delivers the result through the durable outbox.
- `single-operation` keeps one quote correlation across attempts.

## How to get to it (user POV)

- Send all five quote fields in one WhatsApp message.
- Read the pending confirmation.
- While a slow quote remains pending, ask `Já conseguiu?` or ask about coverage.
- Wait for the later quote or handoff message.

## Driving it with verify.mjs

Preconditions:

- Run from the AutoSeguro repository root with Node.js 22.18 or newer and installed npm dependencies.
- Let Doctor create and own the disposable server. Use no existing server.

- **Drive one journey.** Run `node .cursor/skills/verify-autoseguro/verify.mjs --feature pending-async-delivery`. The helper sends a complete signed inbound event and waits for both deliveries.
- **Observe order.** Open `timeline.jsonl` under the reported run. It shows webhook acknowledgement, presence, pending delivery, local quote call, final presence, and final delivery.
- **Confirm persistence.** Read the matching `state-extract.jsonl` and `audit-extract.jsonl` rows. The job and outbox are delivered once under one full internal correlation ID.

## Gotchas

- Webhook HTTP 200 acknowledges intake. It does not mean the quote finished.
- The pending message contains no price.
- Retries keep one quote request ID. Only the accepted final outbox message receives `delivered_at`.
