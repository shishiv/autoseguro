import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { AutoSeguroAgent } from "./agent.ts";
import { OpenAICompatibleLlm } from "./llm.ts";
import { AuditLog, FileConversationStore } from "./persistence.ts";
import { redactSensitiveText } from "./privacy.ts";
import { QuoteClient } from "./quote-client.ts";
import { missingFields, mergeFields, validateCandidates } from "./validation.ts";
import type {
  CandidateFields,
  LanguageModel,
  LanguageUnderstanding,
  OutboxMessage,
  QuoteAttempt,
  QuoteJob,
  QuotePayload,
  ReplyInput,
  RequiredFieldName,
  UnderstandingInput,
} from "./types.ts";

interface ReliabilityRow {
  conversation_id: string;
  acknowledgement_ms: number;
  status_reply_ms: number;
  terminal_ms: number;
  status_reply_while_pending: boolean;
  duplicate_active_quote_operations: number;
  price_before_confirmation: boolean;
  terminal_outcome: string;
  quote_request_id: string | null;
  quote_status: string;
  handoff_context_complete: boolean;
  handoff_reason: string | null;
  collected_field_count: number;
  outbox_delivered: boolean;
  attempts: QuoteAttempt[];
  transitions: string[];
  transcript: Array<{ sender: "lead" | "agent" | "agent_async"; text: string }>;
}

interface RepresentativeRows {
  slow_then_success: ReliabilityRow | null;
  five_xx_then_success: ReliabilityRow | null;
  exhausted_handoff: ReliabilityRow | null;
}

interface LanguageCase {
  id: string;
  text: string;
  expected: Record<RequiredFieldName, string | number>;
}

interface LanguageRow {
  id: string;
  outcome: "passed" | "llm_error" | "extraction_error";
  mismatched_fields: string[];
  error: string | null;
}

interface EvaluationOptions {
  conversations: number;
  concurrency: number;
  languageConversations: number;
  languageConcurrency: number;
  output: string;
  quoteApiUrl: string;
}

class DeterministicEvaluationLlm implements LanguageModel {
  async understand(input: UnderstandingInput): Promise<LanguageUnderstanding> {
    if (/conseguiu|andamento|demora/iu.test(input.text)) {
      return { fields: {}, intent: "status", ambiguous: false };
    }
    const plan = input.text.match(/\b(essencial|completo|premium)\b/iu)?.[1];
    const age = input.text.match(/\b(\d{1,3})\s*anos\b/iu)?.[1];
    const year = input.text.match(/ve[ií]culo\s+(?:é|e|de|ano)?\s*(\d{4})/iu)?.[1];
    const cep = input.text.match(/CEP\s*(\d{5}-?\d{3})/iu)?.[1];
    const date = input.text.match(/(\d{2})\/(\d{2})\/(\d{4})/u);
    const fields: CandidateFields = {};
    if (plan) {
      fields.plano = plan;
    }
    if (age) {
      fields.idade = Number(age);
    }
    if (year) {
      fields.veiculo_ano = Number(year);
    }
    if (cep) {
      fields.cep = cep;
    }
    if (date) {
      fields.data_inicio = `${date[3]}-${date[2]}-${date[1]}`;
    }
    return { fields, intent: "continue", ambiguous: false };
  }

  async phrase(input: ReplyInput): Promise<string> {
    return input.draft;
  }
}

