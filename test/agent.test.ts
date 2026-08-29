import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AutoSeguroAgent } from "../src/agent.ts";
import { OpenAICompatibleLlm } from "../src/llm.ts";
import { AuditLog, FileConversationStore } from "../src/persistence.ts";
import { redactSensitiveText } from "../src/privacy.ts";
import { QuoteClient } from "../src/quote-client.ts";
import type {
  CandidateFields,
  IncomingMessage,
  LanguageModel,
  LanguageUnderstanding,
  OutboxMessage,
  QuoteAttempt,
  QuoteClientPort,
  QuotePayload,
  QuoteResponse,
  QuoteResult,
  ReplyInput,
  UnderstandingInput,
} from "../src/types.ts";

interface ServerReply {
  status: number;
  body: unknown;
  delayMs?: number;
}

interface RequestRecord {
  payload: QuotePayload;
  requestId: string | undefined;
}

interface DeferredCall {
  payload: QuotePayload;
  requestId: string;
  completedAttempts: number;
  onAttempt: (attempt: QuoteAttempt) => Promise<void>;
  resolve: (result: QuoteResult) => void;
}

type ServerHandler = (attempt: number, payload: QuotePayload) => ServerReply | Promise<ServerReply>;

class StubLlm implements LanguageModel {
  readonly responses: LanguageUnderstanding[];
  understandCalls = 0;

  constructor(responses: LanguageUnderstanding[]) {
    this.responses = responses;
  }

  async understand(_input: UnderstandingInput): Promise<LanguageUnderstanding> {
    const response = this.responses[this.understandCalls];
    this.understandCalls += 1;
    if (!response) {
      throw new Error("Resposta do LLM não configurada");
    }
    return structuredClone(response);
  }

  async phrase(input: ReplyInput): Promise<string> {
    return input.draft;
  }
}

class DeferredQuoteClient implements QuoteClientPort {
  readonly calls: DeferredCall[] = [];

  request(
    payload: QuotePayload,
    requestId: string,
    onAttempt: (attempt: QuoteAttempt) => Promise<void>,
    completedAttempts = 0,
    _signal?: AbortSignal,
  ): Promise<QuoteResult> {
    return new Promise((resolve) => {
      this.calls.push({ payload, requestId, completedAttempts, onAttempt, resolve });
    });
  }

  async succeed(index: number, price: number): Promise<void> {
    const call = this.calls[index];
    if (!call) {
      throw new Error(`Chamada ${index} ausente`);
    }
    const attempt: QuoteAttempt = {
      attempt: call.completedAttempts + 1,
      latency_ms: 1,
      http_status: 200,
      failure_kind: null,
      will_retry: false,
    };
    await call.onAttempt(attempt);
    call.resolve({ kind: "success", quote: successfulQuote({ premio_mensal: price }), attempts: [attempt] });
  }
}

function understanding(
  fields: CandidateFields,
  intent: LanguageUnderstanding["intent"] = "continue",
): LanguageUnderstanding {
  return { fields, intent, ambiguous: false };
}

function completeFields(overrides: CandidateFields = {}): CandidateFields {
  return {
    plano: "completo",
    idade: 35,
    veiculo_ano: 2022,
    cep: "01310-100",
    data_inicio: "2026-09-01",
    ...overrides,
  };
}

function successfulQuote(overrides: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    plano_id: "completo",
    plano_nome: "Completo",
    premio_mensal: 209.9,
    franquia: 3000,
    coberturas: ["colisao", "roubo", "furto", "terceiros", "vidros"],
    moeda: "BRL",
    ...overrides,
  };
}

