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
import { QuoteClient } from "../src/quote-client.ts";
import type {
  CandidateFields,
  IncomingMessage,
  LanguageModel,
  LanguageUnderstanding,
  QuotePayload,
  UnderstandingInput,
  ReplyInput,
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

function understanding(fields: CandidateFields): LanguageUnderstanding {
  return { fields, intent: "continue", ambiguous: false };
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

function successfulQuote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
  const store = new FileConversationStore(join(directory, "state"));
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
  return {
    agent: new AutoSeguroAgent(store, new AuditLog(auditPath), llm, client, {
      createId: () => "quote-request-1",
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    }),
    store,
    auditPath,
    requests: server.requests,
    llm,
    baseUrl: server.baseUrl,
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

test("cotação feliz usa somente o preço devolvido pela API", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 200, body: successfulQuote() }),
  );
  const reply = await harness.agent.handle(message());
  assert.equal(reply.outcome, "resolved");
  assert.match(reply.text, /209,90/u);
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.requests[0]?.payload, {
    plano_id: "completo",
    idade: 35,
    veiculo_ano: 2022,
    cep: "01310-100",
    data_inicio: "2026-09-01",
  });
  assert.equal(harness.requests[0]?.requestId, "quote-request-1");
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
  const reply = await harness.agent.handle(message());
  assert.equal(harness.requests[0]?.payload.cep, "07123-456");
  assert.match(reply.text, /272,87/u);
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
    const reply = await harness.agent.handle(message());
    const state = await harness.store.load("conversation-1");
    assert.equal(reply.outcome, "handoff");
    assert.match(reply.text, /API recusou/u);
    assert.doesNotMatch(reply.text, /R\$/u);
    assert.equal(harness.requests.length, 1);
    assert.equal(state.stage, "handoff");
    assert.equal(state.handoff_reason, "quote_refused");
    assert.equal(state.quote_request_id, "quote-request-1");
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
  const reply = await harness.agent.handle(message());
  assert.match(reply.text, /111,95/u);
  assert.equal(harness.requests[0]?.payload.data_inicio, "2026-09-15");
});

test("timeout é repetido e a segunda tentativa pode resolver", async (context) => {
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
  const reply = await harness.agent.handle(message());
  assert.equal(reply.outcome, "resolved");
  assert.equal(harness.requests.length, 2);
  const events = (await readFile(harness.auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.filter((event) => event.event === "quote_attempt").map((event) => event.failure_kind), ["timeout", null]);
});

test("500, 502 e 503 esgotam três tentativas e criam handoff", async (context) => {
  const statuses = [500, 502, 503];
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    (attempt) => ({ status: statuses[attempt - 1] ?? 503, body: { error: "upstream_unavailable" } }),
  );
  const reply = await harness.agent.handle(message());
  const state = await harness.store.load("conversation-1");
  assert.equal(reply.outcome, "handoff");
  assert.match(reply.text, /não vou estimar um preço/u);
  assert.equal(harness.requests.length, 3);
  assert.equal(state.handoff_reason, "quote_service_unavailable");
});

test("payload inválido não gera retry", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 400, body: { error: "payload_invalido" } }),
  );
  const reply = await harness.agent.handle(message());
  const state = await harness.store.load("conversation-1");
  assert.equal(reply.outcome, "handoff");
  assert.equal(harness.requests.length, 1);
  assert.equal(state.handoff_reason, "invalid_quote_payload");
});

test("mensagem duplicada não dispara uma segunda cotação", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 200, body: successfulQuote() }),
  );
  const incoming = message();
  const [first, concurrentDuplicate] = await Promise.all([
    harness.agent.handle(incoming),
    harness.agent.handle(incoming),
  ]);
  const persistedDuplicate = await harness.agent.handle(incoming);
  assert.deepEqual(concurrentDuplicate, first);
  assert.deepEqual(persistedDuplicate, first);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.llm.understandCalls, 1);
});

test("conversa retomada carrega os campos persistidos", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding({ plano: "completo", idade: 35 })],
    () => ({ status: 200, body: successfulQuote() }),
  );
  const first = await harness.agent.handle(message("Quero o Completo e tenho 35 anos", "msg-1"));
  assert.equal(first.outcome, "awaiting_data");
  const resumed = new AutoSeguroAgent(
    new FileConversationStore(join(harness.auditPath, "..", "state")),
    new AuditLog(harness.auditPath),
    new StubLlm([understanding({ veiculo_ano: 2022, cep: "01310-100", data_inicio: "2026-09-01" })]),
    new QuoteClient({ baseUrl: harness.baseUrl, timeoutMs: 100, baseBackoffMs: 1, jitterMs: 0 }),
    { createId: () => "quote-request-1" },
  );
  const second = await resumed.handle(message("Carro 2022, CEP 01310-100, início 2026-09-01", "msg-2"));
  assert.equal(second.outcome, "resolved");
  assert.equal(harness.requests.length, 1);
});

test("auditoria mascara CPF, telefone, e-mail e CEP", async (context) => {
  const harness = await makeHarness(
    context,
    [understanding(completeFields())],
    () => ({ status: 200, body: successfulQuote() }),
  );
  const raw = "CPF 123.456.789-00, telefone +55 11 99999-8888, eu@exemplo.com, CEP 01310-100";
  await harness.agent.handle(message(raw));
  const log = await readFile(harness.auditPath, "utf8");
  assert.doesNotMatch(log, /123\.456\.789-00|\+55 11 99999-8888|eu@exemplo\.com|01310-100/u);
  assert.match(log, /01\*\*\*-\*\*\*/u);
  for (const event of log.trim().split("\n").map((line) => JSON.parse(line))) {
    assert.deepEqual(
      Object.keys(event).toSorted(),
      [
        "attempt",
        "collected_fields",
        "conversation_id",
        "event",
        "failure_kind",
        "handoff_reason",
        "http_status",
        "latency_ms",
        "message_id",
        "outcome",
        "quote_request_id",
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
