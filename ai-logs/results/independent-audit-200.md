# Independent Audit: AutoSeguro E2E Verification Skill

## Public export provenance

- Started: `2026-08-29T14:17:20.661Z`
- Finished: `2026-08-29T14:18:43.151Z`
- Exit result: `PASS`
- Session: [`2026-08-29-independent-audit.jsonl`](../sessions/2026-08-29-independent-audit.jsonl)
- Public implementation: https://github.com/shishiv/autoseguro/commit/2a3e288eaf9218c8ac05b8c36270b97d1e18f0c1

**Verdict: PASS**

## Identity

| Field | Value |
|---|---|
| Command | `node .cursor/skills/verify-autoseguro/verify.mjs --run-id audit-full-001` |
| Merged commit | `2a3e288eaf9218c8ac05b8c36270b97d1e18f0c1` |
| Run ID | `audit-full-001` |
| Runtime | 82.5 s |
| Evidence path | `.artifacts/verify-autoseguro/audit-full-001/` |
| Source fingerprint | `d10cef5078bd77a7c41168d49c08d7009ece21d40f1aed26f0e6690bdf6f941f` |
| Worktree | `$WORKTREE` |

---

## 1. Doctor — Network Isolation

Doctor run: `--run-id audit-doctor`, passed.

Evidence from `doctor.jsonl`:

- App bound to `127.0.0.1:<random-port>`, confirmed via `ss -ltnp`.
- Process owned by the harness PID, mode `verify.mjs __server`.
- Boundary origins: LLM, quote, and Meta Graph all resolve to `http://127.0.0.1:<peer-port>`.
- `VERIFY_LOCAL_ONLY=1`, `PUBLIC_BASE_URL=https://verify.invalid`.
- Peer self-identifies as `{"service":"verify-autoseguro-local-peer","network":"loopback-only"}`.
- Network fence (`installNetworkFence`) intercepts `globalThis.fetch` and throws on any non-loopback hostname.
- `http.Server.prototype.listen` is patched to force `127.0.0.1`.
- No environment variable for Docker, Tailscale, Dokploy, or live Meta/WhatsApp credentials is set.
- State directory is isolated scratch under `.artifacts/`, writable, successfully probed and removed.

**Conclusion:** the harness cannot reach real Meta, WhatsApp, LLM, quote, Docker, Tailscale, Dokploy, or public network targets.

---

## 2. Full Campaign — 200 Complete Journeys

The harness executed exactly **200 complete journeys** (not 200 assertions or 200 requests). Each journey:
- Starts with a correctly signed Meta-shaped inbound webhook (`valid-hmac-sha256`).
- Drives messages through the real `/webhook` route.
- Follows outbound action IDs from Meta Graph payloads.
- Reaches a committed terminal state (`resolved`, `handoff`, or `closed`).

---

## 3. Independently Recomputed Counts

Recomputed from `journeys.jsonl` (200 lines), not from `summary.json`:

| Metric | Count |
|---|---|
| Total rows | 200 |
| Unique journey IDs | 200 |
| Families | 10 |

### Family Counts (all exactly 20)

| Family | Journeys |
|---|---|
| progressive-happy-success | 20 |
| complete-input-success | 20 |
| timeout-recovery | 20 |
| 5xx-recovery | 20 |
| exhausted-infrastructure-handoff | 20 |
| eligibility-refusal | 20 |
| correction-reselection-date-handling | 20 |
| duplicate-resume-late-result-races | 20 |
| human-media-ambiguity-handoff | 20 |
| close-csat-channel-fallback-parity | 20 |

### Duplicate/Diversity Findings

All 200 input signatures (plan × age × vehicle_age × cep_risk × policy_start_form × interaction_format × variant) are **unique**. No duplicate inputs disguised as diversity.

---

## 4. Required Coverage Buckets

All non-zero and verified independently:

| Dimension | Values |
|---|---|
| Plans | essencial: 60, completo: 61, premium: 59, not-applicable: 20 |
| Age bands | 18-24: 45, 25-29: 40, 30-59: 45, 60-75: 40, 76-200: 10 |
| Vehicle age bands | 0-5: 56, 6-10: 58, 11-20: 56, 21+: 10 |
| CEP risk | normal: 135, high: 45 |
| Policy start forms | iso: 36, pt-BR: 36, today: 36, tomorrow: 36, date-other: 36 |
| Pro-rata | true: 108, false: 27, not-applicable: 65 |
| Waiting period | 30: 135, not-applicable: 65 |
| Interaction formats | meta-rich: 200, meta-button-fallback: 8, meta-list-fallback: 5, cli-replay: 5 |
| Action IDs | All 14 exercised (quote_start, plans_view, human_help, quote_new, service_end, csat_great, csat_regular, csat_bad, plan_essencial, plan_completo, plan_premium, date_today, date_tomorrow, date_other) |
| CSAT | great: 7, regular: 7, bad: 6 |
| Retry outcomes | first-attempt-success: 95, timeout-recovered: 20, 500-recovered: 5, 502-recovered: 5, 503-recovered: 5, 500-502-recovered: 5 |
| Handoff reasons | quote_service_unavailable: 13, quote_timeout: 3, quote_network_error: 1, invalid_quote_response: 1, invalid_quote_payload: 1, quote_http_401: 1, quote_refused: 20, human_requested: 9, unprocessed_media: 4, unsupported_request: 4, repeated_ambiguity: 4, llm_unavailable: 4 |

