#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
} from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import http, { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { planCatalog } from "../../../src/plan-catalog.ts";
import { maskCep, redactSensitiveText } from "../../../src/privacy.ts";

const skillDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(skillDirectory, "../../..");
const helperPath = fileURLToPath(import.meta.url);
const manifestPath = join(skillDirectory, "scenarios.json");
const metaWabaId = "917767274033519";
const metaPhoneNumberId = "946560951879475";
const fakeRecipient = "15555550199";
const appSecret = "verify-local-app-secret";
const verifyToken = "verify-local-challenge";
const featureScenarios = {
  "greeting-plan-selection": "correction-reselection-date-handling-01",
  "progressive-quote-success": "progressive-happy-success-01",
  "pending-async-delivery": "complete-input-success-01",
  "failure-handoff": "exhausted-infrastructure-handoff-01",
  "ending-csat": "close-csat-channel-fallback-parity-04",
  "quote-hire": "close-csat-channel-fallback-parity-20",
};
const expectedFamilies = [
  "progressive-happy-success",
  "complete-input-success",
  "timeout-recovery",
  "5xx-recovery",
  "exhausted-infrastructure-handoff",
  "eligibility-refusal",
  "correction-reselection-date-handling",
  "duplicate-resume-late-result-races",
  "human-media-ambiguity-handoff",
  "close-csat-channel-fallback-parity",
];
const expectedActions = [
  "quote_start",
  "plans_view",
  "human_help",
  "quote_new",
  "service_end",
  "csat_great",
  "csat_regular",
  "csat_bad",
  "plan_essencial",
  "plan_completo",
  "plan_premium",
  "date_today",
  "date_tomorrow",
  "date_other",
  "quote_hire",
];
const forbiddenCopy = /\b(?:api|http|retries?|attempts?|tentativas?|tentativa|protocolo|uuid|job|jobs|processamento)\b|segundo plano|background/iu;
const uuidPattern = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/iu;
let interruptedSignal = null;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
}

function evidenceText(value) {
  return redactSensitiveText(String(value))
    .replaceAll(fakeRecipient, "<phone_redacted>")
    .replace(/\b(\d{2})\d{3}-?\d{3}\b(?!-[0-9a-f]{4}-)/giu, "$1***-***");
}

function sanitize(value, key = "") {
  if (["authorization", "access_token", "app_secret", "verify_token", "phone_number_id", "to", "from"].includes(key.toLowerCase())) {
    return "<redacted>";
  }
  if (key.toLowerCase() === "cep") {
    return maskCep(String(value));
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  }
  return typeof value === "string" ? evidenceText(value) : value;
}

function jsonLine(value) {
  return `${JSON.stringify(sanitize(value))}\n`;
}

function isLoopback(url) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
}

function installNetworkFence() {
  const graphBase = process.env.VERIFY_GRAPH_BASE_URL;
  assert.ok(graphBase, "VERIFY_GRAPH_BASE_URL ausente");
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const source = input instanceof Request ? input.url : String(input);
    const sourceUrl = new URL(source);
    let targetUrl = sourceUrl;
    if (sourceUrl.protocol === "https:" && sourceUrl.hostname === "graph.facebook.com") {
      targetUrl = new URL(`${graphBase.replace(/\/$/u, "")}${sourceUrl.pathname}${sourceUrl.search}`);
    }
    if (!isLoopback(targetUrl)) {
      throw new Error(`verification network fence blocked ${targetUrl.hostname}`);
    }
    const target = input instanceof Request ? new Request(targetUrl, input) : targetUrl;
    return nativeFetch(target, init);
  };
  const nativeListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    if (typeof args[0] === "object" && args[0] !== null) {
      args[0] = { ...args[0], host: "127.0.0.1" };
    } else if (typeof args[1] === "string") {
      args[1] = "127.0.0.1";
    } else {
      args.splice(1, 0, "127.0.0.1");
    }
    return nativeListen.apply(this, args);
  };
}

async function bootServer() {
  installNetworkFence();
  await import(pathToFileURL(join(repoRoot, "src/server.ts")).href);
}

async function bootCli() {
  installNetworkFence();
  process.argv = [process.execPath, join(repoRoot, "src/cli.ts"), ...process.argv.slice(3)];
  await import(pathToFileURL(join(repoRoot, "src/cli.ts")).href);
}

async function bodyOf(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    assert.ok(bytes <= 1_000_000, "fake peer request too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, body) {
  if (response.destroyed) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inferUnderstanding(input) {
  const text = String(input.mensagem ?? "");
  const normalized = normalize(text);
  if (/falar com|atendente|pessoa do time/u.test(normalized)) {
    return { fields: {}, intent: "human", ambiguous: false };
  }
  if (/financiamento|seguro residencial|fora do escopo/u.test(normalized)) {
    return { fields: {}, intent: "unsupported", ambiguous: false };
  }
  if (/talvez|nao sei se/u.test(normalized)) {
    return { fields: {}, intent: "continue", ambiguous: true };
  }
  if (/conseguiu|andamento|demora/u.test(normalized)) {
    return { fields: {}, intent: "status", ambiguous: false };
  }
  if (/cobertura|franquia|plano inclui/u.test(normalized)) {
    return { fields: {}, intent: "information", ambiguous: false };
  }
  const fields = {};
  const plan = normalized.match(/\b(essencial|completo|premium)\b/u)?.[1];
  const age = normalized.match(/\b(?:tenho|idade[: ]*)\s*(\d{1,3})\s*anos?\b/u)?.[1];
  const year = normalized.match(/\b(?:carro|veiculo)(?:\s+(?:e|de|ano))?\s*(\d{4})\b/u)?.[1];
  const cep = text.match(/\b(\d{5}-?\d{3})\b/u)?.[1];
  const ptBrDate = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/u);
  const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/u)?.[1];
  if (plan) fields.plano = plan;
  if (age) fields.idade = Number(age);
  if (year) fields.veiculo_ano = Number(year);
  if (cep) fields.cep = cep;
  if (ptBrDate) fields.data_inicio = `${ptBrDate[3]}-${ptBrDate[2]}-${ptBrDate[1]}`;
  if (isoDate) fields.data_inicio = isoDate;
  if (/\bamanha\b/u.test(normalized)) fields.data_inicio = addDays(input.data_atual, 1);
  if (/\bhoje\b/u.test(normalized)) fields.data_inicio = input.data_atual;
  if (/^\d+$/u.test(normalized)) {
    const missing = input.campos_faltantes?.[0];
    if (missing === "plano") fields.plano = ["essencial", "completo", "premium"][Number(normalized) - 1];
    if (missing === "data_inicio" && normalized === "1") fields.data_inicio = input.data_atual;
    if (missing === "data_inicio" && normalized === "2") fields.data_inicio = addDays(input.data_atual, 1);
  }
  return { fields, intent: "continue", ambiguous: false };
}

const officialPlans = {
  essencial: { name: "Essencial", base: 119.9, deductible: 4500, coverages: ["colisao", "roubo", "furto"] },
  completo: { name: "Completo", base: 209.9, deductible: 3000, coverages: ["colisao", "roubo", "furto", "terceiros", "vidros"] },
  premium: { name: "Premium", base: 339.9, deductible: 1500, coverages: ["colisao", "roubo", "furto", "terceiros", "vidros", "carro_reserva", "assistencia_24h"] },
};

function officialQuote(payload) {
  const plan = officialPlans[payload.plano_id];
  if (!plan) {
    return { status: 422, body: { error: "cotacao_recusada", motivo: "Plano inexistente." } };
  }
  if (payload.idade > 75) {
    return { status: 422, body: { error: "cotacao_recusada", motivo: "Idade acima do limite de aceitacao (75 anos)." } };
  }
  const vehicleAge = new Date().getUTCFullYear() - payload.veiculo_ano;
  if (vehicleAge > 20) {
    return { status: 422, body: { error: "cotacao_recusada", motivo: "Veiculo com mais de 20 anos nao e aceito." } };
  }
  const ageMultiplier = payload.idade < 25 ? 1.6 : payload.idade < 30 ? 1.25 : payload.idade < 60 ? 1 : 1.4;
  const vehicleMultiplier = vehicleAge <= 5 ? 1 : vehicleAge <= 10 ? 1.15 : 1.45;
  const highRisk = ["07", "08", "21", "26", "59"].includes(payload.cep.replace(/\D/gu, "").slice(0, 2));
  const monthly = Math.round(plan.base * ageMultiplier * vehicleMultiplier * (highRisk ? 1.3 : 1) * 100) / 100;
  const body = {
    plano_id: payload.plano_id,
    plano_nome: plan.name,
    premio_mensal: monthly,
    franquia: plan.deductible,
    coberturas: plan.coverages,
    moeda: "BRL",
    carencia: {
      coberturas: plan.coverages.filter((coverage) => ["roubo", "furto"].includes(coverage)),
      dias: 30,
      observacao: "Coberturas de roubo e furto so passam a valer apos a carencia, contada da data de inicio da vigencia.",
    },
  };
  const date = new Date(`${payload.data_inicio}T00:00:00.000Z`);
  if (date.getUTCDate() !== 1) {
    const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const chargedDays = daysInMonth - date.getUTCDate() + 1;
    body.primeiro_pagamento_pro_rata = {
      dias_no_mes: daysInMonth,
      dias_cobrados: chargedDays,
      valor_primeiro_pagamento: Math.round(monthly * chargedDays / daysInMonth * 100) / 100,
    };
  }
  return { status: 200, body };
}

function customerText(payload) {
  if (payload.type === "text") {
    return String(payload.text?.body ?? "");
  }
  if (payload.type === "interactive") {
    return String(payload.interactive?.body?.text ?? "");
  }
  return "";
}

function interactionActions(payload) {
  if (payload.type !== "interactive") {
    return [];
  }
  if (payload.interactive?.type === "button") {
    return (payload.interactive.action?.buttons ?? []).map((item) => item.reply);
  }
  return (payload.interactive?.action?.sections ?? []).flatMap((section) => section.rows ?? []);
}