const languageCases: LanguageCase[] = [
  { id: "lang-01", text: "Quero o Completo. Tenho 35 anos, veículo 2022, CEP 01310-100, início 15/09/2026.", expected: { plano: "completo", idade: 35, veiculo_ano: 2022, cep: "01310-100", data_inicio: "2026-09-15" } },
  { id: "lang-02", text: "Pode ser o essencial; idade 28, meu carro é 2021, cep 30140110 e começo em 01/10/2026.", expected: { plano: "essencial", idade: 28, veiculo_ano: 2021, cep: "30140-110", data_inicio: "2026-10-01" } },
  { id: "lang-03", text: "Premium pra mim. Tenho 64 anos, veículo de 2019, CEP 59000-100, vigência 20/09/2026.", expected: { plano: "premium", idade: 64, veiculo_ano: 2019, cep: "59000-100", data_inicio: "2026-09-20" } },
  { id: "lang-04", text: "Plano completo, 41 anos, veículo 2018, CEP 22041-001, data 05/10/2026.", expected: { plano: "completo", idade: 41, veiculo_ano: 2018, cep: "22041-001", data_inicio: "2026-10-05" } },
  { id: "lang-05", text: "Tenho 22 anos e escolho o Essencial. Veículo ano 2024, CEP 80010-000, início 12/09/2026.", expected: { plano: "essencial", idade: 22, veiculo_ano: 2024, cep: "80010-000", data_inicio: "2026-09-12" } },
  { id: "lang-06", text: "O premium. Idade: 30 anos. Veículo 2020. CEP 04038-001. Começa 30/09/2026.", expected: { plano: "premium", idade: 30, veiculo_ano: 2020, cep: "04038-001", data_inicio: "2026-09-30" } },
  { id: "lang-07", text: "Fecho no Completo, tenho 59 anos, veículo de 2016, CEP 21040-360, início em 02/11/2026.", expected: { plano: "completo", idade: 59, veiculo_ano: 2016, cep: "21040-360", data_inicio: "2026-11-02" } },
  { id: "lang-08", text: "Essencial. Sou de 45 anos, veículo 2023, CEP 88010-400, quero iniciar 18/09/2026.", expected: { plano: "essencial", idade: 45, veiculo_ano: 2023, cep: "88010-400", data_inicio: "2026-09-18" } },
  { id: "lang-09", text: "Quero Premium; tenho 27 anos; veículo ano 2022; CEP 07000-000; início 07/10/2026.", expected: { plano: "premium", idade: 27, veiculo_ano: 2022, cep: "07000-000", data_inicio: "2026-10-07" } },
  { id: "lang-10", text: "Vai de completo. 38 anos, veículo de 2017, CEP 13010-111, vigência em 11/11/2026.", expected: { plano: "completo", idade: 38, veiculo_ano: 2017, cep: "13010-111", data_inicio: "2026-11-11" } },
  { id: "lang-11", text: "Plano Essencial para condutor de 33 anos, veículo 2025, CEP 01001000, início 03/12/2026.", expected: { plano: "essencial", idade: 33, veiculo_ano: 2025, cep: "01001-000", data_inicio: "2026-12-03" } },
  { id: "lang-12", text: "Prefiro premium. Tenho 52 anos. Veículo de 2015. CEP 26010-000. Início 22/09/2026.", expected: { plano: "premium", idade: 52, veiculo_ano: 2015, cep: "26010-000", data_inicio: "2026-09-22" } },
  { id: "lang-13", text: "Completo, por favor. Idade 60 anos, veículo 2021, CEP 40020-000, dia 14/10/2026.", expected: { plano: "completo", idade: 60, veiculo_ano: 2021, cep: "40020-000", data_inicio: "2026-10-14" } },
  { id: "lang-14", text: "Quero o essencial: 25 anos, veículo de 2019, CEP 70040-010, começar 09/09/2026.", expected: { plano: "essencial", idade: 25, veiculo_ano: 2019, cep: "70040-010", data_inicio: "2026-09-09" } },
  { id: "lang-15", text: "Premium. Tenho 47 anos e um veículo 2024. CEP 50030-230. Vigência 16/10/2026.", expected: { plano: "premium", idade: 47, veiculo_ano: 2024, cep: "50030-230", data_inicio: "2026-10-16" } },
  { id: "lang-16", text: "Escolho Completo, tenho 31 anos, veículo ano 2020, CEP 60060-000, início 28/09/2026.", expected: { plano: "completo", idade: 31, veiculo_ano: 2020, cep: "60060-000", data_inicio: "2026-09-28" } },
  { id: "lang-17", text: "Essencial pra um veículo de 2023. Tenho 54 anos, CEP 90010-150, começo 04/10/2026.", expected: { plano: "essencial", idade: 54, veiculo_ano: 2023, cep: "90010-150", data_inicio: "2026-10-04" } },
  { id: "lang-18", text: "Plano premium, idade 36 anos, veículo 2014, CEP 08010-090, início em 19/09/2026.", expected: { plano: "premium", idade: 36, veiculo_ano: 2014, cep: "08010-090", data_inicio: "2026-09-19" } },
  { id: "lang-19", text: "Completo. Tenho 43 anos, veículo de 2022, CEP 11010-020 e data 06/11/2026.", expected: { plano: "completo", idade: 43, veiculo_ano: 2022, cep: "11010-020", data_inicio: "2026-11-06" } },
  { id: "lang-20", text: "Pode cotar o essencial? 57 anos, veículo 2018, CEP 29010-120, vigência 25/09/2026.", expected: { plano: "essencial", idade: 57, veiculo_ano: 2018, cep: "29010-120", data_inicio: "2026-09-25" } },
];

function parsePositiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Valor inválido: ${value ?? "ausente"}`);
  }
  return parsed;
}

function optionsFromArgs(): EvaluationOptions {
  const { values } = parseArgs({
    options: {
      conversations: { type: "string", default: "100" },
      concurrency: { type: "string", default: "10" },
      "language-conversations": { type: "string", default: "20" },
      "language-concurrency": { type: "string", default: "2" },
      output: { type: "string", default: ".runtime/evaluation-result.json" },
    },
  });
  return {
    conversations: parsePositiveInteger(values.conversations, 100, 1_000),
    concurrency: parsePositiveInteger(values.concurrency, 10, 50),
    languageConversations: parsePositiveInteger(values["language-conversations"], 20, languageCases.length),
    languageConcurrency: parsePositiveInteger(values["language-concurrency"], 2, 10),
    output: values.output,
    quoteApiUrl: process.env.QUOTE_API_URL ?? "http://127.0.0.1:8000",
  };
}

async function mapLimit<T>(count: number, concurrency: number, worker: (index: number) => Promise<T>): Promise<T[]> {
  const results = Array.from({ length: count }) as T[];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      results[index] = await worker(index);
    }
  }));
  return results;
}

function reliabilityInput(index: number): { text: string; payload: QuotePayload } {
  const plans = ["essencial", "completo", "premium"];
  const plan = plans[index % plans.length] ?? "completo";
  const age = 30 + (index % 30);
  const year = 2016 + (index % 9);
  const cep = index % 4 === 0 ? "07123-456" : "01310-100";
  const day = String(1 + (index % 28)).padStart(2, "0");
  return {
    text: `Plano ${plan}, tenho ${age} anos, veículo ${year}, CEP ${cep}, início ${day}/09/2026.`,
    payload: {
      plano_id: plan,
      idade: age,
      veiculo_ano: year,
      cep,
      data_inicio: `2026-09-${day}`,
    },
  };
}

function transitionCount(statuses: string[]): number {
  let invalid = statuses[0] === "pending" ? 0 : 1;
  for (let index = 1; index < statuses.length; index += 1) {
    const previous = statuses[index - 1];
    const current = statuses[index];
    if (!previous || !current || !["pending", "retrying"].includes(previous) || !["retrying", "delivered", "failed"].includes(current)) {
      invalid += 1;
    }
  }
  return invalid;
}

function hasHandoffContext(job: QuoteJob | undefined, stateReason: string | null, terminal: OutboxMessage | undefined): boolean {
  return Boolean(
    job
    && stateReason
    && terminal?.outcome === "handoff"
    && terminal.quote_request_id === job.request_id
    && Object.keys(job.fields).length === 5
    && job.attempts.length > 0,
  );
}

function jobRowFields(
  job: QuoteJob | undefined,
  stateReason: string | null,
  terminal: OutboxMessage | undefined,
): Pick<ReliabilityRow, "terminal_outcome" | "quote_request_id" | "quote_status" | "handoff_context_complete" | "attempts" | "transitions"> {
  if (!job) {
    return {
      terminal_outcome: terminal?.outcome ?? "missing",
      quote_request_id: null,
      quote_status: "missing",
      handoff_context_complete: false,
      attempts: [],
      transitions: [],
    };
  }
  return {
    terminal_outcome: terminal?.outcome ?? "missing",
    quote_request_id: job.request_id,
    quote_status: job.status,
    handoff_context_complete: job.status === "failed"
      ? hasHandoffContext(job, stateReason, terminal)
      : true,
    attempts: job.attempts,
    transitions: job.transitions.map((item) => item.status),
  };
}

async function runReliabilityConversation(
  index: number,
  agent: AutoSeguroAgent,
  store: FileConversationStore,
): Promise<ReliabilityRow> {
  const conversationId = `reliability-${String(index + 1).padStart(3, "0")}`;
  const input = reliabilityInput(index);
  const initial = {
    conversation_id: conversationId,
    message_id: `${conversationId}-input`,
    message_type: "text" as const,
    text: input.text,
  };
  const started = performance.now();
  const acknowledgementPromise = agent.handle(initial).then((reply) => ({
    reply,
    milliseconds: performance.now() - started,
  }));
  const duplicatePromise = agent.handle(initial);
  const statusStarted = performance.now();
  const statusPromise = agent.handle({
    conversation_id: conversationId,
    message_id: `${conversationId}-status`,
    message_type: "text" as const,
    text: "Já conseguiu?",
  }).then((reply) => ({ reply, milliseconds: performance.now() - statusStarted }));
  const [acknowledgement, duplicate, status] = await Promise.all([
    acknowledgementPromise,
    duplicatePromise,
    statusPromise,
  ]);
  await agent.waitForIdle(conversationId);
  const terminalMessages: OutboxMessage[] = [];
  await agent.deliverOutbox(conversationId, (item) => {
    terminalMessages.push(item);
  });
  const state = await store.load(conversationId);
  const job = state.quote_jobs.at(-1);
  const terminal = terminalMessages.at(-1);
  const earlyText = `${acknowledgement.reply.text} ${duplicate.text} ${status.reply.text}`;
  return {
    conversation_id: conversationId,
    acknowledgement_ms: Math.round(acknowledgement.milliseconds),
    status_reply_ms: Math.round(status.milliseconds),
    terminal_ms: Math.round(performance.now() - started),
    status_reply_while_pending: status.reply.outcome === "awaiting_data" && /processamento/u.test(status.reply.text),
    duplicate_active_quote_operations: Math.max(0, state.quote_jobs.length - 1),
    price_before_confirmation: /R\$/u.test(earlyText),
    handoff_reason: state.handoff_reason,
    collected_field_count: Object.keys(state.fields).length,
    outbox_delivered: state.outbox.length > 0 && state.outbox.every((item) => item.delivered_at !== null),
    ...jobRowFields(job, state.handoff_reason, terminal),
    transcript: [
      { sender: "lead", text: input.text.replace(/\b(\d{2})\d{3}-\d{3}\b/gu, "$1***-***") },
      { sender: "agent", text: acknowledgement.reply.text },
      { sender: "lead", text: "Já conseguiu?" },
      { sender: "agent", text: status.reply.text },
      { sender: "agent_async", text: terminal?.text ?? "Resposta terminal ausente" },
    ],
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function callCounts(rows: ReliabilityRow[]): Record<string, number> {
  const counts: Record<string, number> = {
    "2xx": 0,
    "500": 0,
    "502": 0,
    "503": 0,
    timeout: 0,
    network: 0,
    cancelled: 0,
    other: 0,
  };
  for (const attempt of rows.flatMap((row) => row.attempts)) {
    const key = attempt.failure_kind ?? (attempt.http_status && attempt.http_status >= 200 && attempt.http_status < 300
      ? "2xx"
      : String(attempt.http_status ?? "other"));
    const bucket = key in counts ? key : "other";
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function reliabilitySummary(rows: ReliabilityRow[]): Record<string, unknown> {
  const successful = rows.filter((row) => row.quote_status === "delivered");
  const failed = rows.filter((row) => row.quote_status === "failed");
  return {
    total_conversations: rows.length,
    total_post_attempts: rows.flatMap((row) => row.attempts).length,
    per_call: callCounts(rows),
    first_attempt_success: successful.filter((row) => row.attempts.length === 1).length,
    recovered_on_attempt_2: successful.filter((row) => row.attempts.length === 2).length,
    recovered_on_attempt_3: successful.filter((row) => row.attempts.length === 3).length,
    exhausted_handoff: failed.length,
    acknowledgement_ms: {
      p50: percentile(rows.map((row) => row.acknowledgement_ms), 0.5),
      p95: percentile(rows.map((row) => row.acknowledgement_ms), 0.95),
      max: Math.max(...rows.map((row) => row.acknowledgement_ms)),
    },
    terminal_ms: {
      p50: percentile(rows.map((row) => row.terminal_ms), 0.5),
      p95: percentile(rows.map((row) => row.terminal_ms), 0.95),
      max: Math.max(...rows.map((row) => row.terminal_ms)),
    },
    status_replies_while_pending: rows.filter((row) => row.status_reply_while_pending).length,
    duplicate_active_quote_operations: rows.reduce((sum, row) => sum + row.duplicate_active_quote_operations, 0),
    price_shown_before_confirmed_api_response: rows.filter((row) => row.price_before_confirmation).length,
    terminal_failures_without_context_rich_handoff: failed.filter((row) => !row.handoff_context_complete).length,
    undelivered_terminal_replies: rows.filter((row) => !row.outbox_delivered).length,
    invalid_state_transitions: rows.reduce(
      (sum, row) => sum + transitionCount(row.transitions),
      0,
    ),
  };
}

async function checkQuoteApi(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/health`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`Quote API indisponível: HTTP ${response.status}`);
  }
}

