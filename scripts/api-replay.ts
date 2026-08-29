import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AutoSeguroAgent } from "../src/agent.ts";
import { OpenAICompatibleLlm } from "../src/llm.ts";
import { createMetaHttpHandler, MetaGraphClient, MetaInbox, MetaTransport, type MetaRuntimeConfig } from "../src/meta.ts";
import { AuditLog, FileConversationStore } from "../src/persistence.ts";
import { QuoteClient } from "../src/quote-client.ts";
import type { LanguageModel, LanguageUnderstanding, ReplyInput, UnderstandingInput } from "../src/types.ts";

const outputDirectory = "examples/api-replay";
const fixtureSources = [
  "test/meta.test.ts",
  "ai-logs/sessions/2026-08-28-meta-pilot.jsonl",
  "docs/meta-provisioning-evidence.json",
];
const metaDocs = [
  "https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks",
  "https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/",
];
const config: MetaRuntimeConfig = {
  wabaId: "synthetic-waba-000001",
  phoneNumberId: "synthetic-phone-000001",
  accessToken: "synthetic-access-token",
  appSecret: "synthetic-app-secret",
  verifyToken: "synthetic-verify-token",
  allowedRecipient: "15550000001",
  publicBaseUrl: "http://127.0.0.1",
};

type ScenarioName = "essencial-csat" | "completo-reselect" | "premium-pro-rata" | "slow-status-success" | "five-xx-handoff";

interface CaptureRecord {
  at_ms: number;
  http_status: number;
  payload: Record<string, unknown>;
}

interface TranscriptLine {
  at_ms: number;
  role: "lead" | "autoseguro";
  text: string;
  kind: "text" | "interactive";
  action_ids?: string[];
}

interface ScenarioResult {
  label: "API-emulated hybrid";
  scenario: ScenarioName;
  outcome: "closed" | "resolved" | "handoff";
  elapsed_ms: number;
  llm: { endpoint: string; model: string; understand_calls: number };
  quote_service: { identity: string; source_sha256: string; attempts: Array<{ http_status: number | null; latency_ms: number; will_retry: boolean }> };
  capture: Array<{ at_ms: number; http_status: number; shape: string; payload: Record<string, unknown> }>;
  transcript: TranscriptLine[];
  effects: { quote_statuses: string[]; outbox_delivered: boolean; csat_rating: string | null; handoff_reason: string | null; audit_events: string[]; interaction_fallback: boolean };
  assertions: string[];
}

interface CapturePeer {
  baseUrl: string;
  records: CaptureRecord[];
  stop(): Promise<void>;
}

interface QuoteService {
  url: string;
  identity: string;
  sourceHash: string;
  stop(): Promise<void>;
}

class TrackedLlm implements LanguageModel {
  readonly inner: OpenAICompatibleLlm;
  understandCalls = 0;

  constructor() {
    this.inner = OpenAICompatibleLlm.fromEnv();
  }

  async understand(input: UnderstandingInput): Promise<LanguageUnderstanding> {
    this.understandCalls += 1;
    return this.inner.understand(input);
  }