class FakePeers {
  constructor(evidence) {
    this.evidence = evidence;
    this.server = null;
    this.baseUrl = "";
    this.context = null;
    this.sequence = 0;
  }

  async start() {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.recordResponse("peer-error", 500, { error: error instanceof Error ? error.message : String(error) });
        sendJson(response, 500, { error: "fake_peer_error" });
      });
    });
    await new Promise((resolvePromise, rejectPromise) => {
      this.server.once("error", rejectPromise);
      this.server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = this.server.address();
    assert.ok(address && typeof address !== "string", "fake peer has no TCP address");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  begin(scenario) {
    this.context = {
      scenario,
      channel: "meta",
      graphEvents: [],
      quoteRequests: [],
      llmRequests: [],
      quoteScript: scriptForScenario(scenario),
      failNextInteractive: null,
      failFinal: false,
    };
    return this.context;
  }

  async close() {
    if (!this.server?.listening) return;
    this.server.closeAllConnections();
    await new Promise((resolvePromise) => this.server.close(resolvePromise));
  }

  recordRequest(kind, value) {
    const row = { sequence: ++this.sequence, at: new Date().toISOString(), kind, ...sanitize(value) };
    this.evidence.requests.push(row);
    this.evidence.timeline.push({ ...row, direction: "into-boundary" });
    return row.sequence;
  }

  recordResponse(kind, status, value, requestSequence = null) {
    const row = { sequence: ++this.sequence, request_sequence: requestSequence, at: new Date().toISOString(), kind, status, ...sanitize(value) };
    this.evidence.responses.push(row);
    this.evidence.timeline.push({ ...row, direction: "from-boundary" });
  }

  async handle(request, response) {
    const url = new URL(request.url ?? "/", this.baseUrl);
    if (request.method === "GET" && url.pathname === "/doctor") {
      sendJson(response, 200, { service: "verify-autoseguro-local-peer", network: "loopback-only" });
      return;
    }
    const context = this.context;
    assert.ok(context, "fake peer has no journey context");
    const raw = await bodyOf(request);
    const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    if (url.pathname === "/llm/v1/chat/completions") {
      await this.handleLlm(context, body, response);
      return;
    }
    if (url.pathname === "/quote-service/quote") {
      await this.handleQuote(context, request, body, response);
      return;
    }
    if (url.pathname === "/quote-service/planos") {
      sendJson(response, 200, {
        moeda: "BRL",
        planos: [
          { id: "essencial", nome: "Essencial", base_mensal: 119.9, franquia: 4500, coberturas: ["colisao", "roubo", "furto"] },
          { id: "completo", nome: "Completo", base_mensal: 209.9, franquia: 3000, coberturas: ["colisao", "roubo", "furto", "terceiros", "vidros"] },
          { id: "premium", nome: "Premium", base_mensal: 339.9, franquia: 1500, coberturas: ["colisao", "roubo", "furto", "terceiros", "vidros", "carro_reserva", "assistencia_24h"] },
        ],
        regras: {
          carencia: {
            coberturas_com_carencia: ["roubo", "furto"],
            dias: 30,
          },
        },
      });
      return;
    }
    if (url.pathname === `/graph/v25.0/${metaPhoneNumberId}/messages`) {
      await this.handleGraph(context, body, response);
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  async handleLlm(context, body, response) {
    const content = body.messages?.at(-1)?.content;
    const input = typeof content === "string" ? JSON.parse(content) : {};
    const requestSequence = this.recordRequest("llm", {
      journey_id: context.scenario.id,
      channel: context.channel,
      input,
      model: body.model,
    });
    context.llmRequests.push(input);
    if (context.scenario.variant === "llm-unavailable") {
      this.recordResponse("llm", 503, { journey_id: context.scenario.id }, requestSequence);
      sendJson(response, 503, { error: "local_failure" });
      return;
    }
    const answer = Object.hasOwn(input, "draft") ? String(input.draft) : JSON.stringify(inferUnderstanding(input));
    this.recordResponse("llm", 200, { journey_id: context.scenario.id, answer }, requestSequence);
    sendJson(response, 200, { choices: [{ message: { content: answer } }] });
  }

  async handleQuote(context, request, payload, response) {
    const attempt = context.quoteRequests.length + 1;
    const requestId = Array.isArray(request.headers["x-request-id"])
      ? request.headers["x-request-id"][0]
      : request.headers["x-request-id"];
    const requestSequence = this.recordRequest("quote", {
      journey_id: context.scenario.id,
      channel: context.channel,
      attempt,
      quote_request_id: requestId,
      payload,
    });
    context.quoteRequests.push({ attempt, requestId, payload: structuredClone(payload), channel: context.channel });
    const step = context.quoteScript[Math.min(attempt - 1, context.quoteScript.length - 1)] ?? { kind: "success" };
    if (step.delayMs) await delay(step.delayMs);
    if (step.kind === "network") {
      this.recordResponse("quote", 0, { journey_id: context.scenario.id, result: "connection-closed" }, requestSequence);
      request.socket.destroy();
      return;
    }
    if (step.kind === "invalid") {
      this.recordResponse("quote", 200, { journey_id: context.scenario.id, result: "invalid-contract" }, requestSequence);
      sendJson(response, 200, { invalid: true });
      return;
    }
    if (step.kind === "status") {
      this.recordResponse("quote", step.status, { journey_id: context.scenario.id }, requestSequence);
      sendJson(response, step.status, { error: "local_scenario" });
      return;
    }
    const result = officialQuote(payload);
    this.recordResponse("quote", result.status, { journey_id: context.scenario.id, body: result.body }, requestSequence);
    sendJson(response, result.status, result.body);
  }

  async handleGraph(context, payload, response) {
    const presence = payload.status === "read";
    const interactionKind = payload.interactive?.type ?? null;
    const text = customerText(payload);
    let status = 200;
    if (!presence && context.failNextInteractive !== null && context.failNextInteractive === interactionKind) {
      context.failNextInteractive = null;
      status = 500;
    }
    if (!presence && context.failFinal && /Sua cotação está pronta|Não consegui concluir|Não foi possível seguir/u.test(text)) {
      status = 500;
    }
    const requestSequence = this.recordRequest("meta-graph", {
      journey_id: context.scenario.id,
      channel: context.channel,
      delivery: presence ? "presence" : "message",
      payload,
    });
    const event = {
      sequence: requestSequence,
      status,
      kind: presence ? "presence" : "outbound",
      payload: structuredClone(payload),
      text,
      interactionKind,
      actions: interactionActions(payload),
    };
    context.graphEvents.push(event);
    if (status >= 400) {
      this.recordResponse("meta-graph", status, { journey_id: context.scenario.id, error_code: 131000 }, requestSequence);
      sendJson(response, status, { error: { code: 131000, error_subcode: 249999 } });
      return;
    }
    if (presence) {
      this.recordResponse("meta-graph", 200, { journey_id: context.scenario.id, success: true }, requestSequence);
      sendJson(response, 200, { success: true });
      return;
    }
    const outboundId = `local-out-${context.scenario.id}-${context.graphEvents.length}`;
    event.outboundId = outboundId;
    this.recordResponse("meta-graph", 200, { journey_id: context.scenario.id, outbound_id: sha256(outboundId) }, requestSequence);
    sendJson(response, 200, { messages: [{ id: outboundId }] });
  }
}

function scriptForScenario(scenario) {
  if (scenario.family === "timeout-recovery") {
    return [{ kind: "success", delayMs: 120 }, { kind: "success" }];
  }
  if (scenario.family === "complete-input-success") {
    return [{ kind: "success", delayMs: 200 }];
  }
  if (scenario.family === "5xx-recovery") {
    const scripts = {
      "500-then-success": [500],
      "502-then-success": [502],
      "503-then-success": [503],
      "500-502-then-success": [500, 502],
    };
    return [...scripts[scenario.variant].map((status) => ({ kind: "status", status })), { kind: "success" }];
  }
  if (scenario.family === "exhausted-infrastructure-handoff") {
    if (scenario.variant === "timeout-timeout-timeout") return Array.from({ length: 3 }, () => ({ kind: "success", delayMs: 120 }));
    if (scenario.variant === "network") return [{ kind: "network" }];
    if (scenario.variant === "invalid-response") return [{ kind: "invalid" }];
    if (scenario.variant === "http-400") return [{ kind: "status", status: 400 }];
    if (scenario.variant === "http-401") return [{ kind: "status", status: 401 }];
    return scenario.variant.split("-").map((status) => ({ kind: "status", status: Number(status) }));
  }
  if (scenario.family === "duplicate-resume-late-result-races" && ["resume-pending", "late-human-result"].includes(scenario.variant)) {
    return [{ kind: "success", delayMs: 500 }, { kind: "success" }];
  }
  if (scenario.family === "correction-reselection-date-handling" && scenario.variant === "pending-correction") {
    return [{ kind: "success", delayMs: 300 }, { kind: "success" }];
  }
  return [{ kind: "success", delayMs: 20 }];
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "failed to reserve a loopback port");
  const port = address.port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitUntil(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (interruptedSignal) throw new Error(`interrupted by ${interruptedSignal}`);
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(10);
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function stopChild(child, transcript, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await transcript(`cleanup: SIGTERM ${label} pid=${child.pid}`);
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    delay(2_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    await transcript(`cleanup: SIGKILL ${label} pid=${child.pid}`);
    child.kill("SIGKILL");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
}

function curatedEnv(peer, stateDirectory, auditPath, intakeDirectory, port, revision, quoteTimeoutMs = 40) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? repoRoot,
    LANG: "C.UTF-8",
    PORT: String(port),
    REVISION: revision,
    STATE_DIR: stateDirectory,
    AUDIT_LOG_PATH: auditPath,
    META_INTAKE_DIR: intakeDirectory,
    LLM_BASE_URL: `${peer.baseUrl}/llm/v1`,
    LLM_API_KEY: "verify-local-key",
    LLM_MODEL: "verify-local-model",
    LLM_TIMEOUT_MS: "1000",
    QUOTE_API_URL: `${peer.baseUrl}/quote-service`,
    QUOTE_TIMEOUT_MS: String(quoteTimeoutMs),
    QUOTE_MAX_ATTEMPTS: "3",
    META_WABA_ID: metaWabaId,
    META_PHONE_NUMBER_ID: metaPhoneNumberId,
    META_ACCESS_TOKEN: "verify-local-token",
    META_APP_SECRET: appSecret,
    META_VERIFY_TOKEN: verifyToken,
    META_ALLOWED_RECIPIENT: fakeRecipient,
    META_TYPING_DELAY_MS: "0",
    PUBLIC_BASE_URL: "https://verify.invalid",
    VERIFY_GRAPH_BASE_URL: `${peer.baseUrl}/graph`,
    VERIFY_LOCAL_ONLY: "1",
  };
}

async function launchApp(run, journey, part = 1) {
  const port = await freePort();
  const revision = `${run.build.sha.slice(0, 12)}-${run.build.fingerprint.slice(0, 12)}-${run.runId}-${journey.scenario.id}-${part}`;
  const logPath = join(run.artifactDirectory, "logs", `${journey.scenario.id}-${part}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const descriptor = openSync(logPath, "a", 0o600);
  const quoteTimeoutMs = journey.scenario.family === "complete-input-success" ? 500 : (journey.scenario.family === "duplicate-resume-late-result-races" ? 200 : 40);
  const env = curatedEnv(run.peer, journey.stateDirectory, journey.auditPath, journey.intakeDirectory, port, revision, quoteTimeoutMs);
  const child = spawn(process.execPath, [helperPath, "__server"], {
    cwd: repoRoot,
    env,
    detached: false,
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  run.children.add(child);
  child.once("exit", () => run.children.delete(child));
  await run.transcript(`launch: ${process.execPath} ${relative(repoRoot, helperPath)} __server pid=${child.pid} port=${port} state=${relative(repoRoot, journey.stateDirectory)}`);
  const app = { child, port, revision, env, logPath, part, doctored: false };
  await waitUntil(async () => {
    if (child.exitCode !== null) {
      const log = await readFile(logPath, "utf8").catch(() => "");
      throw new Error(`AutoSeguro exited ${child.exitCode}: ${log.trim()}`);
    }
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
    return response?.ok;
  }, "AutoSeguro launch", 5_000);
  return app;
}

async function doctorApp(run, journey, app) {
  assert.equal(app.env.VERIFY_LOCAL_ONLY, "1");
  assert.ok(app.env.LLM_BASE_URL.startsWith("http://127.0.0.1:"));
  assert.ok(app.env.QUOTE_API_URL.startsWith("http://127.0.0.1:"));
  assert.ok(app.env.VERIFY_GRAPH_BASE_URL.startsWith("http://127.0.0.1:"));
  assert.equal(app.env.META_ACCESS_TOKEN, "verify-local-token");
  assert.equal(app.env.PUBLIC_BASE_URL, "https://verify.invalid");
  assert.equal(app.child.exitCode, null);
  const healthResponse = await fetch(`http://127.0.0.1:${app.port}/health`);
  const health = await healthResponse.json();
  assert.deepEqual(health, { status: "ok", revision: app.revision });
  const challenge = await fetch(`http://127.0.0.1:${app.port}/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=doctor-ok`);
  assert.equal(await challenge.text(), "doctor-ok");
  const peerHealth = await fetch(`${run.peer.baseUrl}/doctor`);
  const peerIdentity = await peerHealth.json();
  assert.deepEqual(peerIdentity, { service: "verify-autoseguro-local-peer", network: "loopback-only" });
  const sockets = execFileSync("ss", ["-ltnp", `sport = :${app.port}`], { encoding: "utf8" });
  assert.match(sockets, new RegExp(`127\\.0\\.0\\.1:${app.port}\\b`, "u"));
  assert.match(sockets, new RegExp(`pid=${app.child.pid}\\b`, "u"));
  assert.doesNotMatch(sockets, new RegExp(`(?:0\\.0\\.0\\.0|\\[::\\]):${app.port}\\b`, "u"));
  const commandLine = (await readFile(`/proc/${app.child.pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  assert.ok(commandLine.includes("__server"));
  await mkdir(journey.stateDirectory, { recursive: true, mode: 0o700 });
  const probe = join(journey.stateDirectory, `.doctor-${run.runId}`);
  await writeFile(probe, "ok\n", { mode: 0o600 });
  await unlink(probe);
  app.doctored = true;
  const result = {
    journey_id: journey.scenario.id,
    part: app.part,
    pid: app.child.pid,
    port: app.port,
    build_sha: run.build.sha,
    build_fingerprint: run.build.fingerprint,
    revision: app.revision,
    health,
    peer_identity: peerIdentity,
    socket_evidence: sockets.trim(),
    process_mode: "verify.mjs __server",
    state_directory: relative(repoRoot, journey.stateDirectory),
    boundary_origins: {
      llm: new URL(app.env.LLM_BASE_URL).origin,
      quote: new URL(app.env.QUOTE_API_URL).origin,
      graph: new URL(app.env.VERIFY_GRAPH_BASE_URL).origin,
    },
    loopback_owned: true,
    test_config: "synthetic-only",
    isolated_state_writable: true,
    live_targets_absent: true,
  };
  run.evidence.doctors.push(result);
  await run.transcript(`doctor: PASS journey=${journey.scenario.id} part=${app.part} revision=${app.revision} loopback=127.0.0.1:${app.port} pid=${app.child.pid}`);
  return result;
}

function webhookBody(message) {
  const payload = {
    from: fakeRecipient,
    id: message.id,
    type: message.type,
  };
  if (message.type === "text") payload.text = { body: message.text };
  else if (message.type === "interactive") payload.interactive = message.interactive;
  else payload[message.type] = { id: `local-${message.type}` };
  return Buffer.from(JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: metaWabaId,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: metaPhoneNumberId },
          messages: [payload],
        },
      }],
    }],
  }));
}

function successfulOutbound(context) {
  return context.graphEvents.filter((event) => event.kind === "outbound" && event.status < 400);
}

function latestInteraction(context, actionId, status = 200) {
  return context.graphEvents.toReversed().find((event) => (
    event.kind === "outbound"
    && event.status === status
    && event.actions.some((action) => action.id === actionId || action.id.startsWith(`${actionId}:`))
  ));
}

class JourneyRuntime {
  constructor(run, scenario) {
    this.run = run;
    this.scenario = scenario;
    this.context = run.peer.begin(scenario);
    this.scratchDirectory = join(run.scratchRoot, scenario.id);
    this.stateDirectory = join(this.scratchDirectory, "state");
    this.auditPath = join(this.scratchDirectory, "audit.jsonl");
    this.intakeDirectory = join(this.scratchDirectory, "intake");
    this.app = null;
    this.part = 0;
    this.messageIndex = 0;
    this.messagesDriven = [];
    this.actions = [];
    this.assertions = [];
    this.startedAt = performance.now();
    this.expectedOperations = 0;
    this.channels = new Set(["meta-rich"]);
  }

  async start() {
    await mkdir(this.scratchDirectory, { recursive: true, mode: 0o700 });
    this.part += 1;
    this.app = await launchApp(this.run, this, this.part);
    await doctorApp(this.run, this, this.app);
  }

  async restart() {
    await this.stopApp();
    await this.start();
  }

  async stopApp() {
    if (!this.app) return;
    await stopChild(this.app.child, this.run.transcript, `AutoSeguro/${this.scenario.id}/${this.app.part}`);
    this.app = null;
  }

  assertOwned() {
    assert.ok(this.app?.doctored, "refusing to drive an instance not owned and doctored by this helper");
    assert.equal(this.app.child.exitCode, null, "owned AutoSeguro process exited before drive");
    assert.ok(this.app.revision.includes(this.run.runId));
  }

  async sendText(text, options = {}) {
    const id = options.id ?? `${this.scenario.id}-${String(++this.messageIndex).padStart(3, "0")}`;
    return this.send({ id, type: "text", text }, options.expectReply ?? true);
  }

  async sendMedia(type) {
    const id = `${this.scenario.id}-${String(++this.messageIndex).padStart(3, "0")}`;
    return this.send({ id, type, text: `[${type}]` }, true);
  }

  async tap(actionId) {
    const offered = successfulOutbound(this.context).at(-1);
    assert.ok(offered, `action ${actionId} was not returned by AutoSeguro`);
    const action = offered.actions.find((candidate) => candidate.id === actionId || candidate.id.startsWith(`${actionId}:`));
    assert.ok(action, `action ${actionId} is missing`);
    this.actions.push(actionId);
    const replyType = offered.interactionKind === "list" ? "list_reply" : "button_reply";
    const id = `${this.scenario.id}-${String(++this.messageIndex).padStart(3, "0")}`;
    return this.send({
      id,
      type: "interactive",
      text: action.title,
      interactive: { type: replyType, [replyType]: { id: action.id, title: action.title } },
      action: action.id,
    }, true);
  }

  async chooseFallback(actionId) {
    const offered = latestInteraction(this.context, actionId, 500);
    assert.ok(offered, `failed rich interaction for ${actionId} was not captured`);
    const index = offered.actions.findIndex((candidate) => candidate.id === actionId || candidate.id.startsWith(`${actionId}:`));
    assert.ok(index >= 0);
    const fallback = successfulOutbound(this.context).toReversed().find((event) => event.payload.type === "text" && event.text.includes(`${index + 1}.`));
    assert.ok(fallback, `numbered fallback for ${actionId} was not delivered`);
    this.channels.add(offered.interactionKind === "list" ? "meta-list-fallback" : "meta-button-fallback");
    return this.sendText(String(index + 1));
  }

  async send(message, expectReply) {
    this.assertOwned();
    const before = successfulOutbound(this.context).length;
    const body = webhookBody(message);
    const signature = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
    this.messagesDriven.push({
      message_id: message.id,
      type: message.type,
      interactive_type: message.interactive?.type ?? null,
      text: evidenceText(message.text),
      action: message.action ?? null,
      signature: "valid-hmac-sha256",
    });
    const started = performance.now();
    const requestSequence = this.run.peer.recordRequest("meta-webhook", {
      journey_id: this.scenario.id,
      method: "POST",
      path: "/webhook",
      message_id: message.id,
      type: message.type,
      text: evidenceText(message.text),
      action: message.action ?? null,
      signature: "valid-hmac-sha256",
    });
    const response = await fetch(`http://127.0.0.1:${this.app.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body,
    });
    const responseText = await response.text();
    this.run.peer.recordResponse("meta-webhook", response.status, {
      journey_id: this.scenario.id,
      body: responseText,
      acknowledgement_ms: Math.round(performance.now() - started),
    }, requestSequence);
    assert.equal(response.status, 200);
    assert.equal(responseText, "EVENT_RECEIVED");
    if (!expectReply) {
      await delay(100);
      assert.equal(successfulOutbound(this.context).length, before);
      return { event: null, startIndex: before };
    }
    const event = await waitUntil(
      () => successfulOutbound(this.context)[before],
      `outbound response for ${message.id}`,
      5_000,
    );
    return { event, startIndex: before };
  }

  async waitForState(predicate, label, timeoutMs = 10_000) {
    return waitUntil(async () => {
      const state = await this.readState().catch(() => null);
      return state && predicate(state) ? state : null;
    }, label, timeoutMs);
  }

  async waitForTerminal(afterVisibleCount, expectedStage) {
    const state = await this.waitForState(
      (candidate) => candidate.stage === expectedStage && candidate.outbox.every((item) => item.delivered_at !== null),
      `${this.scenario.id} terminal state ${expectedStage}`,
      15_000,
    );
    const terminal = await waitUntil(
      () => successfulOutbound(this.context).slice(afterVisibleCount).find((event) => (
        /Sua cotação está pronta|Não consegui concluir|Não foi possível seguir/u.test(event.text)
      )),
      `${this.scenario.id} terminal customer message`,
      5_000,
    );
    return { state, terminal };
  }

  readState() {
    const conversationId = `wa-${sha256(fakeRecipient)}`;
    return readFile(join(this.stateDirectory, `${conversationId}.json`), "utf8").then(JSON.parse);
  }

  async auditEvents() {
    const raw = await readFile(this.auditPath, "utf8").catch(() => "");
    return raw.trim() ? raw.trim().split("\n").map(JSON.parse) : [];
  }

  check(value, label) {
    assert.ok(value, label);
    this.assertions.push(label);
  }
}

function nextMonthDate(day) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day)).toISOString().slice(0, 10);
}