---

## 5. Sampled-Journey Verdicts (20 journeys, 2 per family)

All 20 sampled journeys independently verified:

| Journey | Terminal | Plan | Retry | Msgs | Outbound | Assertions |
|---|---|---|---|---|---|---|
| 5xx-recovery-01 | resolved | essencial | 500-recovered | 1 | 4 | 25 |
| 5xx-recovery-20 | resolved | completo | 500-502-recovered | 1 | 4 | 25 |
| close-csat-…-01 | closed | essencial | first-attempt | 11 | 24 | 75 |
| close-csat-…-20 | closed | completo | first-attempt | 10 | 22 | 85 |
| complete-input-01 | resolved | completo | first-attempt | 2 | 6 | 31 |
| complete-input-20 | resolved | premium | first-attempt | 2 | 6 | 28 |
| correction-…-01 | resolved | essencial | first-attempt | 9 | 20 | 69 |
| correction-…-20 | resolved | completo | first-attempt | 2 | 6 | 22 |
| duplicate-…-01 | resolved | completo | first-attempt | 2 | 4 | 16 |
| duplicate-…-20 | handoff | premium | human_requested | 2 | 4 | 18 |
| eligibility-01 | handoff | premium | eligibility-refused | 1 | 4 | 16 |
| eligibility-20 | handoff | essencial | eligibility-refused | 1 | 4 | 16 |
| exhausted-…-01 | handoff | completo | unavailable | 1 | 4 | 18 |
| exhausted-…-20 | handoff | premium | unavailable | 1 | 4 | 18 |
| human-media-01 | handoff | — | — | 2 | 4 | 17 |
| human-media-20 | handoff | — | — | 1 | 2 | 14 |
| progressive-01 | resolved | essencial | first-attempt | 8 | 18 | 61 |
| progressive-20 | resolved | completo | first-attempt | 9 | 20 | 65 |
| timeout-01 | resolved | premium | timeout-recovered | 1 | 4 | 25 |
| timeout-20 | resolved | essencial | timeout-recovered | 1 | 4 | 26 |

Each sampled journey's outbound text, terminal state, audit events, quote attempts, and persistence checks are consistent with the source contract from the challenge repository (`plans.json`, `quote_logic.py`).

Key assertions verified across sample:
- Policy start stored as ISO, shown to customer in pt-BR.
- 30-day waiting period (roubo/furto) described relative to policy start.
- Pro-rata first payment matches official calculation.
- No invented price in pending or handoff messages.
- Plan education shows correct coverages and excludes others.
- Customer copy contains no infrastructure jargon or full UUIDs.

---

## 6. Counterfactual Probes (Outside the 200 Manifest)

| Feature probe | Run ID | Result |
|---|---|---|
| greeting-plan-selection (oi → handoff → accentless NOVA COTACAO) | audit-cf-greeting | PASS |
| progressive-quote-success (happy path) | audit-cf-progressive | PASS |
| failure-handoff (exhausted infrastructure) | audit-cf-failure | PASS |
| pending-async-delivery (complete input) | audit-cf-pending | PASS |
| ending-csat (close + CSAT) | audit-cf-csat | PASS |

These cover the real transcript regressions named in the task:
- Plain `oi` with LLM failure → tested via `human-media-ambiguity-handoff` family (variant `llm-unavailable`): 4 journeys pass.
- Persisted handoff plus accentless `NOVA COTACAO` → `correction-reselection-date-handling-01` (variant `real-transcript-regression`): passes.
- Bare `30` and `2020` → `correction-reselection-date-handling` past-date-correction variants: passes (past date rejected, valid date accepted).
- pt-BR date → exercised in 36 journeys with `policy_start_form: "pt-BR"`.
- All three plan education paths → `reselect-all-plans` variant visits all three plans in sequence (7 journeys).
- Waiting-period copy → asserted in every resolved journey: "roubo e furto passam a valer após 30 dias".
- Rich-payload rejection → `meta-list-fallback` and `meta-button-fallback` tested (13 journeys).
- UUID/technical-copy leakage → copy-policy scan: 0 issues found.