async function bodyOf(request: HttpRequest): Promise<QuotePayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as QuotePayload;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function startServer(
  handler: ServerHandler,
): Promise<{ baseUrl: string; requests: RequestRecord[]; close: () => Promise<void> }> {
  const requests: RequestRecord[] = [];
  const server = createServer(async (request: HttpRequest, response: ServerResponse) => {
    const payload = await bodyOf(request);
    requests.push({ payload, requestId: firstHeader(request.headers["x-request-id"]) });
    const reply = await handler(requests.length, payload);
    if (reply.delayMs) {
      await delay(reply.delayMs);
    }
    if (!response.destroyed) {
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Servidor de teste sem porta");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function makeHarness(
  context: TestContext,
  responses: LanguageUnderstanding[],
  handler: ServerHandler,
  clientOptions: { timeoutMs?: number; maxAttempts?: number } = {},
): Promise<{
  agent: AutoSeguroAgent;
  store: FileConversationStore;
  auditPath: string;
  stateDirectory: string;
  requests: RequestRecord[];
  llm: StubLlm;
  baseUrl: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "autoseguro-"));
  const server = await startServer(handler);
  context.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const stateDirectory = join(directory, "state");
  const store = new FileConversationStore(stateDirectory);
  const auditPath = join(directory, "audit.jsonl");
  const llm = new StubLlm(responses);
  const client = new QuoteClient({
    baseUrl: server.baseUrl,
    timeoutMs: clientOptions.timeoutMs ?? 100,
    maxAttempts: clientOptions.maxAttempts ?? 3,
    baseBackoffMs: 1,
    jitterMs: 0,
    sleep: async () => undefined,
  });
  let id = 0;
  return {
    agent: new AutoSeguroAgent(store, new AuditLog(auditPath), llm, client, {
      createId: () => `quote-request-${id += 1}`,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    }),
    store,
    auditPath,
    stateDirectory,
    requests: server.requests,
    llm,
    baseUrl: server.baseUrl,
  };
}

async function makeDeferredHarness(
  context: TestContext,
  responses: LanguageUnderstanding[],
  createId: () => string = (() => {
    let id = 0;
    return () => `quote-request-${id += 1}`;
  })(),
): Promise<{
  agent: AutoSeguroAgent;
  store: FileConversationStore;
  auditPath: string;
  stateDirectory: string;
  client: DeferredQuoteClient;
}> {
  const directory = await mkdtemp(join(tmpdir(), "autoseguro-deferred-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileConversationStore(join(directory, "state"));
  const auditPath = join(directory, "audit.jsonl");
  const client = new DeferredQuoteClient();
  return {
    agent: new AutoSeguroAgent(store, new AuditLog(auditPath), new StubLlm(responses), client, {
      createId,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    }),
    store,
    auditPath,
    stateDirectory: join(directory, "state"),
    client,
  };
}

function message(
  text = "Quero o Completo, tenho 35 anos, carro 2022, CEP 01310-100, início 2026-09-01",
  id = "msg-1",
): IncomingMessage {
  return {
    conversation_id: "conversation-1",
    message_id: id,
    message_type: "text",
    text,
  };
}

async function collectTerminal(agent: AutoSeguroAgent, conversationId = "conversation-1"): Promise<OutboxMessage[]> {
  await agent.waitForIdle(conversationId);
  const messages: OutboxMessage[] = [];
  await agent.deliverOutbox(conversationId, (item) => {
    messages.push(item);
  });
  return messages;
}

async function waitForCalls(client: DeferredQuoteClient, count: number): Promise<void> {
  for (let turn = 0; turn < 100 && client.calls.length < count; turn += 1) {
    await delay(1);
  }
  assert.equal(client.calls.length, count);
}

test("confirma cotação pendente sem esperar a API", async (context) => {
  const harness = await makeDeferredHarness(context, [understanding(completeFields())]);
  const reply = await Promise.race([
    harness.agent.handle(message()),
    delay(50).then(() => {
      throw new Error("A resposta esperou pela API");
    }),
  ]);
  assert.equal(reply.outcome, "awaiting_data");
  assert.doesNotMatch(reply.text, /R\$/u);
  await waitForCalls(harness.client, 1);
  await harness.client.succeed(0, 209.9);
  const [terminal] = await collectTerminal(harness.agent);
  assert.equal(terminal?.outcome, "resolved");
  assert.match(terminal?.text ?? "", /209,90/u);
});

test("cotação feliz usa somente o preço devolvido pela API", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 200, body: successfulQuote() }),
  );
  const pending = await harness.agent.handle(message());
  const [terminal] = await collectTerminal(harness.agent);
  assert.equal(pending.outcome, "awaiting_data");
  assert.equal(terminal?.outcome, "resolved");
  assert.match(terminal?.text ?? "", /209,90/u);
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.requests[0]?.payload, {
    plano_id: "completo",
    idade: 35,
    veiculo_ano: 2022,
    cep: "01310-100",
    data_inicio: "2026-09-01",
  });
  assert.equal(harness.requests[0]?.requestId, "quote-request-1");
  const state = await harness.store.load("conversation-1");
  assert.equal(state.quote_jobs[0]?.status, "delivered");
  assert.deepEqual(state.quote_jobs[0]?.transitions.map((item) => item.status), ["pending", "delivered"]);
});