function policyStart(scenario) {
  const today = new Date().toISOString().slice(0, 10);
  const iso = scenario.policy_start_form === "today"
    ? today
    : scenario.policy_start_form === "tomorrow"
      ? addDays(today, 1)
      : nextMonthDate(scenario.policy_start_form === "iso" ? 1 : 15);
  const [year, month, day] = iso.split("-");
  const ptBr = `${day}/${month}/${year}`;
  if (scenario.policy_start_form === "today") return { iso, input: "hoje", action: "date_today" };
  if (scenario.policy_start_form === "tomorrow") return { iso, input: "amanhã", action: "date_tomorrow" };
  if (scenario.policy_start_form === "pt-BR") return { iso, input: ptBr, action: null };
  if (scenario.policy_start_form === "date-other") return { iso, input: ptBr, action: "date_other" };
  return { iso, input: iso, action: null };
}

function scenarioFields(scenario) {
  const vehicleYear = new Date().getUTCFullYear() - scenario.vehicle_age;
  const start = policyStart(scenario);
  return {
    plan: scenario.plan,
    age: scenario.age,
    vehicleYear,
    cep: scenario.cep_risk === "high" ? "07123-456" : "01310-100",
    start,
  };
}

function completeInput(fields) {
  const name = planCatalog[fields.plan].nome;
  return `Quero o ${name}, tenho ${fields.age} anos, veículo ${fields.vehicleYear}, CEP ${fields.cep} e início ${fields.start.input}.`;
}