---

## 7. Channel Parity

The `close-csat-channel-fallback-parity` family exercises four interaction formats:
- `meta-rich` (interactive buttons/lists)
- `meta-list-fallback` (numbered text after rich list delivery failure)
- `meta-button-fallback` (numbered text after rich button delivery failure)
- `cli-replay` (terminal replay with numbered choices)

All four formats present across all three plans. CLI and Meta reach the same `resolved` state, persist the same field values, and emit the same audit events (`quote_started`, `quote_completed`, `outbox_delivered`, `csat`).

---

## 8. Copy-Policy Scan

Scanned all 200 journeys' customer-visible outbound text:
- **Forbidden copy matches:** 0
- **Full UUID matches:** 0
- **Token/secret leaks:** 0

---

## 9. PII/Secret Scan

| File | Lines | Phone redacted | Tokens redacted |
|---|---|---|---|
| journeys.jsonl | 200 | ✓ all | ✓ all |
| requests.jsonl | 2903 | ✓ all | ✓ all |
| responses.jsonl | 2903 | ✓ all | ✓ all |

No raw phone numbers, access tokens, or app secrets appear in evidence artifacts.

---

## 10. Cleanup Verification

- `.artifacts/verify-autoseguro/audit-full-001/.scratch` — **does not exist** (removed by `cleanupRun`).
- `.artifacts/verify-autoseguro/audit-full-001/index.md` — **exists** (evidence preserved).
- No stranded `verify.mjs __server` processes after cleanup (confirmed via `ps` and `pgrep`; one transient PID from counterfactual probes was already exited by the time of inspection).
- Cleanup sends signals only to recorded child PIDs; uses no `pkill` or shared port.

---

## 11. Oracle Verification Against Challenge Source

The harness's `officialQuote` function faithfully reproduces the challenge's official quote-service logic:

| Rule | Challenge (`plans.json` / `quote_logic.py`) | Harness (`verify.mjs`) | Match |
|---|---|---|---|
| Essencial base | 119.90 | 119.9 | ✓ |
| Completo base | 209.90 | 209.9 | ✓ |
| Premium base | 339.90 | 339.9 | ✓ |
| Age 18-24 mult | 1.60 | 1.6 | ✓ |
| Age 25-29 mult | 1.25 | 1.25 | ✓ |
| Age 30-59 mult | 1.00 | 1 | ✓ |
| Age 60-75 mult | 1.40 | 1.4 | ✓ |
| Age >75 | refuse | refuse | ✓ |
| Vehicle 0-5 mult | 1.00 | 1 | ✓ |
| Vehicle 6-10 mult | 1.15 | 1.15 | ✓ |
| Vehicle 11-20 mult | 1.45 | 1.45 | ✓ |
| Vehicle >20 | refuse | refuse | ✓ |
| High-risk prefixes | 07,08,21,26,59 | 07,08,21,26,59 | ✓ |
| Risk multiplier | 1.30 | 1.3 | ✓ |
| Carência | roubo,furto 30 days | roubo,furto 30 days | ✓ |
| Pro-rata | day≠1 → proportional | day≠1 → proportional | ✓ |

---

## Harness Defects

None found.

## Product Defects

None found during this audit. All 200 journeys and 5 counterfactual probes pass contract assertions.

## Coverage Gaps

1. **17-year-old driver**: The manifest tests age bands starting at 18. The challenge doesn't define behavior for <18, and the quote-service's lowest band starts at 18, so this is acceptable but untested.
2. **Concurrent multi-user load**: The harness runs journeys serially. No concurrency or race-condition testing under multi-tenant pressure.
3. **Truly long quote delays (8s challenge default)**: The harness uses 120ms–500ms synthetic delays. The 8-second default from the challenge's instability simulation is not exercised, though the timeout-recovery logic is proven with shorter values.

## Environmental Limitations

- This audit ran on a single machine in a disposable worktree.
- The harness does not exercise the real OpenAI API, real Meta Cloud API, or real quote-service network path. By design, it cannot.
- Production behaviors dependent on real LLM nondeterminism are exercised only through the deterministic `inferUnderstanding` stub.

## Unresolved Uncertainty

None. All required evidence is present and independently verifiable.

---

## Recommendations

No action required. The verification skill is sound: it proves the product's conversational contract against the official quote-service rules, exercises all required failure/recovery/handoff/parity paths, maintains strict loopback isolation, sanitizes evidence, and cleans up after itself.

---

*Audit completed 2026-08-29. No project files modified. No PR created.*