test("outbox não entregue sobrevive ao reinício", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 200, body: successfulQuote() }),
  );
  await harness.agent.handle(message());
  await harness.agent.waitForIdle("conversation-1");
  const resumed = new AutoSeguroAgent(
    new FileConversationStore(harness.stateDirectory),
    new AuditLog(harness.auditPath),
    new StubLlm([]),
    new QuoteClient({ baseUrl: harness.baseUrl, timeoutMs: 100 }),
  );
  const delivered: OutboxMessage[] = [];
  assert.equal(await resumed.deliverOutbox("conversation-1", (item) => {
    delivered.push(item);
  }), 1);
  assert.equal(delivered[0]?.outcome, "resolved");
  assert.equal(await resumed.deliverOutbox("conversation-1", () => undefined), 0);
});

test("CEP de alto risco chega intacto à API e o agente exibe a resposta", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields({ cep: "07123-456" }))],
    (_attempt, payload) => ({
      status: 200,
      body: successfulQuote({ premio_mensal: payload.cep.startsWith("07") ? 272.87 : 209.9 }),
    }),
  );
  await harness.agent.handle(message());
  const [terminal] = await collectTerminal(harness.agent);
  assert.equal(harness.requests[0]?.payload.cep, "07123-456");
  assert.match(terminal?.text ?? "", /272,87/u);
});

for (const scenario of [
  {
    name: "idade acima de 75",
    fields: completeFields({ idade: 76 }),
    reason: "Idade acima do limite de aceitacao (75 anos).",
  },
  {
    name: "veículo com mais de 20 anos",
    fields: completeFields({ veiculo_ano: 2000 }),
    reason: "Veiculo com mais de 20 anos nao e aceito.",
  },
]) {
  test(`${scenario.name} vira recusa com handoff comercial`, async (context) => {
    const harness = await makeHarness(
      context,
      [understanding(scenario.fields)],
      () => ({ status: 422, body: { error: "cotacao_recusada", motivo: scenario.reason } }),
    );
    const pending = await harness.agent.handle(message());
    const [terminal] = await collectTerminal(harness.agent);
    const state = await harness.store.load("conversation-1");
    assert.equal(pending.outcome, "awaiting_data");
    assert.equal(terminal?.outcome, "handoff");
    assert.match(terminal?.text ?? "", /Não foi possível seguir/u);
    assert.doesNotMatch(terminal?.text ?? "", /R\$/u);
    assert.equal(harness.requests.length, 1);
    assert.equal(state.stage, "handoff");
    assert.equal(state.handoff_reason, "quote_refused");
    assert.equal(state.active_quote_request_id, "quote-request-1");
    assert.equal(state.quote_jobs[0]?.status, "failed");
  });
}

test("início no meio do mês usa o primeiro pagamento devolvido pela API", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields({ data_inicio: "2026-09-15" }))],
    () => ({
      status: 200,
      body: successfulQuote({
        primeiro_pagamento_pro_rata: {
          dias_no_mes: 30,
          dias_cobrados: 16,
          valor_primeiro_pagamento: 111.95,
        },
      }),
    }),
  );
  await harness.agent.handle(message());
  const [terminal] = await collectTerminal(harness.agent);
  assert.match(terminal?.text ?? "", /111,95/u);
  assert.equal(harness.requests[0]?.payload.data_inicio, "2026-09-15");
});

test("timeout seguido de sucesso fica registrado no ciclo da cotação", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    (attempt) => ({
      status: 200,
      body: successfulQuote(),
      delayMs: attempt === 1 ? 60 : 0,
    }),
    { timeoutMs: 20 },
  );
  await harness.agent.handle(message());
  const [terminal] = await collectTerminal(harness.agent);
  const state = await harness.store.load("conversation-1");
  assert.equal(terminal?.outcome, "resolved");
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(state.quote_jobs[0]?.attempts.map((item) => item.failure_kind), ["timeout", null]);
  assert.deepEqual(state.quote_jobs[0]?.transitions.map((item) => item.status), ["pending", "retrying", "delivered"]);
});