function assertPlanEducation(runtime, event, planId) {
  const plan = planCatalog[planId];
  runtime.check(event.text.includes(`Plano ${plan.nome}`), `${plan.nome} name shown`);
  for (const coverage of plan.coberturas) runtime.check(event.text.includes(coverage), `${plan.nome} includes ${coverage}`);
  for (const other of Object.values(planCatalog)) {
    for (const coverage of other.coberturas.filter((item) => !plan.coberturas.includes(item))) {
      runtime.check(!event.text.includes(coverage), `${plan.nome} excludes ${coverage}`);
    }
  }
  const deductible = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(plan.franquia);
  runtime.check(event.text.includes(deductible), `${plan.nome} deductible shown`);
  runtime.check(event.text.includes("30 dias"), `${plan.nome} waiting period shown`);
  for (const base of [119.9, 209.9, 339.9]) {
    const price = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(base);
    runtime.check(!event.text.includes(price), `${plan.nome} does not present base price as benefit`);
  }
}

async function selectPlan(runtime, planId, options = {}) {
  if (options.failList) runtime.context.failNextInteractive = "list";
  const plans = await runtime.tap("plans_view");
  if (options.failList) {
    const selected = await runtime.chooseFallback(`plan_${planId}`);
    runtime.check(selected.event.text.includes("idade"), "numbered Meta list choice advances to age");
    return selected;
  }
  const selected = await runtime.tap(`plan_${planId}`);
  assertPlanEducation(runtime, selected.event, planId);
  return selected;
}

async function finishProgressiveFields(runtime, scenario, options = {}) {
  const fields = scenarioFields(scenario);
  await runtime.sendText(String(fields.age));
  await runtime.sendText(String(fields.vehicleYear));
  if (options.failDateButtons) runtime.context.failNextInteractive = "button";
  await runtime.sendText(fields.cep);
  let pending;
  if (fields.start.action === "date_other") {
    if (options.failDateButtons) await runtime.chooseFallback("date_other");
    else await runtime.tap("date_other");
    pending = await runtime.sendText(fields.start.input);
  } else if (fields.start.action && options.failDateButtons) {
    pending = await runtime.chooseFallback(fields.start.action);
  } else if (fields.start.action) {
    pending = await runtime.tap(fields.start.action);
  } else {
    pending = await runtime.sendText(fields.start.input);
  }
  runtime.check(/preparar|cotação/u.test(pending.event.text), "pending reply is customer-visible");
  runtime.check(!/R\$/u.test(pending.event.text), "pending reply has no invented price");
  runtime.expectedOperations += 1;
  const terminal = await runtime.waitForTerminal(pending.startIndex, "resolved");
  assertQuoteContract(runtime, terminal.state, terminal.terminal, fields);
  return terminal;
}

function assertQuoteContract(runtime, state, terminal, fields) {
  const job = state.quote_jobs.at(-1);
  runtime.check(job?.payload.data_inicio === fields.start.iso, "policy start is stored as ISO");
  const [year, month, day] = fields.start.iso.split("-");
  runtime.check(terminal.text.includes(`${day}/${month}/${year}`), "policy start is shown in pt-BR");
  runtime.check(state.quote?.carencia.dias === 30, "30-day waiting period is retained from quote response");
  runtime.check(state.quote?.carencia.coberturas.map(normalize).toSorted().join(",") === "furto,roubo", "waiting period retains the official roubo/furto scope");
  runtime.check(/roubo e furto passam a valer após 30 dias/iu.test(terminal.text), "waiting period is described relative to policy start");
  const effective = addDays(fields.start.iso, 30).split("-").reverse().join("/");
  runtime.check(!terminal.text.includes(effective), "no exact waiting-period effective date is invented");
  const proRataExpected = Number(day) !== 1;
  const proRata = state.quote?.primeiro_pagamento_pro_rata;
  runtime.check(Boolean(proRata) === proRataExpected, "first-payment pro-rata follows policy start day");
  runtime.check(proRataExpected === /Primeiro pagamento proporcional/u.test(terminal.text), "pro-rata presentation matches quote response");
  if (proRata && state.quote) {
    const start = new Date(`${fields.start.iso}T00:00:00.000Z`);
    const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    const chargedDays = daysInMonth - start.getUTCDate() + 1;
    const expectedPayment = Math.round(state.quote.premio_mensal * chargedDays / daysInMonth * 100) / 100;
    runtime.check(proRata.dias_no_mes === daysInMonth && proRata.dias_cobrados === chargedDays, "pro-rata day counts match the policy start");
    runtime.check(proRata.valor_primeiro_pagamento === expectedPayment, "pro-rata first payment matches the official contract");
    const displayedPayment = new Intl.NumberFormat("pt-BR", { style: "currency", currency: state.quote.moeda }).format(expectedPayment);
    runtime.check(terminal.text.includes(displayedPayment), "customer sees the returned pro-rata first payment");
  }
}

async function openProgressive(runtime, scenario, options = {}) {
  const greeting = await runtime.sendText("Oi");
  runtime.check(greeting.event.actions.map((action) => action.id).join(",") === "quote_start,plans_view,human_help", "fresh greeting offers canonical actions");
  if (options.allPlans) {
    await runtime.tap("plans_view");
    const order = ["essencial", "completo", "premium"].filter((plan) => plan !== scenario.plan).concat(scenario.plan);
    for (const [index, plan] of order.entries()) {
      const selected = await runtime.tap(`plan_${plan}`);
      assertPlanEducation(runtime, selected.event, plan);
      if (index < order.length - 1) await runtime.tap("plans_view");
    }
    await runtime.tap("quote_start");
    return;
  }
  if (options.failList) {
    await selectPlan(runtime, scenario.plan, { failList: true });
    return;
  }
  await selectPlan(runtime, scenario.plan);
  await runtime.tap("quote_start");
}

async function driveProgressive(runtime, scenario, options = {}) {
  await openProgressive(runtime, scenario, options);
  return finishProgressiveFields(runtime, scenario, options);
}

