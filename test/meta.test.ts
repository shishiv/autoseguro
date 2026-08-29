import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AutoSeguroAgent } from "../src/agent.ts";
import {
  createMetaHttpHandler,
  MetaGraphClient,
  MetaInbox,
  metaRuntimeConfig,
  MetaTransport,
  TEST_PHONE_NUMBER_ID,
  TEST_WABA_ID,
} from "../src/meta.ts";
import { AuditLog, FileConversationStore } from "../src/persistence.ts";
import type {
  LanguageModel,
  LanguageUnderstanding,
  QuoteAttempt,
  QuoteClientPort,
  QuotePayload,
  QuoteResponse,
  QuoteResult,
  ReplyInput,
  UnderstandingInput,
} from "../src/types.ts";

const config = {
  wabaId: TEST_WABA_ID,
  phoneNumberId: TEST_PHONE_NUMBER_ID,
  accessToken: "meta-token-that-must-not-leak",
  appSecret: "test-app-secret",
  verifyToken: "test-verify-token",
  allowedRecipient: "5511999998888",
  publicBaseUrl: "https://autoseguro.example.com",
};

class StubLlm implements LanguageModel {
  private readonly responses: LanguageUnderstanding[];
  private calls = 0;

  constructor(responses: LanguageUnderstanding[]) {
    this.responses = responses;
  }

  async understand(_input: UnderstandingInput): Promise<LanguageUnderstanding> {
    const response = this.responses[this.calls];
    this.calls += 1;
    if (!response) {
      throw new Error("Resposta LLM ausente");
    }
    return structuredClone(response);
  }

  async phrase(input: ReplyInput): Promise<string> {
    return input.draft;
  }
}

interface DeferredRequest {
  onAttempt: (attempt: QuoteAttempt) => Promise<void>;
  resolve: (result: QuoteResult) => void;
}

class DeferredQuoteClient implements QuoteClientPort {
  readonly requests: DeferredRequest[] = [];

  request(
    _payload: QuotePayload,
    _requestId: string,
    onAttempt: (attempt: QuoteAttempt) => Promise<void>,
  ): Promise<QuoteResult> {
    return new Promise((resolve) => this.requests.push({ onAttempt, resolve }));
  }

  async success(price = 209.9): Promise<void> {
    const request = this.requests[0];
    if (!request) {
      throw new Error("Cotação pendente ausente");
    }
    const attempt = quoteAttempt(1, 200, false);
    await request.onAttempt(attempt);
    request.resolve({ kind: "success", quote: quote(price), attempts: [attempt] });
  }

  async handoff(): Promise<void> {
    const request = this.requests[0];
    if (!request) {
      throw new Error("Cotação pendente ausente");
    }
    const attempts = [
      quoteAttempt(1, 500, true),
      quoteAttempt(2, 502, true),
      quoteAttempt(3, 503, false),
    ];
    for (const attempt of attempts) {
      await request.onAttempt(attempt);
    }
    request.resolve({ kind: "handoff", reason: "quote_service_unavailable", attempts });
  }
}

class FakeMeta {
  readonly bodies: Array<Record<string, unknown>> = [];
  readonly requests: Array<Record<string, unknown>> = [];
  readonly statuses: number[];
  readonly presenceStatuses: number[];
  private sent = 0;
  private presenceSent = 0;

  constructor(statuses: number[] = [], presenceStatuses: number[] = []) {
    this.statuses = statuses;
    this.presenceStatuses = presenceStatuses;
  }

  readonly fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    this.requests.push(body);
    if (body.status === "read") {
      const status = this.presenceStatuses[this.presenceSent] ?? 200;
      this.presenceSent += 1;
      return status >= 400
        ? new Response(JSON.stringify({ error: { code: 131_000 } }), { status, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ success: true }), { status, headers: { "content-type": "application/json" } });
    }
    this.bodies.push(body);
    const status = this.statuses[this.sent] ?? 200;
    this.sent += 1;
    return status >= 400
      ? new Response(JSON.stringify({ error: { code: 131_000, error_subcode: 249_999 } }), {
          status,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ messages: [{ id: `meta-out-${this.sent}` }] }), {
          status,
          headers: { "content-type": "application/json" },
        });
  }) as typeof fetch;
}