test("5xx seguido de sucesso recupera na segunda tentativa", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    (attempt) => attempt === 1
      ? { status: 503, body: { error: "upstream_unavailable" } }
      : { status: 200, body: successfulQuote() },
  );
  await harness.agent.handle(message());
  const [terminal] = await collectTerminal(harness.agent);
  assert.equal(terminal?.outcome, "resolved");
  assert.deepEqual(harness.requests.length, 2);
});

test("falha mista recupera depois de 500 e timeout", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    (attempt) => {
      if (attempt === 1) {
        return { status: 500, body: { error: "upstream_unavailable" } };
      }
      return { status: 200, body: successfulQuote(), delayMs: attempt === 2 ? 60 : 0 };
    },
    { timeoutMs: 20 },
  );
  await harness.agent.handle(message());
  const [terminal] = await collectTerminal(harness.agent);
  const state = await harness.store.load("conversation-1");
  assert.equal(terminal?.outcome, "resolved");
  assert.equal(harness.requests.length, 3);
  assert.deepEqual(state.quote_jobs[0]?.attempts.map((item) => item.http_status), [500, null, 200]);
});

test("500, 502 e 503 esgotam três tentativas e criam handoff", async (context) => {
  const statuses = [500, 502, 503];
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    (attempt) => ({ status: statuses[attempt - 1] ?? 503, body: { error: "upstream_unavailable" } }),
  );
  await harness.agent.handle(message());
  const [terminal] = await collectTerminal(harness.agent);
  const state = await harness.store.load("conversation-1");
  assert.equal(terminal?.outcome, "handoff");
  assert.match(terminal?.text ?? "", /Não consegui concluir/u);
  assert.equal(harness.requests.length, 3);
  assert.equal(state.handoff_reason, "quote_service_unavailable");
  assert.equal(state.quote_jobs[0]?.status, "failed");
});

test("payload inválido não gera retry", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 400, body: { error: "payload_invalido" } }),
  );
  await harness.agent.handle(message());
  const [terminal] = await collectTerminal(harness.agent);
  const state = await harness.store.load("conversation-1");
  assert.equal(terminal?.outcome, "handoff");
  assert.equal(harness.requests.length, 1);
  assert.equal(state.handoff_reason, "invalid_quote_payload");
});

