# Public AI work log

This package records the AI-assisted work that produced AutoSeguro for the KHAL challenge. It contains normalized exports, not raw provider or agent logs. The shipped product is the implementation in PRs [#1](https://github.com/shishiv/autoseguro/pull/1), [#2](https://github.com/shishiv/autoseguro/pull/2), [#3](https://github.com/shishiv/autoseguro/pull/3), and [#4](https://github.com/shishiv/autoseguro/pull/4).

## Scope and chronology

1. [2026-08-27 Cursor MVP summary](sessions/2026-08-27-cursor-mvp-superseded.jsonl) — superseded and not shipped. Only its existing summary was available.
2. [Main Firstmate orchestration](sessions/2026-08-28-main-orchestration.jsonl) — the KHAL interval from the first challenge request through this export dispatch.
3. [Core implementation](sessions/2026-08-28-core-implementation.jsonl) — PR 1, the real quote conversation, and reliability work.
4. [Meta pilot](sessions/2026-08-28-meta-pilot.jsonl) — PR 2 and the isolated test-WABA proof.
5. [WhatsApp UX](sessions/2026-08-29-whatsapp-ux.jsonl) — PR 3.
6. [Verification-skill builder](sessions/2026-08-29-verification-skill-builder.jsonl) — PR 4 and the first 200-journey campaign.
7. [Independent audit](sessions/2026-08-29-independent-audit.jsonl) — a clean-context rerun and review.

Each JSONL file is UTF-8 and chronological. Records preserve human prompts, visible assistant text, tool names, sanitized arguments and results, timestamps, public links, and public commits. Omitted material appears as a typed record with a SHA-256 digest, byte count, and hash basis.

## Results

- [Historical local checks for PRs 1–4](results/historical-local-checks.json)
- [Real LLM and quote-service conversation](results/real-quote-conversation.json)
- [Seeded reliability campaign: 100 conversations](results/reliability-100.json)
- [Meta provisioning and live test-WABA proof](results/meta-live-proof.json)
- [Verification builder: 200 journeys](results/verification-builder-200.json)
- [Independent 200-journey audit](results/independent-audit-200.md)
- [Fresh final check and 200-journey rerun](results/fresh-validation.json)

The committed source artifacts remain at [`examples/conversation-real.md`](../examples/conversation-real.md), [`examples/evaluation/reliability-100.md`](../examples/evaluation/reliability-100.md), [`docs/meta-provisioning-evidence.json`](../docs/meta-provisioning-evidence.json), and [`.cursor/skills/verify-autoseguro/`](../.cursor/skills/verify-autoseguro/).

## Redaction policy

The exporter builds an in-memory exact denyset from secret-bearing fields in `$HOME/.pi/agent/.env`, `$HOME/.pi/agent/auth.json`, and its process environment. It never prints those values. It then removes credentials, authorization material, cookies, JWTs, private keys, authentication URLs, personal contact data, CPF-like values, Meta identifiers, local user and terminal identifiers, private hosts, absolute local paths, UUIDs, and unknown high-entropy blobs. Useful local paths become `$HOME`, `$PROJECT`, or `$WORKTREE`. Public GitHub URLs and commits remain.

Hidden reasoning, internal instructions, watcher traffic, unrelated project discussion, binary content, duplicate transport records, candidate-dossier excerpts, and oversized tool payloads are not published. Their omission markers preserve hashes and byte counts. The candidate dossier itself is not an export source.

When a match is uncertain, the exporter redacts it. The manifest reports redaction counts by category for each source.

## Known omissions and limits

- The Cursor artifact was already a 1,093-byte summary. Its raw transcript was not copied or reconstructed.
- The main session is fixed at byte cutoff `4633189`. Records before the first KHAL request are represented by one omission marker. Later appends cannot enter this export.
- Per-journey reliability and verifier traces are summarized to keep the package proportionate. Their aggregate counts and source hashes remain.
- Historical command output is reported only where the source sessions contain it. Missing historical stdout is marked as unavailable rather than recreated.
- Private Meta identifiers, hosts, phones, message hashes, and credentials are absent even when they appeared in an otherwise useful proof.

## Regeneration

The exporter reads exactly six session paths from ignored `.runtime/ai-logs-build/source-map.json`, keyed as `main-orchestration`, `core-implementation`, `meta-pilot`, `whatsapp-ux`, `verification-skill-builder`, and `independent-audit`. An authorized source holder creates that private JSON map from the inventory above. The exporter rejects extra keys, wrong timestamp prefixes, wrong hashes, duplicates, and paths outside `$HOME/.pi/agent/sessions/`. It does not search the home directory or stage a raw log in the repository.

```bash
mkdir -p .runtime/ai-logs-build
started=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
set +e
npm run check >.runtime/ai-logs-build/fresh-npm-check.log 2>&1
code=$?
set -e
finished=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
python - "$started" "$finished" "$code" <<'PY'
import json, pathlib, sys
pathlib.Path('.runtime/ai-logs-build/fresh-npm-check.json').write_text(json.dumps({'command':'npm run check','started_at':sys.argv[1],'finished_at':sys.argv[2],'exit_code':int(sys.argv[3])}, indent=2) + '\n')
PY
rm -rf .artifacts/verify-autoseguro/ai-logs-fresh-final
node .cursor/skills/verify-autoseguro/verify.mjs --run-id ai-logs-fresh-final
python scripts/export-ai-logs.py --main-cutoff 4633189 --source-map .runtime/ai-logs-build/source-map.json
```

The command fails on a changed allowlisted session, an ambiguous worker-role mapping, invalid JSONL, a missing fresh proof, a surviving scratch directory, an exact source secret, a forbidden pattern, or an undocumented high-entropy token. Private build metadata is written only to ignored `.runtime/ai-logs-build/export.json`.