async function driveComplete(runtime, scenario) {
  const fields = scenarioFields(scenario);
  const pending = await runtime.sendText(completeInput(fields));
  runtime.check(/Recebi seus dados/u.test(pending.event.text), "complete input gets immediate pending reply");
  runtime.expectedOperations += 1;
  if (scenario.family === "complete-input-success") {
    const index = Number(scenario.id.slice(-2));
    const followUp = await runtime.sendText(index % 2 === 0 ? "E as coberturas?" : "Já conseguiu?");
    runtime.check(/em andamento|coberturas/u.test(followUp.event.text), "pending status or information stays customer-visible");
    runtime.check(!/R\$/u.test(followUp.event.text), "pending follow-up has no invented price");
  }
  const handoffExpected = ["eligibility-refusal", "exhausted-infrastructure-handoff"].includes(scenario.family);
  const terminal = await runtime.waitForTerminal(pending.startIndex, handoffExpected ? "handoff" : "resolved");
  if (handoffExpected) {
    runtime.check(!/R\$/u.test(terminal.terminal.text), "handoff has no price");
  } else {
    assertQuoteContract(runtime, terminal.state, terminal.terminal, fields);
  }
  return terminal;
}

async function driveInfrastructure(runtime, scenario) {
  const terminal = await driveComplete(runtime, scenario);
  const job = terminal.state.quote_jobs.at(-1);
  const expected = {
    "500-502-503": "quote_service_unavailable",
    "503-503-503": "quote_service_unavailable",
    "timeout-timeout-timeout": "quote_timeout",
    network: "quote_network_error",
    "invalid-response": "invalid_quote_response",
    "http-400": "invalid_quote_payload",
    "http-401": "quote_http_401",
  }[scenario.variant];
  runtime.check(terminal.state.handoff_reason === expected, `handoff reason is ${expected}`);
  runtime.check(job?.status === "failed", "failed quote job is persisted");
}

async function driveRealTranscript(runtime, scenario) {
  const greeting = await runtime.sendText("Oi");
  runtime.check(greeting.event.text.includes("AutoSeguro"), "fresh-state greeting is visible");
  const handoff = await runtime.tap("human_help");
  runtime.check(handoff.event.text.includes("pessoa do time"), "handoff is customer-visible before recovery");
  await runtime.restart();
  const recovered = await runtime.sendText("NOVA COTACAO");
  runtime.check(recovered.event.actions.some((action) => action.id === `plan_${scenario.plan}`), "accent-insensitive new quote recovers persisted handoff");
  const selected = await runtime.tap(`plan_${scenario.plan}`);
  assertPlanEducation(runtime, selected.event, scenario.plan);
  await runtime.tap("quote_start");
  return finishProgressiveFields(runtime, scenario);
}

async function driveCorrectionFamily(runtime, scenario) {
  if (scenario.variant === "real-transcript-regression") {
    await driveRealTranscript(runtime, scenario);
    return;
  }
  if (["reselect-all-plans", "quote-new-action"].includes(scenario.variant)) {
    const terminal = await driveProgressive(runtime, scenario, { allPlans: true });
    if (scenario.variant === "quote-new-action") {
      await runtime.tap("quote_new");
      const fields = scenarioFields(scenario);
      const pending = await runtime.sendText(completeInput(fields));
      runtime.expectedOperations += 1;
      await runtime.waitForTerminal(pending.startIndex, "resolved");
    }
    return terminal;
  }
  if (scenario.variant === "past-date-correction") {
    await openProgressive(runtime, scenario);
    const fields = scenarioFields(scenario);
    await runtime.sendText(String(fields.age));
    await runtime.sendText(String(fields.vehicleYear));
    await runtime.sendText(fields.cep);
    const rejected = await runtime.sendText("01/01/2020");
    runtime.check(/data de início inválido/u.test(rejected.event.text), "past policy date is rejected");
    const pending = await runtime.sendText(fields.start.iso);
    runtime.expectedOperations += 1;
    const terminal = await runtime.waitForTerminal(pending.startIndex, "resolved");
    assertQuoteContract(runtime, terminal.state, terminal.terminal, fields);
    return;
  }
  const fields = scenarioFields(scenario);
  const pending = await runtime.sendText(completeInput(fields));
  runtime.expectedOperations += 1;
  await waitUntil(() => runtime.context.quoteRequests.length === 1, "first quote request before correction");
  const correctedAge = fields.age === 64 ? 63 : fields.age + 1;
  const corrected = await runtime.sendText(`Na verdade tenho ${correctedAge} anos.`);
  runtime.check(/Atualizei seus dados/u.test(corrected.event.text), "pending correction starts a replacement quote");
  runtime.expectedOperations += 1;
  const terminal = await runtime.waitForTerminal(corrected.startIndex, "resolved");
  const jobs = terminal.state.quote_jobs;
  runtime.check(jobs.length === 2, "correction persists old and replacement quote jobs");
  runtime.check(jobs[0].failure_reason === "superseded_by_correction", "old quote is superseded");
  runtime.check(jobs[1].status === "delivered", "replacement quote is delivered");
  runtime.check(terminal.state.outbox.length === 1, "late result cannot create a duplicate final");
}