test("duplicata, status e informação durante pending não criam outra cotação", async (context) => {
  const harness = await makeHarness(
    context,
    [
      understanding(completeFields()),
      understanding({}, "status"),
      understanding({ plano: "premium" }, "information"),
    ],
    () => ({ status: 200, body: successfulQuote(), delayMs: 80 }),
    { timeoutMs: 200 },
  );
  const incoming = message();
  const [first, duplicate, status, information] = await Promise.all([
    harness.agent.handle(incoming),
    harness.agent.handle(incoming),
    harness.agent.handle(message("Já conseguiu?", "msg-status")),
    harness.agent.handle(message("E as coberturas?", "msg-information")),
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal(status.outcome, "awaiting_data");
  assert.match(status.text, /em andamento/u);
  assert.match(information.text, /coberturas/u);
  const [terminal] = await collectTerminal(harness.agent);
  const state = await harness.store.load("conversation-1");
  assert.equal(terminal?.outcome, "resolved");
  assert.equal(harness.requests.length, 1);
  assert.equal(state.quote_jobs.length, 1);
  assert.equal(harness.llm.understandCalls, 3);
});

test("correção durante pending invalida a cotação antiga", async (context) => {
  const harness = await makeDeferredHarness(context, [
    understanding(completeFields()),
    understanding({ idade: 36 }),
  ]);
  const pending = await harness.agent.handle(message());
  await waitForCalls(harness.client, 1);
  const corrected = await harness.agent.handle(message("Na verdade tenho 36 anos", "msg-correction"));
  await waitForCalls(harness.client, 2);
  assert.equal(pending.quote_request_id, "quote-request-1");
  assert.equal(corrected.quote_request_id, "quote-request-2");
  await harness.client.succeed(0, 209.9);
  await harness.client.succeed(1, 225.5);
  const [terminal] = await collectTerminal(harness.agent);
  await delay(0);
  const state = await harness.store.load("conversation-1");
  assert.equal(terminal?.quote_request_id, "quote-request-2");
  assert.match(terminal?.text ?? "", /225,50/u);
  assert.equal(state.quote_jobs[0]?.status, "failed");
  assert.equal(state.quote_jobs[0]?.failure_reason, "superseded_by_correction");
  assert.equal(state.quote_jobs[1]?.status, "delivered");
  assert.equal(state.outbox.length, 1);
});

test("handoff humano vence um resultado tardio", async (context) => {
  const harness = await makeDeferredHarness(context, [
    understanding(completeFields()),
    understanding({}, "human"),
  ]);
  await harness.agent.handle(message());
  await waitForCalls(harness.client, 1);
  const handoff = await harness.agent.handle(message("Quero falar com uma pessoa", "msg-human"));
  assert.equal(handoff.outcome, "handoff");
  await harness.client.succeed(0, 209.9);
  await harness.agent.waitForIdle("conversation-1");
  const state = await harness.store.load("conversation-1");
  assert.equal(state.stage, "handoff");
  assert.equal(state.quote, null);
  assert.equal(state.outbox.length, 0);
  assert.equal(state.quote_jobs[0]?.failure_reason, "human_requested");
  assert.match(await readFile(harness.auditPath, "utf8"), /quote_ignored/u);
});

test("processo retomado relança pending com a mesma correlação", async (context) => {
  const harness = await makeDeferredHarness(context, [understanding(completeFields())]);
  const pending = await harness.agent.handle(message());
  await waitForCalls(harness.client, 1);
  const resumedClient = new DeferredQuoteClient();
  const resumed = new AutoSeguroAgent(
    new FileConversationStore(harness.stateDirectory),
    new AuditLog(harness.auditPath),
    new StubLlm([]),
    resumedClient,
  );
  assert.equal(await resumed.resume("conversation-1"), true);
  await waitForCalls(resumedClient, 1);
  assert.equal(resumedClient.calls[0]?.requestId, pending.quote_request_id);
  await resumedClient.succeed(0, 209.9);
  const [terminal] = await collectTerminal(resumed);
  assert.equal(terminal?.outcome, "resolved");
  assert.equal(terminal?.quote_request_id, pending.quote_request_id);
  await harness.client.succeed(0, 999.99);
  await harness.agent.waitForIdle("conversation-1");
  const state = await harness.store.load("conversation-1");
  assert.equal(state.quote?.premio_mensal, 209.9);
  assert.equal(state.outbox.length, 1);
});

test("conversa retomada carrega campos ainda incompletos", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding({ plano: "completo", idade: 35 })],
    () => ({ status: 200, body: successfulQuote() }),
  );
  const first = await harness.agent.handle(message("Quero o Completo e tenho 35 anos", "msg-1"));
  assert.equal(first.outcome, "awaiting_data");
  const resumed = new AutoSeguroAgent(
    new FileConversationStore(harness.stateDirectory),
    new AuditLog(harness.auditPath),
    new StubLlm([understanding({ veiculo_ano: 2022, cep: "01310-100", data_inicio: "2026-09-01" })]),
    new QuoteClient({ baseUrl: harness.baseUrl, timeoutMs: 100, baseBackoffMs: 1, jitterMs: 0 }),
    { createId: () => "quote-request-resumed" },
  );
  const pending = await resumed.handle(message("Carro 2022, CEP 01310-100, início 2026-09-01", "msg-2"));
  const [terminal] = await collectTerminal(resumed);
  assert.equal(pending.outcome, "awaiting_data");
  assert.equal(terminal?.outcome, "resolved");
  assert.equal(harness.requests.length, 1);
});

test("auditoria mascara PII e registra o ciclo assíncrono", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 200, body: successfulQuote() }),
  );
  const raw = "CPF 123.456.789-00, telefone +55 11 99999-8888, eu@exemplo.com, CEP 01310-100";
  await harness.agent.handle(message(raw));
  await collectTerminal(harness.agent);
  const log = await readFile(harness.auditPath, "utf8");
  assert.doesNotMatch(log, /123\.456\.789-00|\+55 11 99999-8888|eu@exemplo\.com|01310-100/u);
  assert.match(log, /01\*\*\*-\*\*\*/u);
  assert.match(log, /"quote_status":"pending"/u);
  assert.match(log, /"quote_status":"delivered"/u);
  for (const event of log.trim().split("\n").map((line) => JSON.parse(line))) {
    assert.deepEqual(
      Object.keys(event).toSorted(),
      [
        "attempt",
        "collected_fields",
        "conversation_id",
        "csat_rating",
        "event",
        "failure_kind",
        "handoff_reason",
        "http_status",
        "latency_ms",
        "message_id",
        "outcome",
        "quote_request_id",
        "quote_status",
        "stage",
        "timestamp",
      ].toSorted(),
    );
  }
});