async function runReliability(options: EvaluationOptions, workDirectory: string): Promise<ReliabilityRow[]> {
  await checkQuoteApi(options.quoteApiUrl);
  const store = new FileConversationStore(`${workDirectory}/state`);
  const agent = new AutoSeguroAgent(
    store,
    new AuditLog(`${workDirectory}/audit.jsonl`),
    new DeterministicEvaluationLlm(),
    new QuoteClient({ baseUrl: options.quoteApiUrl, random: () => 0 }),
    { fieldSource: "deterministic" },
  );
  return mapLimit(options.conversations, options.concurrency, (index) =>
    runReliabilityConversation(index, agent, store));
}

function mismatches(expected: LanguageCase["expected"], actual: CandidateFields): string[] {
  const validated = validateCandidates(actual);
  const fields = mergeFields({}, validated.values, "evaluation", "llm");
  const missing = missingFields(fields);
  const different = Object.entries(expected)
    .filter(([name, value]) => fields[name as RequiredFieldName]?.value !== value)
    .map(([name]) => name);
  return [...new Set([...validated.errors, ...missing, ...different])];
}

async function evaluateLanguageCase(llm: LanguageModel, item: LanguageCase): Promise<LanguageRow> {
  try {
    const result = await llm.understand({
      text: item.text,
      missing_fields: ["plano", "idade", "veiculo_ano", "cep", "data_inicio"],
      current_date: "2026-08-28",
    });
    const fields = mismatches(item.expected, result.fields);
    return {
      id: item.id,
      outcome: fields.length === 0 ? "passed" : "extraction_error",
      mismatched_fields: fields,
      error: null,
    };
  } catch (error) {
    return {
      id: item.id,
      outcome: "llm_error",
      mismatched_fields: [],
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function runLanguage(options: EvaluationOptions): Promise<LanguageRow[]> {
  const llm = OpenAICompatibleLlm.fromEnv();
  return mapLimit(options.languageConversations, options.languageConcurrency, (index) =>
    evaluateLanguageCase(llm, languageCases[index] as LanguageCase));
}

function theoreticalExpectations(conversations: number): Record<string, number> {
  const calls = conversations * (1 + 0.3 + 0.3 ** 2);
  return {
    post_attempts: Number(calls.toFixed(1)),
    http_5xx: Number((calls * 0.2).toFixed(1)),
    slow_timeouts: Number((calls * 0.1).toFixed(1)),
    resolved_within_three_attempts: Number((conversations * (1 - 0.3 ** 3)).toFixed(1)),
    exhausted_handoffs: Number((conversations * 0.3 ** 3).toFixed(1)),
  };
}

function has5xx(row: ReliabilityRow): boolean {
  return row.attempts.some((attempt) => [500, 502, 503].includes(attempt.http_status ?? 0));
}

function selectRepresentatives(rows: ReliabilityRow[]): RepresentativeRows {
  return {
    slow_then_success: rows.find((row) => row.quote_status === "delivered" && row.attempts.some((attempt) => attempt.failure_kind === "timeout")) ?? null,
    five_xx_then_success: rows.find((row) => row.quote_status === "delivered" && has5xx(row)) ?? null,
    exhausted_handoff: rows.find((row) => row.quote_status === "failed" && row.attempts.length === 3) ?? null,
  };
}

function transcriptBlock(title: string, row: ReliabilityRow | null): string {
  if (!row) {
    return `### ${title}\n\nNão observado nesta execução.`;
  }
  const labels = { lead: "Lead", agent: "AutoSeguro", agent_async: "AutoSeguro [assíncrono]" };
  const attempts = row.attempts.map((attempt) => {
    const result = attempt.failure_kind ?? `HTTP ${attempt.http_status}`;
    return `${attempt.attempt}: ${result} em ${attempt.latency_ms} ms`;
  }).join("; ");
  const transcript = row.transcript.map((line) => `${labels[line.sender]}: ${line.text}`).join("\n");
  return `### ${title}\n\nConversa \`${row.conversation_id}\`. Tentativas: ${attempts}.\n\n\`\`\`text\n${transcript}\n\`\`\``;
}

function markdownReport(result: Record<string, unknown>): string {
  const reliability = result.reliability as Record<string, unknown>;
  const language = result.language as Record<string, unknown>;
  const gates = result.gates as Record<string, boolean>;
  const calls = reliability.per_call as Record<string, number>;
  const theory = result.theoretical_expectation as Record<string, number>;
  const representatives = result.representative_transcripts as unknown as RepresentativeRows;
  const resolved = Number(reliability.first_attempt_success)
    + Number(reliability.recovered_on_attempt_2)
    + Number(reliability.recovered_on_attempt_3);
  return [
    "# Relatório de confiabilidade",
    "",
    `- Execução: ${String(result.generated_at)}`,
    `- API: \`${String(result.quote_api_url)}\``,
    "- Seed: `42`",
    `- Concorrência: \`${String(result.concurrency)}\``,
    "",
    "A API sorteia uma vez por chamada. Um valor abaixo de 0,20 gera 500, 502 ou 503; de 0,20 até abaixo de 0,30 gera uma espera de 8 segundos; os ramos são mutuamente exclusivos. As taxas valem por chamada, não por conversa.",
    "",
    "## Teoria e resultado observado",
    "",
    "| Métrica | Expectativa teórica | Observado |",
    "|---|---:|---:|",
    `| Chamadas POST | ${theory.post_attempts} | ${String(reliability.total_post_attempts)} |`,
    `| Respostas 5xx | ${theory.http_5xx} | ${(calls["500"] ?? 0) + (calls["502"] ?? 0) + (calls["503"] ?? 0)} |`,
    `| Chamadas lentas que viraram timeout | ${theory.slow_timeouts} | ${calls.timeout ?? 0} |`,
    `| Conversas resolvidas em até 3 tentativas | ${theory.resolved_within_three_attempts} | ${resolved} |`,
    `| Handoffs após esgotamento | ${theory.exhausted_handoffs} | ${String(reliability.exhausted_handoff)} |`,
    "",
    `Contagem HTTP observada: \`2xx=${calls["2xx"] ?? 0}\`, \`500=${calls["500"] ?? 0}\`, \`502=${calls["502"] ?? 0}\`, \`503=${calls["503"] ?? 0}\`, \`timeout=${calls.timeout ?? 0}\`, \`other=${calls.other ?? 0}\`.`,
    "",
    "## Conversa durante a cotação",
    "",
    `- sucesso na primeira tentativa: ${String(reliability.first_attempt_success)}`,
    `- recuperação na tentativa 2: ${String(reliability.recovered_on_attempt_2)}`,
    `- recuperação na tentativa 3: ${String(reliability.recovered_on_attempt_3)}`,
    `- respostas de status servidas enquanto pending: ${String(reliability.status_replies_while_pending)}`,
    `- acknowledgement p50/p95/máximo: ${JSON.stringify(reliability.acknowledgement_ms)} ms`,
    `- conclusão p50/p95/máximo: ${JSON.stringify(reliability.terminal_ms)} ms`,
    "",
    "## Passe de linguagem",
    "",
    `- conversas: ${String(language.total)}`,
    `- extrações corretas: ${String(language.passed)}`,
    `- falhas do LLM: ${String(language.llm_failures)}`,
    `- falhas de extração: ${String(language.extraction_failures)}`,
    `- endpoint: \`${String(language.endpoint)}\``,
    `- modelo: \`${String(language.model)}\``,
    "",
    "## Gates",
    "",
    ...Object.entries(gates).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"}: \`${name}\``),
    "",
    "## Conversas representativas",
    "",
    transcriptBlock("Timeout seguido de sucesso", representatives.slow_then_success),
    "",
    transcriptBlock("5xx seguido de recuperação", representatives.five_xx_then_success),
    "",
    transcriptBlock("Tentativas esgotadas e handoff", representatives.exhausted_handoff),
    "",
    "Os cenários forçados de timeout→sucesso, 5xx→sucesso, falha mista, esgotamento, 422, 400, duplicata/status durante pending, correção, handoff antes de resultado tardio e retomada rodam no preflight de `npm run evaluate`.",
    "",
  ].join("\n");
}

function containsPublicPii(value: unknown): boolean {
  const text = JSON.stringify(value);
  return redactSensitiveText(text) !== text || /\b\d{5}-\d{3}\b/u.test(text);
}

async function main(): Promise<void> {
  const options = optionsFromArgs();
  const workDirectory = `.runtime/evaluation-${Date.now()}`;
  await rm(workDirectory, { recursive: true, force: true });
  const rows = await runReliability(options, workDirectory);
  const summary = reliabilitySummary(rows);
  const representativeTranscripts = selectRepresentatives(rows);
  const languageRows = await runLanguage(options);
  const piiLeakCount = containsPublicPii({ rows, languageRows }) ? 1 : 0;
  summary.pii_leaks_in_public_artifacts = piiLeakCount;
  const languageSummary = {
    total: languageRows.length,
    passed: languageRows.filter((row) => row.outcome === "passed").length,
    llm_failures: languageRows.filter((row) => row.outcome === "llm_error").length,
    extraction_failures: languageRows.filter((row) => row.outcome === "extraction_error").length,
    endpoint: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
    conversations: languageRows,
  };
  const gates = {
    every_conversation_terminal: rows.every((row) => ["resolved", "handoff"].includes(row.terminal_outcome)),
    acknowledgement_under_one_second: rows.every((row) => row.acknowledgement_ms < 1_000),
    status_while_pending: rows.every((row) => row.status_reply_while_pending),
    no_duplicate_quote_operations: rows.every((row) => row.duplicate_active_quote_operations === 0),
    no_price_before_confirmation: rows.every((row) => !row.price_before_confirmation),
    every_failed_quote_has_handoff_context: rows.every((row) => row.handoff_context_complete),
    every_terminal_reply_delivered: rows.every((row) => row.outbox_delivered),
    no_invalid_state_transitions: rows.every((row) => row.transitions.length > 0) && Number(summary.invalid_state_transitions) === 0,
    no_pii_in_public_artifacts: piiLeakCount === 0,
    language_sample_complete: languageRows.length === options.languageConversations,
    language_failures_classified: languageRows.every((row) => ["passed", "llm_error", "extraction_error"].includes(row.outcome)),
  };
  const result: Record<string, unknown> = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    quote_api_url: options.quoteApiUrl,
    quote_api_configuration: {
      failure_rate: 0.2,
      slow_rate: 0.1,
      slow_seconds: 8,
      seed: 42,
      rates_apply_per_call: true,
      failure_and_slow_branches_are_mutually_exclusive: true,
    },
    concurrency: options.concurrency,
    language_concurrency: options.languageConcurrency,
    theoretical_expectation: theoreticalExpectations(options.conversations),
    reliability: { ...summary, conversations: rows },
    representative_transcripts: representativeTranscripts,
    language: languageSummary,
    gates,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const reportPath = `${options.output.slice(0, -extname(options.output).length)}.md`;
  await writeFile(reportPath, markdownReport(result), "utf8");
  console.log(JSON.stringify({ output: options.output, report: reportPath, reliability: summary, language: languageSummary, gates }, null, 2));
  if (Object.values(gates).includes(false)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(redactSensitiveText(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