async function sendDuplicate(runtime, text) {
  runtime.assertOwned();
  const id = `${runtime.scenario.id}-duplicate`;
  const before = successfulOutbound(runtime.context).length;
  const message = { id, type: "text", text };
  const body = webhookBody(message);
  const signature = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
  runtime.messagesDriven.push({ message_id: id, type: "text", text: evidenceText(text), action: null, signature: "valid-hmac-sha256" });
  runtime.messagesDriven.push({ message_id: id, type: "text", text: evidenceText(text), action: null, signature: "valid-hmac-sha256", duplicate: true });
  const sendOne = async (copy) => {
    const requestSequence = runtime.run.peer.recordRequest("meta-webhook", {
      journey_id: runtime.scenario.id,
      method: "POST",
      path: "/webhook",
      message_id: id,
      duplicate_copy: copy,
      signature: "valid-hmac-sha256",
    });
    const response = await fetch(`http://127.0.0.1:${runtime.app.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body,
    });
    const responseText = await response.text();
    runtime.run.peer.recordResponse("meta-webhook", response.status, { journey_id: runtime.scenario.id, body: responseText }, requestSequence);
    assert.equal(response.status, 200);
  };
  await Promise.all([sendOne(1), sendOne(2)]);
  await waitUntil(() => successfulOutbound(runtime.context)[before], "deduplicated immediate reply");
  await delay(100);
  runtime.check(successfulOutbound(runtime.context).length === before + 1 || successfulOutbound(runtime.context).length === before + 2, "duplicate webhook emits one immediate and at most one async final");
  runtime.expectedOperations += 1;
  return before;
}

async function driveRaceFamily(runtime, scenario) {
  const fields = scenarioFields(scenario);
  if (scenario.variant === "duplicate") {
    const before = await sendDuplicate(runtime, completeInput(fields));
    const terminal = await runtime.waitForTerminal(before, "resolved");
    runtime.check(runtime.context.quoteRequests.length === 1, "duplicate inbound starts one quote request");
    runtime.check(terminal.state.quote_jobs.length === 1, "duplicate inbound persists one quote operation");
    return;
  }
  if (scenario.variant === "resume-pending") {
    const pending = await runtime.sendText(completeInput(fields));
    runtime.expectedOperations += 1;
    await waitUntil(() => runtime.context.quoteRequests.length === 1, "pending request before restart");
    const requestId = runtime.context.quoteRequests[0].requestId;
    await runtime.restart();
    const terminal = await runtime.waitForTerminal(pending.startIndex, "resolved");
    runtime.check(runtime.context.quoteRequests.length === 2, "restart resumes one pending request");
    runtime.check(runtime.context.quoteRequests.every((request) => request.requestId === requestId), "restart preserves quote correlation");
    runtime.check(terminal.state.quote_jobs.length === 1, "restart does not duplicate quote operation");
    return;
  }
  if (scenario.variant === "resume-outbox") {
    runtime.context.failFinal = true;
    const pending = await runtime.sendText(completeInput(fields));
    runtime.expectedOperations += 1;
    await runtime.waitForState((state) => state.stage === "resolved" && state.outbox.some((message) => message.delivered_at === null), "undelivered final before restart");
    await waitUntil(() => runtime.context.graphEvents.filter((event) => event.kind === "outbound" && event.status === 500).length >= 2, "failed rich and fallback final delivery");
    await runtime.stopApp();
    runtime.context.failFinal = false;
    await runtime.start();
    const terminal = await runtime.waitForTerminal(pending.startIndex, "resolved");
    runtime.check(runtime.context.quoteRequests.length === 1, "outbox restart does not repeat quote call");
    runtime.check(terminal.state.outbox.length === 1, "outbox restart delivers one final message");
    return;
  }
  const pending = await runtime.sendText(completeInput(fields));
  runtime.expectedOperations += 1;
  await waitUntil(() => runtime.context.quoteRequests.length === 1, "quote request before human handoff");
  const handoff = await runtime.sendText("Quero falar com uma pessoa.");
  runtime.check(handoff.event.text.includes("pessoa do time"), "human handoff is customer-visible");
  await delay(550);
  const state = await runtime.readState();
  const audit = await runtime.auditEvents();
  runtime.check(state.stage === "handoff", "late quote result cannot replace human handoff");
  runtime.check(state.quote === null && state.outbox.length === 0, "late quote result is not delivered");
  runtime.check(audit.some((event) => event.event === "quote_ignored"), "late quote result is audited as ignored");
}

async function driveHandoffFamily(runtime, scenario) {
  if (scenario.variant === "human") {
    await runtime.sendText("Oi");
    const reply = await runtime.tap("human_help");
    runtime.check(reply.event.text.includes("pessoa do time"), "human action reaches handoff");
  } else if (scenario.variant === "media") {
    const media = ["audio", "image", "document", "video"][Number(scenario.id.slice(-2)) % 4];
    const reply = await runtime.sendMedia(media);
    runtime.check(reply.event.text.includes("pessoa do time"), "unsupported media reaches handoff");
  } else if (scenario.variant === "unsupported") {
    const reply = await runtime.sendText("Quero financiamento, fora do escopo.");
    runtime.check(reply.event.text.includes("pessoa do time"), "unsupported request reaches handoff");
  } else if (scenario.variant === "repeated-ambiguity") {
    const first = await runtime.sendText("Talvez completo, não sei se é isso.");
    runtime.check(first.event.text.includes("confirmar"), "first ambiguity asks for clarification");
    const second = await runtime.sendText("Talvez, ainda não sei se é isso.");
    runtime.check(second.event.text.includes("pessoa do time"), "second ambiguity reaches handoff");
  } else {
    const reply = await runtime.sendText("Quero cotar meu carro.");
    runtime.check(reply.event.text.includes("pessoa do time"), "LLM outage reaches handoff");
  }
  const state = await runtime.waitForState((candidate) => candidate.stage === "handoff", "handoff persistence");
  runtime.check(runtime.context.quoteRequests.length === 0, "non-quote handoff does not call quote service");
  runtime.check(Boolean(state.handoff_reason), "handoff reason is persisted");
}

function csatAction(variant) {
  return { "csat-great": "csat_great", "csat-regular": "csat_regular", "csat-bad": "csat_bad" }[variant];
}

async function runCliParity(runtime, scenario, metaQuoteState) {
  const fields = scenarioFields(scenario);
  const directory = join(runtime.scratchDirectory, "cli");
  const stateDirectory = join(directory, "state");
  const auditPath = join(directory, "audit.jsonl");
  const replayPath = join(directory, "replay.jsonl");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const planIndex = ["essencial", "completo", "premium"].indexOf(fields.plan) + 1;
  const lines = ["Oi", "2", String(planIndex), "1", String(fields.age), String(fields.vehicleYear), fields.cep];
  if (fields.start.action === "date_other") lines.push("3", fields.start.input);
  else if (fields.start.action === "date_today") lines.push("1");
  else if (fields.start.action === "date_tomorrow") lines.push("2");
  else lines.push(fields.start.input);
  await writeFile(replayPath, `${lines.map((text, index) => JSON.stringify({ message_id: `cli-${scenario.id}-${index + 1}`, message_type: "text", text })).join("\n")}\n`, { mode: 0o600 });
  const logPath = join(runtime.run.artifactDirectory, "logs", `${scenario.id}-cli.log`);
  const port = await freePort();
  const env = curatedEnv(runtime.run.peer, stateDirectory, auditPath, join(directory, "intake"), port, `cli-${runtime.run.runId}`);
  runtime.context.channel = "cli";
  await runtime.run.transcript(`drive-cli: ${process.execPath} ${relative(repoRoot, helperPath)} __cli --conversation cli-${scenario.id} --replay <scratch>`);
  const child = spawn(process.execPath, [helperPath, "__cli", "--conversation", `cli-${scenario.id}`, "--replay", replayPath, "--reset"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtime.run.children.add(child);
  child.once("exit", () => runtime.run.children.delete(child));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal }))),
    delay(20_000).then(() => ({ timeout: true })),
  ]);
  if (result.timeout) await stopChild(child, runtime.run.transcript, `CLI/${scenario.id}`);
  runtime.context.channel = "meta";
  await writeFile(logPath, evidenceText(`${stdout}${stderr}`), { mode: 0o600 });
  assert.ok(!result.timeout, `CLI replay timed out: ${stderr}`);
  assert.equal(result.code, 0, `CLI replay failed: ${stderr}`);
  const output = stdout;
  runtime.check(/1\. Começar cotação/u.test(output), "CLI renders greeting buttons as numbered choices");
  runtime.check(/2\. Comparar planos/u.test(output), "CLI follows numbered greeting choice");
  runtime.check(new RegExp(`${planIndex}\\. ${planCatalog[fields.plan].nome}`, "u").test(output), "CLI renders and follows numbered plan choice");
  runtime.check(/Sua cotação está pronta/u.test(output), "CLI replay reaches the quote result");
  const cliState = JSON.parse(await readFile(join(stateDirectory, `cli-${scenario.id}.json`), "utf8"));
  runtime.check(cliState.stage === "resolved" && metaQuoteState.stage === "resolved", "CLI and Meta reach the same resolved quote state");
  for (const field of ["plano", "idade", "veiculo_ano", "cep", "data_inicio"]) {
    runtime.check(cliState.fields[field]?.value === metaQuoteState.fields[field]?.value, `CLI and Meta persist the same ${field}`);
  }
  runtime.check(cliState.quote_jobs.at(-1)?.status === metaQuoteState.quote_jobs.at(-1)?.status, "CLI and Meta persist the same quote outcome");
  const cliAuditRaw = await readFile(auditPath, "utf8");
  const cliAuditEvents = cliAuditRaw.trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const event of ["quote_started", "quote_completed", "outbox_delivered"]) {
    runtime.check(cliAuditEvents.some((item) => item.event === event), `CLI persists ${event} audit outcome`);
  }
  runtime.channels.add("cli-replay");
  return { output: evidenceText(output), auditEvents: cliAuditEvents };
}

async function driveCloseParity(runtime, scenario) {
  const options = {
    failList: scenario.interaction_format === "meta-list-fallback",
    failDateButtons: scenario.interaction_format === "meta-button-fallback",
  };
  const terminal = await driveProgressive(runtime, scenario, options);
  if (scenario.variant === "quote-hire") {
    const quoteRequestsBefore = runtime.context.quoteRequests.length;
    const previousRequestId = terminal.state.active_quote_request_id;
    const hire = await runtime.tap("quote_hire");
    runtime.check(runtime.messagesDriven.at(-1)?.interactive_type === "list_reply", "quote_hire is sent via list_reply");
    runtime.check(hire.event.text.includes(sha256(previousRequestId).slice(0, 8)), "hire reply includes reference");
    runtime.check(!forbiddenCopy.test(hire.event.text), "hire reply has no forbidden copy");
    runtime.check(!hire.event.text.includes("Não consegui concluir"), "hire reply has no failure text");
    const state = await runtime.waitForState((candidate) => candidate.stage === "handoff", "handoff state after quote_hire");
    runtime.check(state.handoff_reason === "issuance_requested", "handoff reason is issuance_requested");
    runtime.check(state.active_quote_request_id === previousRequestId, "quote request id is preserved");
    runtime.check(state.quote !== null, "quote is preserved after issuance handoff");
    const currentJob = state.quote_jobs.find((job) => job.request_id === previousRequestId);
    runtime.check(currentJob?.status === "delivered", "quote job remains delivered");
    runtime.check(runtime.context.quoteRequests.length === quoteRequestsBefore, "zero new POST /quote after quote_hire");
    const audits = await runtime.auditEvents();
    runtime.check(audits.some((event) => event.event === "handoff" && event.handoff_reason === "issuance_requested"), "issuance handoff is audited");
    return { ...terminal, state };
  }
  const csatQuestion = await runtime.tap("service_end");
  runtime.check(csatQuestion.event.actions.map((action) => action.id).join(",") === "csat_great,csat_regular,csat_bad", "ending offers all CSAT choices");
  const action = csatAction(scenario.variant);
  await runtime.tap(action);
  const state = await runtime.waitForState((candidate) => candidate.stage === "closed", "closed state after CSAT");
  runtime.check(state.csat_rating === action.replace("csat_", ""), "CSAT value is persisted");
  if (scenario.interaction_format === "cli-replay") {
    const cli = await runCliParity(runtime, scenario, terminal.state);
    runtime.cliOutput = cli.output;
    runtime.run.evidence.audits.push(...cli.auditEvents.map((event) => ({ journey_id: scenario.id, channel: "cli", ...event })));
  }
  return terminal;
}

async function driveJourney(runtime) {
  const scenario = runtime.scenario;
  if (scenario.family === "progressive-happy-success") return driveProgressive(runtime, scenario);
  if (scenario.family === "complete-input-success") return driveComplete(runtime, scenario);
  if (scenario.family === "timeout-recovery") return driveComplete(runtime, scenario);
  if (scenario.family === "5xx-recovery") return driveComplete(runtime, scenario);
  if (scenario.family === "exhausted-infrastructure-handoff") return driveInfrastructure(runtime, scenario);
  if (scenario.family === "eligibility-refusal") return driveComplete(runtime, scenario);
  if (scenario.family === "correction-reselection-date-handling") return driveCorrectionFamily(runtime, scenario);
  if (scenario.family === "duplicate-resume-late-result-races") return driveRaceFamily(runtime, scenario);
  if (scenario.family === "human-media-ambiguity-handoff") return driveHandoffFamily(runtime, scenario);
  if (scenario.family === "close-csat-channel-fallback-parity") return driveCloseParity(runtime, scenario);
  throw new Error(`unknown family ${scenario.family}`);
}

function assertCustomerCopy(runtime) {
  const texts = successfulOutbound(runtime.context).map((event) => event.text).filter(Boolean);
  if (runtime.cliOutput) texts.push(runtime.cliOutput);
  for (const text of texts) {
    runtime.check(!forbiddenCopy.test(text), "customer copy has no infrastructure jargon");
    runtime.check(!uuidPattern.test(text), "customer copy has no full UUID");
  }
  return { passed: true, messages_checked: texts.length, forbidden_terms: [], full_uuid: false };
}

function assertDeliveryOrder(runtime) {
  let presenceSeen = false;
  let successfulMessages = 0;
  for (const event of runtime.context.graphEvents) {
    if (event.kind === "presence") {
      presenceSeen = event.status < 400;
      continue;
    }
    if (event.status < 400) {
      runtime.check(presenceSeen, "typing presence precedes each delivered message");
      presenceSeen = false;
      successfulMessages += 1;
    }
  }
  runtime.check(successfulMessages > 0, "journey has customer-visible output");
}

function retryOutcome(state) {
  const job = state.quote_jobs.at(-1);
  if (!job) return "not-applicable";
  if (state.handoff_reason === "quote_refused") return "eligibility-refused";
  if (job.status === "failed") return state.handoff_reason ?? job.failure_reason ?? "failed";
  if (job.attempts.some((attempt) => attempt.failure_kind === "timeout")) return "timeout-recovered";
  const failures = job.attempts.filter((attempt) => [500, 502, 503].includes(attempt.http_status));
  if (failures.length) return `${failures.map((attempt) => attempt.http_status).join("-")}-recovered`;
  return "first-attempt-success";
}

async function finalizeJourney(runtime) {
  assertDeliveryOrder(runtime);
  const copyPolicy = assertCustomerCopy(runtime);
  const state = await runtime.readState();
  const audit = await runtime.auditEvents();
  runtime.check(state.stage === runtime.scenario.expected_terminal, `journey ends in manifest terminal ${runtime.scenario.expected_terminal}`);
  runtime.check(state.quote_jobs.length === runtime.expectedOperations, "quote operation count matches user actions");
  runtime.check(new Set(state.quote_jobs.map((job) => job.request_id)).size === state.quote_jobs.length, "quote operations have unique correlation IDs");
  runtime.check(new Set(state.outbox.map((message) => message.id)).size === state.outbox.length, "outbox has no duplicate operation");
  runtime.check(audit.length > 0, "audit side effects are persisted");
  const actualProRata = state.quote ? Boolean(state.quote.primeiro_pagamento_pro_rata) : "not-applicable";
  if (runtime.scenario.expected_pro_rata !== "derived-from-runtime-date") {
    const expectedProRata = runtime.scenario.expected_pro_rata === "true" ? true : runtime.scenario.expected_pro_rata === "false" ? false : "not-applicable";
    runtime.check(actualProRata === expectedProRata, "pro-rata matches the committed manifest");
  }
  const actualWaitingPeriod = state.quote ? state.quote.carencia.dias : "not-applicable";
  runtime.check(actualWaitingPeriod === runtime.scenario.expected_waiting_period_days, "waiting period matches the committed manifest");
  const quoteAttempts = state.quote_jobs.flatMap((job) => job.attempts.map((attempt) => ({ quote_request_id: job.request_id, ...attempt })));
  const outbound = runtime.context.graphEvents.map((event) => ({
    sequence: event.sequence,
    kind: event.kind,
    status: event.status,
    message_type: event.payload.type ?? (event.kind === "presence" ? "typing" : "unknown"),
    interaction_kind: event.interactionKind,
    action_ids: event.actions.map((action) => action.id),
    text: evidenceText(event.text),
  }));
  for (const event of runtime.context.graphEvents.filter((candidate) => candidate.kind === "outbound" && candidate.status >= 400)) {
    if (event.interactionKind === "list") runtime.channels.add("meta-list-fallback");
    if (event.interactionKind === "button") runtime.channels.add("meta-button-fallback");
  }
  runtime.run.evidence.audits.push(...audit.map((event) => ({ journey_id: runtime.scenario.id, channel: "meta", ...event })));
  runtime.run.evidence.states.push({
    journey_id: runtime.scenario.id,
    stage: state.stage,
    fields: state.fields,
    active_quote_request_id: state.active_quote_request_id,
    quote_jobs: state.quote_jobs,
    outbox: state.outbox,
    quote: state.quote,
    handoff_reason: state.handoff_reason,
    csat_rating: state.csat_rating,
  });
  const result = {
    journey_id: runtime.scenario.id,
    family: runtime.scenario.family,
    manifest: runtime.scenario,
    messages_driven: runtime.messagesDriven,
    outbound_sequence: outbound,
    terminal_outcome: state.stage,
    quote_attempts: quoteAttempts,
    quote_request_ids: state.quote_jobs.map((job) => job.request_id),
    timing_ms: Math.round(performance.now() - runtime.startedAt),
    persistence_checks: {
      state_saved: true,
      expected_quote_operations: runtime.expectedOperations,
      actual_quote_operations: state.quote_jobs.length,
      outbox_unique: true,
      outbox_delivered: state.outbox.every((message) => message.delivered_at !== null),
    },
    audit_checks: {
      persisted: true,
      events: audit.map((event) => event.event),
      handoff_reason: state.handoff_reason,
      csat_rating: state.csat_rating,
    },
    copy_policy: copyPolicy,
    coverage: {
      plan: state.fields.plano?.value ?? "not-applicable",
      age_band: state.fields.idade ? runtime.scenario.age_band : "not-applicable",
      vehicle_age_band: state.fields.veiculo_ano ? runtime.scenario.vehicle_age_band : "not-applicable",
      cep_risk: state.fields.cep ? runtime.scenario.cep_risk : "not-applicable",
      policy_start_form: state.fields.data_inicio ? runtime.scenario.policy_start_form : "not-applicable",
      pro_rata: state.quote ? Boolean(state.quote.primeiro_pagamento_pro_rata) : "not-applicable",
      waiting_period: state.quote ? state.quote.carencia.dias : "not-applicable",
      interaction_formats: [...runtime.channels],
      action_ids: runtime.actions,
      retry_outcome: retryOutcome(state),
      handoff_reason: state.handoff_reason ?? "not-applicable",
      job_failure_reasons: state.quote_jobs.map((job) => job.failure_reason).filter(Boolean),
      csat: state.csat_rating ?? "not-applicable",
    },
    assertions: runtime.assertions,
  };
  return sanitize(result);
}

async function runOne(run, scenario) {
  const runtime = new JourneyRuntime(run, scenario);
  try {
    await runtime.start();
    await driveJourney(runtime);
    return await finalizeJourney(runtime);
  } finally {
    await runtime.stopApp();
    await rm(runtime.scratchDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    await run.transcript(`cleanup: removed scratch ${relative(repoRoot, runtime.scratchDirectory)}`);
  }
}

function validateManifest(manifest) {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.journey_count, 200);
  assert.deepEqual(manifest.families.map((family) => family.id), expectedFamilies);
  assert.ok(manifest.families.every((family) => family.journeys.length === 20), "every path family must contain 20 journeys");
  const rows = manifest.families.flatMap((family) => family.journeys.map((journey) => ({ ...journey, family: family.id })));
  assert.equal(rows.length, 200);
  assert.equal(new Set(rows.map((row) => row.id)).size, 200);
  return rows;
}

function counts(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).toSorted(([left], [right]) => left.localeCompare(right)));
}

function aggregate(results, full) {
  const coverage = {
    families: counts(results.map((row) => row.family)),
    plans: counts(results.map((row) => row.coverage.plan)),
    age_bands: counts(results.map((row) => row.coverage.age_band)),
    vehicle_age_bands: counts(results.map((row) => row.coverage.vehicle_age_band)),
    cep_risk: counts(results.map((row) => row.coverage.cep_risk)),
    policy_start_forms: counts(results.map((row) => row.coverage.policy_start_form)),
    pro_rata: counts(results.map((row) => String(row.coverage.pro_rata))),
    waiting_periods: counts(results.map((row) => String(row.coverage.waiting_period))),
    interaction_formats: counts(results.flatMap((row) => row.coverage.interaction_formats)),
    action_ids: counts(results.flatMap((row) => row.coverage.action_ids)),
    retry_outcomes: counts(results.map((row) => row.coverage.retry_outcome)),
    handoff_reasons: counts(results.map((row) => row.coverage.handoff_reason)),
    job_failure_reasons: counts(results.flatMap((row) => row.coverage.job_failure_reasons)),
    csat: counts(results.map((row) => row.coverage.csat)),
  };
  if (full) {
    assert.equal(results.length, 200, "full suite must execute exactly 200 journeys");
    assert.ok(expectedFamilies.every((family) => coverage.families[family] === 20), "actual family counts must remain 20 each");
    assert.ok(results.every((row) => row.messages_driven[0]?.signature === "valid-hmac-sha256"), "every journey must begin with a signed webhook");
    assert.ok(results.every((row) => row.terminal_outcome === row.manifest.expected_terminal), "every journey must reach its committed terminal outcome");
    assert.ok(results.every((row) => row.copy_policy.passed && row.persistence_checks.state_saved && row.audit_checks.persisted), "every journey must pass copy, persistence, and audit proof");
    const parityRows = results.filter((row) => row.family === "close-csat-channel-fallback-parity" && row.manifest.variant !== "quote-hire");
    for (const format of ["meta-rich", "meta-list-fallback", "meta-button-fallback", "cli-replay"]) {
      for (const plan of ["essencial", "completo", "premium"]) {
        const match = parityRows.find((row) => row.manifest.interaction_format === format && row.coverage.plan === plan);
        assert.ok(match?.coverage.interaction_formats.includes(format), `missing ${format}/${plan} parity path`);
        assert.ok(match.audit_checks.events.includes("quote_started") && match.audit_checks.events.includes("csat"), `missing ${format}/${plan} parity audit`);
      }
    }
    for (const bucket of ["essencial", "completo", "premium"]) assert.ok(coverage.plans[bucket] > 0, `missing plan coverage: ${bucket}`);
    for (const bucket of ["18-24", "25-29", "30-59", "60-75", "76-200"]) assert.ok(coverage.age_bands[bucket] > 0, `missing age band: ${bucket}`);
    for (const bucket of ["0-5", "6-10", "11-20", "21+"]) assert.ok(coverage.vehicle_age_bands[bucket] > 0, `missing vehicle age band: ${bucket}`);
    for (const bucket of ["normal", "high"]) assert.ok(coverage.cep_risk[bucket] > 0, `missing CEP risk: ${bucket}`);
    for (const bucket of ["iso", "pt-BR", "today", "tomorrow", "date-other"]) assert.ok(coverage.policy_start_forms[bucket] > 0, `missing policy start form: ${bucket}`);
    for (const bucket of ["true", "false", "not-applicable"]) assert.ok(coverage.pro_rata[bucket] > 0, `missing pro-rata bucket: ${bucket}`);
    for (const bucket of ["30", "not-applicable"]) assert.ok(coverage.waiting_periods[bucket] > 0, `missing waiting-period bucket: ${bucket}`);
    for (const bucket of ["meta-rich", "meta-list-fallback", "meta-button-fallback", "cli-replay"]) assert.ok(coverage.interaction_formats[bucket] > 0, `missing interaction format: ${bucket}`);
    for (const action of expectedActions) assert.ok(coverage.action_ids[action] > 0, `missing ActionId coverage: ${action}`);
    for (const rating of ["great", "regular", "bad"]) assert.ok(coverage.csat[rating] > 0, `missing CSAT coverage: ${rating}`);
    for (const reason of [
      "quote_service_unavailable", "quote_timeout", "quote_network_error", "invalid_quote_response",
      "invalid_quote_payload", "quote_http_401", "quote_refused", "human_requested", "unprocessed_media",
      "unsupported_request", "repeated_ambiguity", "llm_unavailable", "issuance_requested",
    ]) assert.ok(coverage.handoff_reasons[reason] > 0, `missing handoff reason: ${reason}`);
    for (const outcome of ["first-attempt-success", "timeout-recovered", "500-recovered", "502-recovered", "503-recovered", "500-502-recovered"]) {
      assert.ok(coverage.retry_outcomes[outcome] > 0, `missing retry outcome: ${outcome}`);
    }
    assert.ok(coverage.job_failure_reasons.superseded_by_correction > 0, "missing superseded quote outcome");
  }
  return coverage;
}

function markdownSummary(summary) {
  const familyRows = Object.entries(summary.coverage.families).map(([name, count]) => `| ${name} | ${count} |`).join("\n");
  const bucket = (name) => Object.entries(summary.coverage[name]).map(([key, count]) => `${key}: ${count}`).join(", ");
  return `# AutoSeguro verification proof\n\n- Status: **${summary.status}**\n- Run: \`${summary.run_id}\`\n- Build: \`${summary.build.sha}\`\n- Journeys: **${summary.journeys}**\n- Started: ${summary.started_at}\n- Finished: ${summary.finished_at}\n- Network: loopback-only local Meta Graph, quote, and LLM peers\n\n## Path counts\n\n| Family | Complete journeys |\n|---|---:|\n${familyRows}\n\n## Coverage\n\n- Plans: ${bucket("plans")}\n- Age bands: ${bucket("age_bands")}\n- Vehicle ages: ${bucket("vehicle_age_bands")}\n- CEP risk: ${bucket("cep_risk")}\n- Start forms: ${bucket("policy_start_forms")}\n- Pro-rata: ${bucket("pro_rata")}\n- Waiting periods: ${bucket("waiting_periods")}\n- Interaction formats: ${bucket("interaction_formats")}\n- Action IDs: ${bucket("action_ids")}\n- Retry outcomes: ${bucket("retry_outcomes")}\n- Handoff reasons: ${bucket("handoff_reasons")}\n- Quote-job failure reasons: ${bucket("job_failure_reasons")}\n- CSAT: ${bucket("csat")}\n\n## Evidence\n\n- \`journeys.jsonl\`: one sanitized row per journey\n- \`requests.jsonl\` and \`responses.jsonl\`: signed webhook and local boundary traffic\n- \`timeline.jsonl\`: ordered boundary events\n- \`audit-extract.jsonl\`: persisted internal correlation and audit events\n- \`state-extract.jsonl\`: sanitized persisted state checks\n- \`doctor.jsonl\`: build, ownership, isolation, and local-target checks\n- \`commands.log\`: launch and cleanup transcript\n- \`logs/\`: real AutoSeguro and CLI process output\n`;
}

async function sourceFingerprint() {
  const sourceNames = (await readdir(join(repoRoot, "src"))).filter((name) => name.endsWith(".ts")).toSorted();
  const names = ["package.json", "package-lock.json", ...sourceNames.map((name) => `src/${name}`), relative(repoRoot, helperPath), relative(repoRoot, manifestPath)];
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update(await readFile(join(repoRoot, name)));
  }
  return hash.digest("hex");
}

async function runBuildCheck(run) {
  await run.transcript("doctor-build: npm run check");
  const result = spawnSync("npm", ["run", "check"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? repoRoot, LANG: "C.UTF-8", CI: "1" },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 10_000_000,
  });
  await writeFile(join(run.artifactDirectory, "build.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`, { mode: 0o600 });
  assert.equal(result.status, 0, `npm run check failed; see ${join(run.artifactDirectory, "build.log")}`);
  await run.transcript("doctor-build: PASS");
}

async function writeJsonl(path, rows) {
  await writeFile(path, rows.map(jsonLine).join(""), { mode: 0o600 });
}

async function saveEvidence(run, results, status, failure = null) {
  const full = run.selection === "full";
  const coverage = aggregate(results, full && status === "passed");
  const summary = sanitize({
    status,
    failure: failure ? (failure instanceof Error ? failure.message : String(failure)) : null,
    run_id: run.runId,
    selection: run.selection,
    started_at: run.startedAt,
    finished_at: new Date().toISOString(),
    build: run.build,
    manifest: { path: relative(repoRoot, manifestPath), families: 10, journeys: 200 },
    journeys: results.length,
    coverage,
  });
  await writeJsonl(join(run.artifactDirectory, "journeys.jsonl"), results);
  await writeJsonl(join(run.artifactDirectory, "requests.jsonl"), run.evidence.requests);
  await writeJsonl(join(run.artifactDirectory, "responses.jsonl"), run.evidence.responses);
  await writeJsonl(join(run.artifactDirectory, "timeline.jsonl"), run.evidence.timeline);
  await writeJsonl(join(run.artifactDirectory, "audit-extract.jsonl"), run.evidence.audits);
  await writeJsonl(join(run.artifactDirectory, "state-extract.jsonl"), run.evidence.states);
  await writeJsonl(join(run.artifactDirectory, "doctor.jsonl"), run.evidence.doctors);
  await writeFile(join(run.artifactDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(run.artifactDirectory, "index.md"), markdownSummary(summary), { mode: 0o600 });
  return summary;
}

async function cleanupRun(run) {
  for (const child of [...run.children]) await stopChild(child, run.transcript, "recorded-child");
  await run.peer.close();
  await rm(run.scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  await run.transcript("cleanup: all recorded child processes stopped and scratch state removed; evidence preserved");
}

async function createRun(runId, selection) {
  const artifactDirectory = join(repoRoot, ".artifacts", "verify-autoseguro", runId);
  assert.ok(!existsSync(artifactDirectory), `artifact run already exists: ${artifactDirectory}`);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const commandPath = join(artifactDirectory, "commands.log");
  const transcript = async (line) => appendFile(commandPath, `${new Date().toISOString()} ${evidenceText(line)}\n`, { mode: 0o600 });
  const build = {
    sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    fingerprint: await sourceFingerprint(),
    worktree_status: execFileSync("git", ["status", "--short"], { cwd: repoRoot, encoding: "utf8" }).trim().split("\n").filter(Boolean),
  };
  const evidence = { requests: [], responses: [], timeline: [], audits: [], states: [], doctors: [] };
  const run = {
    runId,
    selection,
    artifactDirectory,
    scratchRoot: join(artifactDirectory, ".scratch"),
    startedAt: new Date().toISOString(),
    build,
    transcript,
    evidence,
    children: new Set(),
  };
  run.peer = new FakePeers(evidence);
  await transcript(`run: ${selection} build=${build.sha} fingerprint=${build.fingerprint}`);
  return run;
}

function runIdFrom(value) {
  if (value) {
    assert.match(value, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u, "invalid --run-id");
    return value;
  }
  return `${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

async function doctorOnly(run, rows) {
  const scenario = rows[0];
  const runtime = new JourneyRuntime(run, scenario);
  try {
    await runtime.start();
  } finally {
    await runtime.stopApp();
    await rm(runtime.scratchDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      feature: { type: "string" },
      doctor: { type: "boolean", default: false },
      "run-id": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("node .cursor/skills/verify-autoseguro/verify.mjs [--feature NAME | --doctor] [--run-id ID]");
    console.log(`features: ${Object.keys(featureScenarios).join(", ")}`);
    return;
  }
  if (values.feature) assert.ok(Object.hasOwn(featureScenarios, values.feature), `unknown feature: ${values.feature}`);
  assert.ok(!(values.feature && values.doctor), "choose --feature or --doctor");
  assert.equal(resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" }).trim()), repoRoot, "run from the AutoSeguro worktree");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const rows = validateManifest(manifest);
  const selection = values.doctor ? "doctor" : values.feature ? `feature:${values.feature}` : "full";
  const selected = values.feature ? rows.filter((row) => row.id === featureScenarios[values.feature]) : rows;
  if (values.feature) assert.equal(selected.length, 1);
  const run = await createRun(runIdFrom(values["run-id"]), selection);
  let failure = null;
  const results = [];
  interruptedSignal = null;
  const interrupt = (signal) => {
    interruptedSignal ??= signal;
    for (const child of run.children) child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await runBuildCheck(run);
    await run.peer.start();
    await run.transcript(`launch-peer: ${run.peer.baseUrl} pid=${process.pid}`);
    if (interruptedSignal) throw new Error(`interrupted by ${interruptedSignal}`);
    if (values.doctor) {
      await doctorOnly(run, rows);
    } else {
      for (const [index, scenario] of selected.entries()) {
        if (interruptedSignal) throw new Error(`interrupted by ${interruptedSignal}`);
        await run.transcript(`drive: ${scenario.id} (${index + 1}/${selected.length})`);
        results.push(await runOne(run, scenario));
      }
    }
    if (interruptedSignal) throw new Error(`interrupted by ${interruptedSignal}`);
  } catch (error) {
    failure = error;
  } finally {
    await cleanupRun(run).catch((error) => { failure ??= error; });
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  const status = failure ? "failed" : "passed";
  const summary = await saveEvidence(run, results, status, failure);
  const indexPath = join(run.artifactDirectory, "index.md");
  assert.ok(existsSync(indexPath), "evidence index did not survive cleanup");
  assert.ok(!existsSync(run.scratchRoot), "scratch state survived cleanup");
  if (failure) {
    console.error(`FAIL ${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}`);
    console.error(`Evidence: ${relative(repoRoot, indexPath)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${selection}: ${summary.journeys} complete journey${summary.journeys === 1 ? "" : "s"}`);
  console.log(`Evidence: ${relative(repoRoot, indexPath)}`);
}

if (process.argv[2] === "__server") {
  await bootServer();
} else if (process.argv[2] === "__cli") {
  await bootCli();
} else {
  await main();
}
