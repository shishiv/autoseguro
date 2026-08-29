# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Run `npm run check` before committing; it covers strict TypeScript, oxlint complexity rules, and all tests.
- Run the seeded API and `npm run evaluate -- --conversations 100` when refreshing reliability artifacts under `examples/evaluation/`.
- Treat the official quote service as the sole price and acceptance authority. See `README.md` for its source and the failure contract.
- Keep source code comment-free. Put rationale in `README.md`.
- Do not fabricate `ai-logs/` or the real conversation under `examples/`; those artifacts must come from actual runs.
- Treat the Meta channel as test-WABA-only. Use the guarded commands and rollback in `README.md`; preserve the app's canonical callback.
- Use [`.cursor/skills/verify-autoseguro/SKILL.md`](.cursor/skills/verify-autoseguro/SKILL.md) for isolated signed-webhook E2E proof; its helper blocks non-loopback traffic.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