test("mídia sem transcrição vai para handoff sem chamar a API", async (context) => {
  const harness = await makeHarness(
    context,
    [],
    () => ({ status: 200, body: successfulQuote() }),
  );
  const reply = await harness.agent.handle({ ...message("[audio] mensagem de voz"), message_type: "audio" });
  assert.equal(reply.outcome, "handoff");
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.llm.understandCalls, 0);
});

test("validação bloqueia campos inválidos antes da API", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields({ data_inicio: "2026-02-30" }))],
    () => ({ status: 200, body: successfulQuote() }),
  );
  const reply = await harness.agent.handle(message());
  assert.equal(reply.outcome, "awaiting_data");
  assert.match(reply.text, /data de início inválido/u);
  assert.equal(harness.requests.length, 0);
});

test("cliente OpenAI-compatible remove PII antes de chamar o provedor", async () => {
  let requestBody = "";
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            fields: { idade: 35 },
            intent: "continue",
            ambiguous: false,
          }),
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const llm = new OpenAICompatibleLlm({
    baseUrl: "https://llm.example/v1",
    apiKey: "test-key",
    model: "test-model",
  }, fetcher);
  const result = await llm.understand({
    text: "Tenho 35 anos, CPF 123.456.789-00, +55 11 99999-8888 e eu@exemplo.com",
    missing_fields: ["idade"],
    current_date: "2026-08-28",
  });
  assert.equal(result.fields.idade, 35);
  assert.doesNotMatch(requestBody, /123\.456\.789-00|\+55 11 99999-8888|eu@exemplo\.com/u);
  assert.match(requestBody, /cpf_redacted|phone_redacted|email_redacted/u);
});

test("redação de PII preserva IDs de correlação", () => {
  const requestId = "7a466a1e-2f61-4eda-be04-e89367271429";
  assert.equal(redactSensitiveText(requestId), requestId);
  assert.equal(redactSensitiveText("CPF 123.456.789-00"), "CPF <cpf_redacted>");
  assert.equal(redactSensitiveText("Telefone +55 11 99999-8888"), "Telefone <phone_redacted>");
});

test("saúda uma vez e coleta um campo por vez com a lista de planos", async (context) => {
  const harness = await makeDeferredHarness(context, [understanding({})]);
  const first = await harness.agent.handle(message("Oi", "msg-greeting"));
  assert.match(first.text, /Eu sou a AutoSeguro/u);
  assert.deepEqual(first.interaction?.actions.map((action) => action.id), ["plan_essencial", "plan_completo", "plan_premium"]);
  const plan = await harness.agent.handle({ ...message("Completo", "msg-plan"), action: "plan_completo" });
  assert.match(plan.text, /Qual é a sua idade/u);
  assert.doesNotMatch(plan.text, /Eu sou a AutoSeguro/u);
  assert.equal((await harness.store.load("conversation-1")).fields.plano?.value, "completo");
});

test("novo orçamento e ajuda humana usam ações determinísticas", async (context) => {
  const harness = await makeHarness(context, [understanding(completeFields())], () => ({ status: 200, body: successfulQuote() }));
  await harness.agent.handle(message());
  await collectTerminal(harness.agent);
  const next = await harness.agent.handle({ ...message("Nova cotação", "msg-new"), action: "quote_new" });
  assert.equal(next.interaction?.kind, "list");
  const help = await harness.agent.handle({ ...message("Falar com uma pessoa", "msg-help"), action: "human_help" });
  assert.equal(help.outcome, "handoff");
  assert.equal((await harness.store.load("conversation-1")).awaiting_csat, false);
});

