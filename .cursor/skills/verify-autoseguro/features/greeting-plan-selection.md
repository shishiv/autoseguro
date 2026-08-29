# Greeting and plan selection

A customer can start or restart a quote, compare the official plans, inspect one plan, and continue without seeing a price presented as a catalog benefit.

## Sub-features

- `greeting-fresh` shows one branded greeting with `quote_start`, `plans_view`, and `human_help`.
- `handoff-recovery` resumes from persisted handoff with accent-insensitive `NOVA COTACAO`.
- `plan-education` shows exact coverage, deductible, and 30-day roubo/furto waiting-period content for each plan.
- `plan-reselect` returns from plan detail to comparison and selects another plan.

## How to get to it (user POV)

- Send `Oi` from a fresh WhatsApp conversation.
- Choose `Ver planos`, then choose Essencial, Completo, or Premium.
- Choose `Comparar planos` from plan detail to reselect.
- From a handed-off conversation, send `NOVA COTACAO`.

## Driving it with verify.mjs

Preconditions:

- Run from the AutoSeguro repository root with Node.js 22.18 or newer and installed npm dependencies.
- Let Doctor create and own the disposable server. Use no existing server.

- **Drive persisted recovery.** Run `node .cursor/skills/verify-autoseguro/verify.mjs --feature greeting-plan-selection`. The helper greets a fresh customer, takes the returned `human_help` action, restarts the process, sends `NOVA COTACAO`, and follows the returned plan and continue IDs.
- **Observe the journey.** Open the reported `journeys.jsonl` row. It contains the greeting, handoff, restart-safe recovery, bare age and year, CEP, pt-BR date, pending reply, and final quote.
- **Prove all plans.** Run `node .cursor/skills/verify-autoseguro/verify.mjs`. The aggregate report has nonzero counts for all three plan IDs, and the reselection family checks every catalog branch.

## Gotchas

- Titles are customer copy. Drive the exact action ID returned in the prior Meta payload.
- Plan education includes the official deductible and benefits. It must not present R$ 119,90, R$ 209,90, or R$ 339,90 as a benefit.
- A restart must preserve the handoff state before `NOVA COTACAO` clears it.