interface Harness {
  agent: AutoSeguroAgent;
  store: FileConversationStore;
  inbox: MetaInbox;
  intakeDirectory: string;
  auditPath: string;
  stateDirectory: string;
  transport: MetaTransport;
  meta: FakeMeta;
  quoteClient: DeferredQuoteClient;
  events: Array<Record<string, unknown>>;
}

function completeUnderstanding(): LanguageUnderstanding {
  return {
    fields: {
      plano: "completo",
      idade: 35,
      veiculo_ano: 2022,
      cep: "01310-100",
      data_inicio: "2026-09-01",
    },
    intent: "continue",
    ambiguous: false,
  };
}

function incompleteUnderstanding(): LanguageUnderstanding {
  return {
    fields: { plano: "completo" },
    intent: "continue",
    ambiguous: false,
  };
}

function quote(price: number): QuoteResponse {
  return {
    plano_id: "completo",
    plano_nome: "Completo",
    premio_mensal: price,
    franquia: 3000,
    coberturas: ["colisao", "roubo"],
    moeda: "BRL",
  };
}

function quoteAttempt(attempt: number, status: number, willRetry: boolean): QuoteAttempt {
  return {
    attempt,
    latency_ms: 10,
    http_status: status,
    failure_kind: null,
    will_retry: willRetry,
  };
}

async function harness(
  context: TestContext,
  understandings: LanguageUnderstanding[] = [completeUnderstanding()],
  statuses: number[] = [],
  retryMs = 10,
  presenceStatuses: number[] = [],
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "autoseguro-meta-"));
  const stateDirectory = join(directory, "conversations");
  const intakeDirectory = join(directory, "meta-intake");
  const auditPath = join(directory, "audit.jsonl");
  const store = new FileConversationStore(stateDirectory);
  const quoteClient = new DeferredQuoteClient();
  const agent = new AutoSeguroAgent(
    store,
    new AuditLog(auditPath),
    new StubLlm(understandings),
    quoteClient,
    { createId: () => "quote-request-meta", now: () => new Date("2026-08-28T12:00:00.000Z") },
  );
  const inbox = new MetaInbox(intakeDirectory, config.appSecret);
  const meta = new FakeMeta(statuses, presenceStatuses);
  const events: Array<Record<string, unknown>> = [];
  const transport = new MetaTransport(
    agent,
    store,
    inbox,
    new MetaGraphClient(config, meta.fetcher),
    config,
    { now: () => new Date("2026-08-28T12:00:00.000Z"), retryMs, typingDelayMs: 0, log: (event) => events.push(event) },
  );
  context.after(async () => {
    transport.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  });
  return { agent, store, inbox, intakeDirectory, auditPath, stateDirectory, transport, meta, quoteClient, events };
}

function webhookPayload(
  id = "wamid.HBgNNTUxMTk5OTk5ODg4OBUCABIYFDNBQkNERUY=",
  type = "text",
  text = "Completo, 35 anos, carro 2022, CEP 01310-100, início 2026-09-01",
  recipient = config.allowedRecipient,
): Buffer {
  return Buffer.from(JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: TEST_WABA_ID,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: TEST_PHONE_NUMBER_ID },
          messages: [{
            from: recipient,
            id,
            type,
            ...(type === "text" ? { text: { body: text } } : { [type]: { id: "media-id" } }),
          }],
        },
      }],
    }],
  }));
}

function signature(body: Buffer): string {
  return `sha256=${createHmac("sha256", config.appSecret).update(body).digest("hex")}`;
}

async function startWebhook(context: TestContext, transport: MetaTransport): Promise<string> {
  const server = createServer(createMetaHttpHandler(config, transport));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Servidor HTTP sem porta");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function postWebhook(baseUrl: string, body: Buffer, suppliedSignature = signature(body)): Promise<Response> {
  return fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": suppliedSignature,
    },
    body: body.toString("utf8"),
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error("Condição de teste não atendida");
    }
    await delay(2);
  }
}

function sentText(meta: FakeMeta, index: number): string {
  const body = meta.bodies[index];
  const text = body?.text ?? (body?.interactive as { body?: { text?: unknown } } | undefined)?.body?.text;
  return typeof text === "object" && text !== null && "body" in text
    ? String((text as { body: unknown }).body)
    : typeof text === "string" ? text : "";
}

async function intakeRecord(directory: string): Promise<string> {
  const [name] = await readdir(directory);
  if (!name) {
    throw new Error("Registro de intake ausente");
  }
  return readFile(join(directory, name), "utf8");
}

