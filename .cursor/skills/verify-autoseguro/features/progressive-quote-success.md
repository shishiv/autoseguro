# Progressive quote success

A customer can answer one prompt at a time and receive a quote after the five required fields are valid.

## Sub-features

- `progressive-plan` opens plan education and continues with the selected plan.
- `progressive-scalars` accepts bare numeric age and vehicle year.
- `progressive-cep` covers normal and high-risk CEP input.
- `progressive-date` covers ISO, pt-BR, Today, Tomorrow, and Other date paths.
- `progressive-final` shows pending first, then delivers and persists the quote.

## How to get to it (user POV)

- Send `Oi`, choose `Ver planos`, choose a plan, and choose `Continuar`.
- Enter age, vehicle year, CEP, and policy start when each prompt appears.
- Read the immediate pending message, then the separate final quote.

## Driving it with verify.mjs

Preconditions:

- Run from the AutoSeguro repository root with Node.js 22.18 or newer and installed npm dependencies.
- Let Doctor create and own the disposable server. Use no existing server.

- **Drive one journey.** Run `node .cursor/skills/verify-autoseguro/verify.mjs --feature progressive-quote-success`. The helper follows only action IDs found in the preceding outbound Meta payload.
- **Observe each turn.** Open the reported `journeys.jsonl` row. `messages_driven` and `outbound_sequence` pair each answer with the next prompt, pending reply, and final quote.
- **Prove date variants.** Run `node .cursor/skills/verify-autoseguro/verify.mjs`. `summary.json` reports all five policy-start forms plus pro-rata true and false.

## Gotchas

- Stored policy start is ISO. Customer copy is pt-BR.
- A mid-month quote shows the first payment returned by the quote peer. The agent does not calculate its own price.
- Roubo and furto wait 30 days from policy start. The reply must not invent an exact effective date.