for (const [action, rating] of [["csat_great", "great"], ["csat_regular", "regular"], ["csat_bad", "bad"]] as const) {
  test(`encerra uma cotação resolvida e persiste CSAT ${rating}`, async (context) => {
    const harness = await makeHarness(context, [understanding(completeFields())], () => ({ status: 200, body: successfulQuote() }));
    await harness.agent.handle(message());
    await collectTerminal(harness.agent);
    const question = await harness.agent.handle({ ...message("Encerrar atendimento", "msg-end"), action: "service_end" });
    assert.deepEqual(question.interaction?.actions.map((item) => item.id), ["csat_great", "csat_regular", "csat_bad"]);
    const thanks = await harness.agent.handle({ ...message(rating, `msg-${action}`), action });
    assert.match(thanks.text, /Obrigado pela avaliação/u);
    const state = await harness.store.load("conversation-1");
    assert.equal(state.stage, "closed");
    assert.equal(state.csat_rating, rating);
    const events = (await readFile(harness.auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.at(-1), expectCsat(rating));
  });
}

function expectCsat(rating: "great" | "regular" | "bad"): Record<string, unknown> {
  return {
    event: "csat",
    conversation_id: "conversation-1",
    message_id: `msg-csat_${rating}`,
    timestamp: "2026-08-28T12:00:00.000Z",
    stage: "closed",
    collected_fields: {
      plano: { value: "completo", origin: { message_id: "msg-1", source: "llm" } },
      idade: { value: 35, origin: { message_id: "msg-1", source: "llm" } },
      veiculo_ano: { value: 2022, origin: { message_id: "msg-1", source: "llm" } },
      cep: { value: "01***-***", origin: { message_id: "msg-1", source: "llm" } },
      data_inicio: { value: "2026-09-01", origin: { message_id: "msg-1", source: "llm" } },
    },
    quote_request_id: "quote-request-1",
    quote_status: "delivered",
    attempt: null,
    latency_ms: null,
    http_status: null,
    outcome: "resolved",
    handoff_reason: null,
    failure_kind: null,
    csat_rating: rating,
  };
}

test("mensagens ao cliente ocultam termos técnicos e IDs internos", async (context) => {
  const requestId = "7a466a1e-2f61-4eda-be04-e89367271429";
  const finalRequestId = "9e6ab6f3-a24e-4dd9-bf69-5d3d08a5fdc5";
  const ids = [requestId, finalRequestId];
  const happy = await makeDeferredHarness(context, [
    understanding(completeFields()),
    understanding({}, "status"),
    understanding({ plano: "premium" }, "information"),
    understanding({ idade: 36 }),
  ], () => ids.shift() ?? finalRequestId);
  const visible = [
    await happy.agent.handle(message()),
    await happy.agent.handle(message("Já conseguiu?", "msg-status")),
    await happy.agent.handle(message("E as coberturas?", "msg-information")),
    await happy.agent.handle(message("Na verdade tenho 36 anos", "msg-correction")),
  ];
  await waitForCalls(happy.client, 2);
  await happy.client.succeed(1, 225.5);
  visible.push(...await collectTerminal(happy.agent));
  visible.push(await happy.agent.handle(message("Quero ver minha cotação", "msg-resolved")));
  visible.push(await happy.agent.handle({ ...message("Encerrar atendimento", "msg-end"), action: "service_end" }));
  visible.push(await happy.agent.handle({ ...message("Ótimo", "msg-csat"), action: "csat_great" }));
  visible.push(await happy.agent.handle(message("Oi", "msg-closed")));

  const refused = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 422, body: { error: "cotacao_recusada" } }),
  );
  visible.push(await refused.agent.handle(message()));
  visible.push(...await collectTerminal(refused.agent));

  const failed = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 503, body: { error: "upstream_unavailable" } }),
  );
  visible.push(await failed.agent.handle(message()));
  visible.push(...await collectTerminal(failed.agent));

  const customerText = visible.map((reply) => reply.text).join("\n");
  assert.doesNotMatch(customerText, /\b(?:api|http|retry|attempts?|tentativas?|processamento|protocolo)\b|segundo plano|background/iu);
  assert.doesNotMatch(customerText, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu);
  assert.match(customerText, /Referência: [0-9a-f]{8}/u);
  const state = await happy.store.load("conversation-1");
  assert.equal(state.active_quote_request_id, finalRequestId);
  const audit = await readFile(happy.auditPath, "utf8");
  assert.match(audit, new RegExp(requestId, "u"));
  assert.match(audit, new RegExp(finalRequestId, "u"));
});