test("verifica health e o challenge do webhook", async (context) => {
  const testHarness = await harness(context);
  const baseUrl = await startWebhook(context, testHarness.transport);
  const health = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await health.json(), { status: "ok" });
  const verification = await fetch(
    `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.challenge=12345`,
  );
  assert.equal(verification.status, 200);
  assert.equal(await verification.text(), "12345");
  const denied = await fetch(`${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
  assert.equal(denied.status, 403);
});

test("rejeita HMAC ausente ou inválido antes de aceitar o evento", async (context) => {
  const testHarness = await harness(context);
  const baseUrl = await startWebhook(context, testHarness.transport);
  const body = Buffer.from("{not-json");
  const missing = await fetch(`${baseUrl}/webhook`, { method: "POST", body: body.toString("utf8") });
  const invalid = await postWebhook(baseUrl, body, `sha256=${"0".repeat(64)}`);
  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  assert.equal((await testHarness.inbox.open()).length, 0);
});

test("rejeita payload malformado com assinatura válida", async (context) => {
  const testHarness = await harness(context);
  const baseUrl = await startWebhook(context, testHarness.transport);
  const body = Buffer.from("{not-json");
  const response = await postWebhook(baseUrl, body);
  assert.equal(response.status, 400);
  assert.equal(testHarness.meta.bodies.length, 0);
});

test("recusa destinatário fora da allowlist sem intake", async (context) => {
  const testHarness = await harness(context);
  const baseUrl = await startWebhook(context, testHarness.transport);
  const body = webhookPayload("wamid-not-allowed", "text", "oi", "5511888887777");
  assert.equal((await postWebhook(baseUrl, body)).status, 403);
  assert.equal((await testHarness.inbox.open()).length, 0);
  assert.equal(testHarness.meta.bodies.length, 0);
});

test("deduplica o wamid antes de chamar o agente ou enviar resposta", async (context) => {
  const testHarness = await harness(context, [incompleteUnderstanding()]);
  const baseUrl = await startWebhook(context, testHarness.transport);
  const body = webhookPayload();
  const responses = await Promise.all([postWebhook(baseUrl, body), postWebhook(baseUrl, body)]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  await waitUntil(() => testHarness.meta.bodies.length === 1);
  await testHarness.transport.waitForIdle();
  assert.equal(testHarness.meta.bodies.length, 1);
  assert.equal((await readdir(testHarness.intakeDirectory)).length, 1);
});

test("mídia não suportada usa o handoff explícito existente", async (context) => {
  const testHarness = await harness(context, []);
  const baseUrl = await startWebhook(context, testHarness.transport);
  const response = await postWebhook(baseUrl, webhookPayload("wamid-media", "video"));
  assert.equal(response.status, 200);
  await waitUntil(() => testHarness.meta.bodies.length === 1);
  assert.match(sentText(testHarness.meta, 0), /pessoa do time/u);
  assert.doesNotMatch(sentText(testHarness.meta, 0), /R\$/u);
  assert.equal(testHarness.quoteClient.requests.length, 0);
});

test("persiste falha outbound sem corpo de mensagem ou token", async (context) => {
  const testHarness = await harness(context, [incompleteUnderstanding()], [500, 500, 200]);
  const baseUrl = await startWebhook(context, testHarness.transport);
  const body = webhookPayload("wamid-outbound-failure", "text", "mensagem-secreta completo");
  assert.equal((await postWebhook(baseUrl, body)).status, 200);
  await waitUntil(() => testHarness.meta.bodies.length === 3);
  await testHarness.transport.waitForIdle();
  const saved = await intakeRecord(testHarness.intakeDirectory);
  assert.match(saved, /"http_status":500/u);
  assert.match(saved, /"error_code":"131000"/u);
  assert.doesNotMatch(saved, /mensagem-secreta|meta-token-that-must-not-leak/u);
});

test("fake Meta E2E confirma rápido, envia pending e entrega a cotação depois", async (context) => {
  const testHarness = await harness(context);
  const baseUrl = await startWebhook(context, testHarness.transport);
  const started = performance.now();
  const response = await postWebhook(baseUrl, webhookPayload("wamid-delayed-success"));
  const acknowledgementMs = performance.now() - started;
  assert.equal(response.status, 200);
  assert.ok(acknowledgementMs < 250, `ack demorou ${acknowledgementMs} ms`);
  await waitUntil(() => testHarness.meta.bodies.length === 1 && testHarness.quoteClient.requests.length === 1);
  assert.match(sentText(testHarness.meta, 0), /Recebi seus dados/u);
  assert.doesNotMatch(sentText(testHarness.meta, 0), /R\$/u);
  const durableIntake = await intakeRecord(testHarness.intakeDirectory);
  assert.doesNotMatch(durableIntake, /Completo, 35 anos|5511999998888|meta-token-that-must-not-leak/u);
  await delay(120);
  assert.equal(testHarness.meta.bodies.length, 1);
  await testHarness.quoteClient.success(321.45);
  await waitUntil(() => testHarness.meta.bodies.length === 2);
  await testHarness.transport.waitForIdle();
  assert.match(sentText(testHarness.meta, 1), /321,45/u);
  assert.deepEqual(testHarness.events.filter((event) => event.event === "meta_delivery").map((event) => ({
    delivery: event.delivery,
    status: event.status,
    quote_attempts: event.quote_attempts,
    outcome: event.outcome,
  })), [
    { delivery: "immediate", status: "delivered", quote_attempts: 0, outcome: "awaiting_data" },
    { delivery: "final", status: "delivered", quote_attempts: 1, outcome: "resolved" },
  ]);
});

test("entrega handoff tardio após esgotar a cotação", async (context) => {
  const testHarness = await harness(context);
  const baseUrl = await startWebhook(context, testHarness.transport);
  assert.equal((await postWebhook(baseUrl, webhookPayload("wamid-delayed-handoff"))).status, 200);
  await waitUntil(() => testHarness.meta.bodies.length === 1 && testHarness.quoteClient.requests.length === 1);
  await testHarness.quoteClient.handoff();
  await waitUntil(() => testHarness.meta.bodies.length === 2);
  await testHarness.transport.waitForIdle();
  assert.match(sentText(testHarness.meta, 1), /Não consegui concluir/u);
  const conversationId = `wa-${createHash("sha256").update(config.allowedRecipient).digest("hex")}`;
  const state = await testHarness.store.load(conversationId);
  assert.equal(state.quote_jobs[0]?.attempts.length, 3);
  assert.equal(state.stage, "handoff");
  assert.deepEqual(testHarness.events.at(-1), {
    event: "meta_delivery",
    timestamp: "2026-08-28T12:00:00.000Z",
    received_at: "2026-08-28T12:00:00.000Z",
    delivery: "final",
    status: "delivered",
    inbound_message_id: `wamid-${createHash("sha256").update("wamid-delayed-handoff").digest("hex")}`,
    outbound_message_id: `sha256:${createHash("sha256").update("meta-out-2").digest("hex")}`,
    quote_request_id: "quote-request-meta",
    quote_attempts: 3,
    outcome: "handoff",
    http_status: null,
    error_code: null,
  });
});

test("reinício reproduz a outbox final sem repetir a resposta imediata", async (context) => {
  const first = await harness(context, [completeUnderstanding()], [200, 500, 500], 10_000);
  const baseUrl = await startWebhook(context, first.transport);
  assert.equal((await postWebhook(baseUrl, webhookPayload("wamid-restart"))).status, 200);
  await waitUntil(() => first.meta.bodies.length === 1 && first.quoteClient.requests.length === 1);
  await first.quoteClient.success(444.44);
  await waitUntil(() => first.meta.bodies.length === 3);
  await first.transport.waitForIdle();
  first.transport.stop();
  const [openRecord] = await first.inbox.open();
  assert.ok(openRecord);
  const conversationId = openRecord.conversation_id;

  const restartedMeta = new FakeMeta();
  const restartedStore = new FileConversationStore(first.stateDirectory);
  const restartedAgent = new AutoSeguroAgent(
    restartedStore,
    new AuditLog(first.auditPath),
    new StubLlm([]),
    new DeferredQuoteClient(),
    { now: () => new Date("2026-08-28T12:01:00.000Z") },
  );
  const restarted = new MetaTransport(
    restartedAgent,
    restartedStore,
    new MetaInbox(first.intakeDirectory, config.appSecret),
    new MetaGraphClient(config, restartedMeta.fetcher),
    config,
    { now: () => new Date("2026-08-28T12:01:00.000Z"), retryMs: 10 },
  );
  context.after(() => restarted.stop());
  await restarted.recover();
  await restarted.waitForIdle();
  assert.equal(restartedMeta.bodies.length, 1);
  assert.match(sentText(restartedMeta, 0), /444,44/u);
  const state = await restartedStore.load(conversationId);
  assert.equal(state.outbox[0]?.delivered_at, "2026-08-28T12:01:00.000Z");
});

test("configuração recusa qualquer alvo fora do WABA Meta de teste", () => {
  assert.throws(() => metaRuntimeConfig({
    META_WABA_ID: "canonical",
    META_PHONE_NUMBER_ID: TEST_PHONE_NUMBER_ID,
    META_ACCESS_TOKEN: "token",
    META_APP_SECRET: "secret",
    META_VERIFY_TOKEN: "verify",
    META_ALLOWED_RECIPIENT: "+55 11 99999-8888",
    PUBLIC_BASE_URL: "https://autoseguro.example.com",
  }), /somente o WABA/u);
});

test("envia presença v25 antes das respostas imediata e final", async (context) => {
  const testHarness = await harness(context);
  const baseUrl = await startWebhook(context, testHarness.transport);
  assert.equal((await postWebhook(baseUrl, webhookPayload("wamid-presence-order"))).status, 200);
  await waitUntil(() => testHarness.meta.requests.length === 2 && testHarness.quoteClient.requests.length === 1);
  assert.deepEqual(testHarness.meta.requests[0], {
    messaging_product: "whatsapp",
    status: "read",
    message_id: "wamid-presence-order",
    typing_indicator: { type: "text" },
  });
  assert.equal(testHarness.meta.requests[1]?.type, "text");
  await testHarness.quoteClient.success();
  await waitUntil(() => testHarness.meta.requests.length === 4);
  assert.equal(testHarness.meta.requests[2]?.status, "read");
  assert.equal(testHarness.meta.requests[2]?.message_id, "wamid-presence-order");
  assert.equal(testHarness.meta.requests[3]?.type, "interactive");
  assert.deepEqual(testHarness.events.filter((event) => event.event === "meta_presence").map((event) => event.delivery), ["immediate", "final"]);
});

test("falha de presença não impede a resposta em texto", async (context) => {
  const testHarness = await harness(context, [], [], 10, [500]);
  const baseUrl = await startWebhook(context, testHarness.transport);
  assert.equal((await postWebhook(baseUrl, webhookPayload("wamid-presence-failure", "video"))).status, 200);
  await waitUntil(() => testHarness.meta.bodies.length === 1);
  assert.equal(testHarness.meta.bodies[0]?.type, "text");
  assert.equal(testHarness.events.find((event) => event.event === "meta_presence")?.status, "failed");
});

test("lista de planos faz fallback para texto e aceita a resposta interativa", async (context) => {
  const fallback = await harness(context, [{ fields: {}, intent: "continue", ambiguous: false }], [500, 200]);
  const fallbackUrl = await startWebhook(context, fallback.transport);
  assert.equal((await postWebhook(fallbackUrl, webhookPayload("wamid-list-fallback", "text", "oi"))).status, 200);
  await waitUntil(() => fallback.meta.bodies.length === 2);
  assert.equal(fallback.meta.bodies[0]?.type, "interactive");
  assert.equal(fallback.meta.bodies[1]?.type, "text");
  assert.match(sentText(fallback.meta, 1), /1\. Essencial/u);

  const mapped = await harness(context, [{ fields: {}, intent: "continue", ambiguous: false }]);
  const mappedUrl = await startWebhook(context, mapped.transport);
  assert.equal((await postWebhook(mappedUrl, webhookPayload("wamid-list-start", "text", "oi"))).status, 200);
  await waitUntil(() => mapped.meta.bodies.length === 1);
  const response = Buffer.from(JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: TEST_WABA_ID,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: TEST_PHONE_NUMBER_ID },
          messages: [{
            from: config.allowedRecipient,
            id: "wamid-list-reply",
            type: "interactive",
            interactive: { type: "list_reply", list_reply: { id: "plan_completo", title: "Completo" } },
          }],
        },
      }],
    }],
  }));
  assert.equal((await postWebhook(mappedUrl, response)).status, 200);
  await waitUntil(() => mapped.meta.bodies.length === 2);
  const conversationId = `wa-${createHash("sha256").update(config.allowedRecipient).digest("hex")}`;
  assert.equal((await mapped.store.load(conversationId)).fields.plano?.value, "completo");
});
