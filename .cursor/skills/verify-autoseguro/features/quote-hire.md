# Quote hire and issuance handoff

A customer with a resolved quote can choose \`Contratar plano\` from the interactive options list and transition into commercial handoff for policy issuance (\`issuance_requested\`).

## Sub-features

- \`hire-interactive-action\` delivers \`quote_hire\` through the 4-action interactive list (\`Opções\`).
- \`issuance-handoff\` records \`handoff_reason = "issuance_requested"\` with public short reference and preserves the delivered quote job.
- \`idempotent-preservation\` ensures no additional quote is triggered and delivered state remains durable.

## How to get to it (user POV)

- Complete a quote to resolved state.
- Open options list and choose \`Contratar plano\`.
- Receive issuance confirmation with customer reference and guidance from a specialist.

## Driving it with verify.mjs

- Run \`node .cursor/skills/verify-autoseguro/verify.mjs --feature quote-hire\`.