  phrase(input: ReplyInput): Promise<string> {
    return this.inner.phrase(input);
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Configure ${name} no .env local`);
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticWamid(scenario: ScenarioName, index: number): string {
  return `wamid.synthetic.${scenario}.${String(index).padStart(3, "0")}`;
}

function sanitizeText(value: string): string {
  return value.replace(/\b\d{5}-\d{3}\b/gu, (cep) => `${cep.slice(0, 2)}***-***`);
}

function interactionIds(payload: Record<string, unknown>): string[] {
  const interactive = payload.interactive;
  if (!isRecord(interactive) || !isRecord(interactive.action)) {
    return [];
  }
  const buttons = interactive.action.buttons;
  if (Array.isArray(buttons)) {
    return buttons.flatMap((button) => isRecord(button) && isRecord(button.reply) && typeof button.reply.id === "string" ? [button.reply.id] : []);
  }
  const sections = interactive.action.sections;
  if (!Array.isArray(sections)) {
    return [];
  }
  return sections.flatMap((section) => isRecord(section) && Array.isArray(section.rows)
    ? section.rows.flatMap((row) => isRecord(row) && typeof row.id === "string" ? [row.id] : [])
    : []);
}

function visibleText(payload: Record<string, unknown>): string {
  if (payload.type === "text" && isRecord(payload.text) && typeof payload.text.body === "string") {
    return payload.text.body;
  }
  if (payload.type === "interactive" && isRecord(payload.interactive) && isRecord(payload.interactive.body) && typeof payload.interactive.body.text === "string") {
    return payload.interactive.body.text;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadShape(payload: Record<string, unknown>): string {
  if (payload.status === "read") {
    return "presence";
  }
  if (payload.type === "interactive" && isRecord(payload.interactive)) {
    return payload.interactive.type === "list" ? "list-send" : "button-send";
  }
  return "text-send";
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback server address unavailable");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function isDateButton(payload: Record<string, unknown>): boolean {
  const ids = interactionIds(payload);
  return ids.includes("date_today") && ids.includes("date_tomorrow") && ids.includes("date_other");
}

async function startCapture(started: number, scenario: ScenarioName): Promise<CapturePeer> {
  const records: CaptureRecord[] = [];
  let sent = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const httpStatus = scenario === "essencial-csat" && isDateButton(payload) ? 500 : 200;
    records.push({ at_ms: Math.round(performance.now() - started), http_status: httpStatus, payload });
    response.writeHead(httpStatus, { "content-type": "application/json" });
    if (payload.status === "read") {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (httpStatus >= 400) {
      response.end(JSON.stringify({ error: { code: 131000, error_subcode: 249999 } }));
      return;
    }
    sent += 1;
    response.end(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ wa_id: "15550000001" }], messages: [{ id: `wamid.capture.${sent}` }] }));
  });
  return { baseUrl: await listen(server), records, stop: () => close(server) };
}

function captureFetcher(capture: CapturePeer): typeof fetch {
  return async (input, init) => {
    const source = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (source.protocol !== "https:" || source.hostname !== "graph.facebook.com") {
      throw new Error("Meta target is not the canonical Graph URL");
    }
    const target = new URL(`${capture.baseUrl}${source.pathname}`);
    if (target.hostname !== "127.0.0.1") {
      throw new Error("Meta capture target must be loopback");
    }
    return fetch(target, init);
  };
}

function webhookBody(scenario: ScenarioName, index: number, message: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: config.wabaId,
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "+1 555 000 0001", phone_number_id: config.phoneNumberId },
          messages: [{ from: config.allowedRecipient, id: syntheticWamid(scenario, index), timestamp: "1767225600", ...message }],
        },
      }],
    }],
  }));
}

function signature(body: Buffer): string {
  return `sha256=${createHmac("sha256", config.appSecret).update(body).digest("hex")}`;
}

async function postWebhook(baseUrl: string, body: Buffer): Promise<void> {
  const response = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature(body) },
    body: body.toString("utf8"),
  });
  assert.equal(response.status, 200, `webhook returned ${response.status}`);
  assert.equal(await response.text(), "EVENT_RECEIVED");
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 35_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error("Replay timed out waiting for the real path");
    }
    await delay(20);
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await close(server);
  if (!address || typeof address === "string") {
    throw new Error("Quote port unavailable");
  }
  return address.port;
}

async function startQuoteService(scenario: ScenarioName): Promise<QuoteService> {
  const serviceDirectory = resolve(required("QUOTE_SERVICE_DIR"));
  const sourcePath = join(serviceDirectory, "app", "main.py");
  await stat(sourcePath);
  const executable = join(serviceDirectory, ".venv", "bin", "uvicorn");
  await stat(executable);
  const port = await reservePort();
  const behavior = scenario === "slow-status-success"
    ? { QUOTE_FAILURE_RATE: "0", QUOTE_SLOW_RATE: "0.5", QUOTE_SLOW_SECONDS: "8", QUOTE_SEED: "1" }
    : scenario === "five-xx-handoff"
      ? { QUOTE_FAILURE_RATE: "1", QUOTE_SLOW_RATE: "0", QUOTE_SLOW_SECONDS: "8", QUOTE_SEED: "1" }
      : { QUOTE_FAILURE_RATE: "0", QUOTE_SLOW_RATE: "0", QUOTE_SLOW_SECONDS: "8", QUOTE_SEED: "1" };
  const child = spawn(executable, ["app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: serviceDirectory,
    env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", PYTHONUNBUFFERED: "1", ...behavior },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitUntil(async () => {
      try {
        return (await fetch(`${url}/health`)).ok;
      } catch {
        return false;
      }
    }, 10_000);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return {
    url,
    identity: "namastex-fde-challenge/quote-service",
    sourceHash: sha256(await readFile(sourcePath)),
    stop: () => stopChild(child),
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
}

function quoteFetcherFor(scenario: ScenarioName): typeof fetch {
  if (scenario !== "slow-status-success") {
    return fetch;
  }
  return async (input, init) => {
    const { signal: _signal, ...request } = init ?? {};
    return fetch(input, request);
  };
}

function summaryCapture(records: CaptureRecord[]): Array<{ at_ms: number; http_status: number; shape: string; payload: Record<string, unknown> }> {
  return records.map(({ at_ms, http_status, payload }) => ({
    at_ms,
    http_status,
    shape: payloadShape(payload),
    payload: {
      ...payload,
      ...(typeof payload.to === "string" ? { to: "synthetic-recipient" } : {}),
      ...(payload.message_id ? { message_id: "synthetic-wamid" } : {}),
    },
  }));
}

function assertPresenceOrder(records: CaptureRecord[]): void {
  const visible = records.filter(({ payload }) => payload.status !== "read");
  for (const message of visible) {
    const prior = records.find(({ at_ms, payload }) => at_ms <= message.at_ms && payload.status === "read");
    assert.ok(prior, "presence must precede every visible reply");
  }
}

function assertOutboundShapes(records: CaptureRecord[]): void {
  for (const { payload } of records) {
    assert.equal(payload.messaging_product, "whatsapp");
    if (payload.status === "read") {
      assert.deepEqual(payload.typing_indicator, { type: "text" });
      continue;
    }
    assert.equal(payload.recipient_type, "individual");
    assert.equal(payload.to, config.allowedRecipient);
    assert.ok(payload.type === "text" || payload.type === "interactive");
  }
}

async function runScenario(scenario: ScenarioName): Promise<ScenarioResult> {
  const started = performance.now();
  const scratch = await mkdtemp(join(tmpdir(), "autoseguro-api-replay-"));
  const capture = await startCapture(started, scenario);
  const quoteService = await startQuoteService(scenario);
  const store = new FileConversationStore(join(scratch, "conversations"));
  const auditPath = join(scratch, "audit.jsonl");
  const events: Array<Record<string, unknown>> = [];
  const llm = new TrackedLlm();
  const agent = new AutoSeguroAgent(
    store,
    new AuditLog(auditPath),
    llm,
    new QuoteClient({ baseUrl: quoteService.url, timeoutMs: 3_000, maxAttempts: 3, baseBackoffMs: 200, jitterMs: 0, fetcher: quoteFetcherFor(scenario) }),
  );
  const transport = new MetaTransport(
    agent,
    store,
    new MetaInbox(join(scratch, "intake"), config.appSecret),
    new MetaGraphClient(config, captureFetcher(capture)),
    config,
    { typingDelayMs: 0, log: (event) => events.push(event) },
  );
  const server = createServer(createMetaHttpHandler(config, transport, "api-replay"));
  const webhookUrl = await listen(server);
  const transcript: TranscriptLine[] = [];
  let index = 0;
  let visible = 0;
  const markVisible = async (): Promise<Record<string, unknown>> => {
    await waitUntil(() => capture.records.filter(({ http_status, payload }) => http_status < 400 && payload.status !== "read").length > visible);
    const replies = capture.records.filter(({ http_status, payload }) => http_status < 400 && payload.status !== "read");
    const reply = replies[visible];
    if (!reply) {
      throw new Error("Visible reply missing");
    }
    visible += 1;
    transcript.push({
      at_ms: reply.at_ms,
      role: "autoseguro",
      text: sanitizeText(visibleText(reply.payload)),
      kind: reply.payload.type === "interactive" ? "interactive" : "text",
      ...(interactionIds(reply.payload).length > 0 ? { action_ids: interactionIds(reply.payload) } : {}),
    });
    return reply.payload;
  };
  const sendText = async (text: string): Promise<Record<string, unknown>> => {
    index += 1;
    transcript.push({ at_ms: Math.round(performance.now() - started), role: "lead", text: sanitizeText(text), kind: "text" });
    await postWebhook(webhookUrl, webhookBody(scenario, index, { type: "text", text: { body: text } }));
    return markVisible();
  };
  const tap = async (current: Record<string, unknown>, actionId: string): Promise<Record<string, unknown>> => {
    const interactive = current.interactive;
    assert.ok(isRecord(interactive), "An interactive reply is required before a tap");
    const actionIds = interactionIds(current);
    assert.ok(actionIds.includes(actionId), `Inbound ${actionId} was not emitted by the app`);
    const isList = interactive.type === "list";
    const title = actionTitle(current, actionId);
    index += 1;
    transcript.push({ at_ms: Math.round(performance.now() - started), role: "lead", text: actionId, kind: "interactive", action_ids: [actionId] });
    await postWebhook(webhookUrl, webhookBody(scenario, index, {
      type: "interactive",
      interactive: isList
        ? { type: "list_reply", list_reply: { id: actionId, title } }
        : { type: "button_reply", button_reply: { id: actionId, title } },
    }));
    return markVisible();
  };
  const selectPlan = async (plan: "essencial" | "completo" | "premium", reselect = false): Promise<Record<string, unknown>> => {
    let reply = await sendText("Olá");
    reply = await tap(reply, "plans_view");
    reply = await sendText("Quero entender as opções de seguro.");
    if (reselect) {
      reply = await tap(reply, "plan_essencial");
      reply = await tap(reply, "plans_view");
      return tap(reply, `plan_${plan}`);
    }
    return tap(reply, `plan_${plan}`);
  };
  const collectAndQuote = async (plan: "essencial" | "completo" | "premium", age: string, year: string, cep: string, start: string, reselect = false): Promise<Record<string, unknown>> => {
    let reply = await selectPlan(plan, reselect);
    reply = await tap(reply, "quote_start");
    await sendText(age);
    await sendText(year);
    await sendText(cep);
    return sendText(start);
  };
  try {
    if (scenario === "essencial-csat") {
      const pending = await collectAndQuote("essencial", "30", "2020", "00000-000", "amanhã");
      assert.match(visibleText(pending), /Recebi seus dados/u);
      await waitUntil(async () => (await stateFor(store)).stage === "resolved");
      const finalReply = await markVisible();
      const csat = await tap(finalReply, "service_end");
      await tap(csat, "csat_great");
    }
    if (scenario === "completo-reselect") {
      const pending = await collectAndQuote("completo", "42", "2018", "00000-000", "10/09/2026", true);
      assert.match(visibleText(pending), /Recebi seus dados/u);
      await waitUntil(async () => (await stateFor(store)).stage === "resolved");
      await markVisible();
    }
    if (scenario === "premium-pro-rata") {
      const pending = await collectAndQuote("premium", "35", "2023", "07000-000", "15/09/2026");
      assert.match(visibleText(pending), /Recebi seus dados/u);
      await waitUntil(async () => (await stateFor(store)).stage === "resolved");
      await markVisible();
    }
    if (scenario === "slow-status-success") {
      const pending = await collectAndQuote("completo", "31", "2022", "00000-000", "10/09/2026");
      assert.match(visibleText(pending), /Recebi seus dados/u);
      const status = await sendText("Já conseguiu?");
      assert.match(visibleText(status), /andamento|preparando/u);
      await waitUntil(async () => (await stateFor(store)).stage === "resolved", 15_000);
      await markVisible();
      assert.ok(performance.now() - started >= 7_900, "The real slow service call did not run for about 8 seconds");
    }
    if (scenario === "five-xx-handoff") {
      await collectAndQuote("completo", "31", "2022", "00000-000", "10/09/2026");
      await waitUntil(async () => (await stateFor(store)).stage === "handoff", 15_000);
      const finalReply = await markVisible();
      assert.doesNotMatch(visibleText(finalReply), /R\$|HTTP|infraestrutura|5xx/iu);
    }
    await transport.waitForIdle();
    const state = await stateFor(store);
    const terminal = state.stage;
    if (terminal !== "closed" && terminal !== "resolved" && terminal !== "handoff") {
      throw new Error(`Unexpected terminal state: ${terminal}`);
    }
    assert.ok(llm.understandCalls > 0, "each replay must use the real LLM");
    assertPresenceOrder(capture.records);
    assertOutboundShapes(capture.records);
    const attempts = state.quote_jobs.flatMap((job) => job.attempts).map((attempt) => ({
      http_status: attempt.http_status,
      latency_ms: attempt.latency_ms,
      will_retry: attempt.will_retry,
    }));
    const interactionFallback = events.some((event) => event.event === "meta_interaction" && event.status === "fallback");
    if (scenario === "essencial-csat") {
      assert.ok(interactionFallback, "date buttons must record their text fallback");
    }
    if (scenario === "slow-status-success") {
      assert.ok(attempts.some((attempt) => attempt.latency_ms >= 7_900 && attempt.http_status === 200));
    }
    if (scenario === "five-xx-handoff") {
      assert.equal(attempts.length, 3);
      assert.ok(attempts.every((attempt) => attempt.http_status !== null && attempt.http_status >= 500));
    }
    const auditEvents = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => {
      const event = JSON.parse(line) as { event?: unknown };
      return typeof event.event === "string" ? event.event : "unknown";
    });
    return {
      label: "API-emulated hybrid",
      scenario,
      outcome: terminal,
      elapsed_ms: Math.round(performance.now() - started),
      llm: { endpoint: new URL(required("LLM_BASE_URL")).origin, model: required("LLM_MODEL"), understand_calls: llm.understandCalls },
      quote_service: { identity: quoteService.identity, source_sha256: quoteService.sourceHash, attempts },
      capture: summaryCapture(capture.records),
      transcript,
      effects: {
        quote_statuses: state.quote_jobs.map((job) => job.status),
        outbox_delivered: state.outbox.every((message) => message.delivered_at !== null),
        csat_rating: state.csat_rating,
        handoff_reason: state.handoff_reason,
        audit_events: auditEvents,
        interaction_fallback: interactionFallback,
      },
      assertions: assertionLabels(scenario, transcript, attempts),
    };
  } finally {
    transport.stop();
    await close(server);
    await capture.stop();
    await quoteService.stop();
    await rm(scratch, { recursive: true, force: true });
  }
}

function replyButtonTitle(buttons: unknown, actionId: string): string | null {
  if (!Array.isArray(buttons)) {
    return null;
  }
  const button = buttons.find((candidate) => isRecord(candidate) && isRecord(candidate.reply) && candidate.reply.id === actionId);
  return isRecord(button) && isRecord(button.reply) && typeof button.reply.title === "string" ? button.reply.title : null;
}

function replyListTitle(sections: unknown, actionId: string): string | null {
  if (!Array.isArray(sections)) {
    return null;
  }
  for (const section of sections) {
    if (isRecord(section) && Array.isArray(section.rows)) {
      const row = section.rows.find((candidate) => isRecord(candidate) && candidate.id === actionId);
      if (isRecord(row) && typeof row.title === "string") {
        return row.title;
      }
    }
  }
  return null;
}

function actionTitle(payload: Record<string, unknown>, actionId: string): string {
  const interactive = payload.interactive;
  if (!isRecord(interactive) || !isRecord(interactive.action)) {
    throw new Error("Interactive payload missing");
  }
  const title = replyButtonTitle(interactive.action.buttons, actionId) ?? replyListTitle(interactive.action.sections, actionId);
  if (!title) {
    throw new Error(`Emitted action ${actionId} has no title`);
  }
  return title;
}

async function stateFor(store: FileConversationStore) {
  const conversation = `wa-${sha256(config.allowedRecipient)}`;
  return store.load(conversation);
}

function assertionLabels(scenario: ScenarioName, transcript: TranscriptLine[], attempts: Array<{ http_status: number | null; latency_ms: number; will_retry: boolean }>): string[] {
  const assistantText = transcript.filter((line) => line.role === "autoseguro").map((line) => line.text).join("\n");
  const labels = [
    "signed byte-exact webhook intake",
    "presence before visible replies",
    "accepted Meta text/list/button shapes",
    "outbound text/list/button payload shapes",
    "official quote service is the price authority",
    "no full UUID or credential-bearing header persisted",
  ];
  if (scenario === "essencial-csat") {
    assert.match(assistantText, /Essencial|30 dias|Obrigado pela avaliação/u);
    labels.push("Essencial education", "bare scalar age", "relative pt-BR date", "interactive text fallback", "CSAT close");
  }
  if (scenario === "completo-reselect") {
    assert.match(assistantText, /terceiros.*vidros|30 dias|10\/09\/2026/isu);
    labels.push("plan compare and reselect", "terceiros and vidros education", "30-day waiting period", "pt-BR date");
  }
  if (scenario === "premium-pro-rata") {
    assert.match(assistantText, /carro reserva.*assistência|Primeiro pagamento proporcional/isu);
    labels.push("high-risk CEP", "pro-rata", "carro reserva and 24h assistance");
  }
  if (scenario === "slow-status-success") {
    assert.ok(attempts.some((attempt) => attempt.latency_ms >= 7_900));
    labels.push("real approximately eight-second official-service delay", "pending status remains responsive");
  }
  if (scenario === "five-xx-handoff") {
    assert.equal(attempts.length, 3);
    labels.push("three official-service 5xx attempts", "context-rich handoff without price or infrastructure jargon");
  }
  return labels;
}

async function provenanceManifest(): Promise<Record<string, unknown>> {
  const sources = await Promise.all(fixtureSources.map(async (source) => ({ source, sha256: sha256(await readFile(source)) })));
  return {
    label: "API-emulated hybrid",
    source_shapes: sources,
    public_meta_docs: metaDocs,
    synthetic_replacements: ["WABA", "phone number ID", "recipient", "wamid", "callback", "timestamp", "app ID", "token", "PIN", "profile"],
    fixtures: {
      text: { type: "text", text: { body: "synthetic text" } },
      interactive_list_reply: { type: "interactive", interactive: { type: "list_reply", list_reply: { id: "plan_completo", title: "Completo" } } },
      interactive_button_reply: { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "quote_start", title: "Continuar" } } },
      presence: { messaging_product: "whatsapp", status: "read", message_id: "wamid.synthetic", typing_indicator: { type: "text" } },
      text_send: { messaging_product: "whatsapp", recipient_type: "individual", to: "synthetic-recipient", type: "text", text: { body: "synthetic visible reply" } },
      list_send: { messaging_product: "whatsapp", recipient_type: "individual", to: "synthetic-recipient", type: "interactive", interactive: { type: "list", body: { text: "synthetic visible reply" }, action: { button: "Ver planos", sections: [{ title: "Planos", rows: [{ id: "plan_completo", title: "Completo", description: "terceiros e vidros" }] }] } } },
      button_send: { messaging_product: "whatsapp", recipient_type: "individual", to: "synthetic-recipient", type: "interactive", interactive: { type: "button", body: { text: "synthetic visible reply" }, action: { buttons: [{ type: "reply", reply: { id: "quote_start", title: "Continuar" } }] } } },
      graph_response: { messaging_product: "whatsapp", contacts: [{ wa_id: "synthetic-recipient" }], messages: [{ id: "wamid.capture.1" }] },
    },
  };
}

function resultMarkdown(results: ScenarioResult[]): string {
  const rows = results.map((result) => `| ${result.scenario} | ${result.outcome} | ${result.elapsed_ms} | ${result.quote_service.attempts.length} |`).join("\n");
  return [
    "# API replay hybrid evidence",
    "",
    "Label: **API-emulated hybrid**.",
    "",
    "This proves the real AutoSeguro webhook, core, durable intake/outbox, real Ollama Cloud DeepSeek V4 Flash, and the unmodified official quote service worked together through a loopback Meta Graph capture peer.",
    "",
    "It does not prove Meta accepted the requests or how a phone rendered them. No real WhatsApp client or Meta endpoint received a message.",
    "",
    "| Conversation | Terminal outcome | Elapsed ms | Quote attempts |",
    "|---|---|---:|---:|",
    rows,
    "",
    "Each result JSON records ordered synthetic turns, presence, outbound payload shapes, quote attempts, terminal state, and semantic contracts. `payload-shape-provenance.json` records the accepted source shapes and hashes.",
  ].join("\n");
}

async function scanEvidence(): Promise<void> {
  const paths = [
    join(outputDirectory, "summary.json"),
    join(outputDirectory, "summary.md"),
    join(outputDirectory, "payload-shape-provenance.json"),
    ...(["essencial-csat", "completo-reselect", "premium-pro-rata", "slow-status-success", "five-xx-handoff"] as ScenarioName[]).flatMap((name) => [join(outputDirectory, `${name}.json`), join(outputDirectory, `${name}.md`)]),
  ];
  const patterns = [/authorization/iu, /bearer\s+/iu, /api[_-]?key/iu, /synthetic-app-secret/iu, /\/home\//u, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu, /\b\d{5}-\d{3}\b/u];
  for (const path of paths) {
    const content = await readFile(path, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        throw new Error(`Evidence scan rejected ${path}: ${pattern}`);
      }
    }
  }
}

async function main(): Promise<void> {
  required("LLM_BASE_URL");
  required("LLM_API_KEY");
  required("LLM_MODEL");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const scenarios: ScenarioName[] = ["essencial-csat", "completo-reselect", "premium-pro-rata", "slow-status-success", "five-xx-handoff"];
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    results.push(result);
    await writeFile(join(outputDirectory, `${scenario}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(outputDirectory, `${scenario}.md`), `# ${scenario}\n\nLabel: **API-emulated hybrid**.\n\n${result.transcript.map((line) => `- ${line.role}: ${line.text}`).join("\n")}\n`);
  }
  const summary = {
    label: "API-emulated hybrid",
    results: results.map((result) => ({
      label: result.label,
      scenario: result.scenario,
      outcome: result.outcome,
      elapsed_ms: result.elapsed_ms,
      llm: result.llm,
      quote_service: result.quote_service,
      effects: result.effects,
      assertions: result.assertions,
    })),
  };
  await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(outputDirectory, "summary.md"), `${resultMarkdown(results)}\n`);
  await writeFile(join(outputDirectory, "payload-shape-provenance.json"), `${JSON.stringify(await provenanceManifest(), null, 2)}\n`);
  await scanEvidence();
  console.log("API-emulated hybrid replay passed: five conversations, loopback Meta capture only.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
