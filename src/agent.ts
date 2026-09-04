import { createHash, randomUUID } from "node:crypto";
import { AuditLog, fieldsForAudit, FileConversationStore } from "./persistence.ts";
import { redactSensitiveText } from "./privacy.ts";
import {
  hasFieldChanges,
  mergeFields,
  missingFields,
  toQuotePayload,
  validateCandidates,
  validateField,
} from "./validation.ts";
import { planCatalog, type PlanId } from "./plan-catalog.ts";
import type {
  ActionId,
  AgentReply,
  AuditEvent,
  ConversationState,
  FieldOrigin,
  IncomingMessage,
  LanguageModel,
  LanguageUnderstanding,
  OutboxMessage,
  Outcome,
  QuoteAttempt,
  QuoteClientPort,
  QuoteJob,
  QuoteJobStatus,
  QuoteResponse,
  QuoteResult,
  ReplyInteraction,
  RequiredFieldName,
} from "./types.ts";

interface AgentOptions {
  now?: () => Date;
  createId?: () => string;
  fieldSource?: FieldOrigin["source"];
}

interface ActiveJob {
  requestId: string;
  controller: AbortController;
  promise: Promise<void>;
}

interface AuditContext {
  attempt?: QuoteAttempt;
  job?: QuoteJob;
}

const fieldQuestions: Record<RequiredFieldName, string> = {
  plano: "Qual plano você quer conhecer?",
  idade: "Qual é a sua idade?",
  veiculo_ano: "Qual é o ano do veículo?",
  cep: "Qual é o CEP onde o veículo dorme?",
  data_inicio: "Quando quer começar? Escolha Hoje, Amanhã ou envie outra data.",
};
const fieldConfirmations: Record<RequiredFieldName, string> = {
  plano: "Plano anotado.",
  idade: "Idade anotada.",
  veiculo_ano: "Ano do veículo anotado.",
  cep: "CEP anotado.",
  data_inicio: "Data de início anotada.",
};
const planInteraction: ReplyInteraction = {
  kind: "list",
  button_label: "Ver planos",
  actions: [
    { id: "plan_essencial", title: "Essencial — colisão, roubo e furto" },
    { id: "plan_completo", title: "Completo — terceiros e vidros" },
    { id: "plan_premium", title: "Premium — carro reserva e assistência" },
  ],
};
const dateInteraction: ReplyInteraction = {
  kind: "buttons",
  actions: [
    { id: "date_today", title: "Hoje" },
    { id: "date_tomorrow", title: "Amanhã" },
    { id: "date_other", title: "Outra data" },
  ],
};
const quoteActions: ReplyInteraction = {
  kind: "list",
  button_label: "Opções",
  section_title: "Próximos passos",
  actions: [
    { id: "quote_hire", title: "Contratar plano" },
    { id: "quote_new", title: "Nova cotação" },
    { id: "human_help", title: "Falar com uma pessoa" },
    { id: "service_end", title: "Encerrar atendimento" },
  ],
};
const csatActions: ReplyInteraction = {
  kind: "buttons",
  actions: [
    { id: "csat_great", title: "Ótimo" },
    { id: "csat_regular", title: "Regular" },
    { id: "csat_bad", title: "Ruim" },
  ],
};
const planActions = {
  plan_essencial: "essencial",
  plan_completo: "completo",
  plan_premium: "premium",
} as const;
const csatRatings = { csat_great: "great", csat_regular: "regular", csat_bad: "bad" } as const;
const dateActions = new Set<string>(["date_today", "date_tomorrow", "date_other"]);
const greetingPattern = /^(?:oi|olá|ola|bom dia|boa tarde|boa noite)[!,.\s]*$/iu;
const closingPattern = /^(?:sim[\s,!.]+)?(?:eu\s+)?(?:(?:quero|vou|desejo|decidi)\s+(?:contratar|fechar|aceitar)\b|gostaria\s+de\s+(?:contratar|fechar|aceitar)\b|aceito\b|fechado\b)/u;
const blockedClosingPattern = /\b(?:nao|nem|nunca|jamais)\b|\b(?:se|caso)\s+(?:eu\s+)?(?:contratar|fechar|aceitar)\b/u;
const endPattern = /^(?:encerrar|finalizar|encerrar atendimento|fim)[!,.\s]*$/iu;

function normalizeCommand(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
}

function isClosingIntent(value: string): boolean {
  const normalized = normalizeCommand(value);
  return !blockedClosingPattern.test(normalized) && closingPattern.test(normalized);
}

function isScalarInput(field: RequiredFieldName, text: string): boolean {
  const value = text.trim();
  if (field === "plano") {
    return Object.hasOwn(planCatalog, normalizeCommand(value));
  }
  if (field === "idade") {
    return /^\d+$/u.test(value);
  }
  if (field === "veiculo_ano") {
    return /^\d{4}$/u.test(value);
  }
  if (field === "cep") {
    return /^[\d\s-]+$/u.test(value);
  }
  return /^(?:hoje|amanhã|amanha|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})$/iu.test(value);
}
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const allowedTransitions: Record<QuoteJobStatus, QuoteJobStatus[]> = {
  pending: ["retrying", "delivered", "failed"],
  retrying: ["delivered", "failed"],
  delivered: [],
  failed: [],
};

function validateMessage(input: IncomingMessage): void {
  if (!identifierPattern.test(input.conversation_id) || !identifierPattern.test(input.message_id)) {
    throw new Error("Identificador de mensagem inválido");
  }
  if (input.text.length > 10_000) {
    throw new Error("Mensagem excede 10.000 caracteres");
  }
  if (input.message_type === "text" && input.text.trim() === "") {
    throw new Error("Mensagem de texto vazia");
  }
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function reference(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 8);
}

function quoteReply(quote: QuoteResponse, requestId: string, startDate: string): AgentReply {
  const monthly = formatMoney(quote.premio_mensal, quote.moeda);
  const deductible = formatMoney(quote.franquia, quote.moeda);
  const firstPayment = quote.primeiro_pagamento_pro_rata
    ? `Primeiro pagamento proporcional: ${formatMoney(quote.primeiro_pagamento_pro_rata.valor_primeiro_pagamento, quote.moeda)}.`
    : "";
  const waiting = quote.carencia.coberturas.length > 0
    ? `${quote.carencia.coberturas.join(" e ")} passam a valer após ${quote.carencia.dias} dias contados do início da cobertura.`
    : "";
  return {
    text: [
      "Sua cotação está pronta.",
      `Plano: ${quote.plano_nome}`,
      `Mensalidade: ${monthly}`,
      `Franquia: ${deductible}`,
      `Coberturas: ${quote.coberturas.join(", ")}.`,
      `Início da cobertura: ${formatDate(startDate)}.`,
      waiting,
      firstPayment,
      `Referência: ${reference(requestId)}`,
    ].filter(Boolean).join("\n"),
    outcome: "resolved",
    quote_request_id: requestId,
    interaction: quoteActions,
  };
}

function terminalReply(state: ConversationState): AgentReply {
  if (state.stage === "closed") {
    return {
      text: "Este atendimento foi encerrado. Quando quiser, envie uma nova mensagem para começar outra cotação.",
      outcome: "resolved",
      quote_request_id: state.active_quote_request_id,
    };
  }
  if (state.stage === "resolved") {
    return {
      text: "Sua cotação continua disponível.",
      outcome: "resolved",
      quote_request_id: state.active_quote_request_id,
      interaction: quoteActions,
    };
  }
  return {
    text: "Uma pessoa do time vai ajudar você.",
    outcome: "handoff",
    quote_request_id: state.active_quote_request_id,
  };
}

function attemptOutcome(attempt: QuoteAttempt): Outcome {
  const status = attempt.http_status;
  if (status !== null && status >= 200 && status < 300) {
    return "resolved";
  }
  if (status === 422) {
    return "refused";
  }
  if (status !== null && status >= 400 && status < 500) {
    return "handoff";
  }
  return "awaiting_data";
}

function stateOutcome(state: ConversationState): Outcome {
  if (state.stage === "resolved" || state.stage === "closed") {
    return "resolved";
  }
  if (state.stage === "handoff") {
    return "handoff";
  }
  return "awaiting_data";
}

function findJob(state: ConversationState, requestId: string | null): QuoteJob | undefined {
  return requestId ? state.quote_jobs.find((job) => job.request_id === requestId) : undefined;
}

function attemptAuditFields(attempt: QuoteAttempt | undefined): Pick<AuditEvent, "attempt" | "latency_ms" | "http_status" | "failure_kind"> {
  if (!attempt) {
    return { attempt: null, latency_ms: null, http_status: null, failure_kind: null };
  }
  return {
    attempt: attempt.attempt,
    latency_ms: attempt.latency_ms,
    http_status: attempt.http_status,
    failure_kind: attempt.failure_kind,
  };
}

function jobAuditFields(
  state: ConversationState,
  job: QuoteJob | undefined,
): Pick<AuditEvent, "collected_fields" | "quote_request_id" | "quote_status"> {
  if (!job) {
    return {
      collected_fields: fieldsForAudit(state.fields),
      quote_request_id: state.active_quote_request_id,
      quote_status: null,
    };
  }
  return {
    collected_fields: fieldsForAudit(job.fields),
    quote_request_id: job.request_id,
    quote_status: job.status,
  };
}

function transitionJob(job: QuoteJob, status: QuoteJobStatus, timestamp: string, reason: string | null): void {
  if (job.status === status) {
    return;
  }
  if (!allowedTransitions[job.status].includes(status)) {
    throw new Error(`Transição de cotação inválida: ${job.status} -> ${status}`);
  }
  job.status = status;
  job.updated_at = timestamp;
  job.failure_reason = reason;
  job.transitions.push({ status, timestamp, reason });
}

function pendingReply(requestId: string, corrected: boolean): AgentReply {
  return {
    text: corrected
      ? "Atualizei seus dados. Vou preparar uma nova cotação e aviso assim que estiver pronta."
      : "Recebi seus dados. Vou preparar sua cotação e aviso assim que estiver pronta.",
    outcome: "awaiting_data",
    quote_request_id: requestId,
  };
}

function pendingStatusReply(state: ConversationState, information: boolean): AgentReply {
  return {
    text: information
      ? "Estou preparando sua cotação. Assim que estiver pronta, trago os valores e as coberturas."
      : "Sua cotação está em andamento. Aviso assim que estiver pronta.",
    outcome: "awaiting_data",
    quote_request_id: state.active_quote_request_id,
  };
}

function formatPlanCatalogSummary(): string {
  return [
    "Planos disponíveis:",
    "• Essencial — colisão, roubo e furto. Franquia: R$ 4.500,00.",
    "• Completo — adiciona terceiros e vidros. Franquia: R$ 3.000,00.",
    "• Premium — adiciona carro reserva e assistência 24h. Franquia: R$ 1.500,00.",
    "Roubo e furto passam a valer após 30 dias contados do início da cobertura.",
  ].join("\n");
}

function explainPlanDetails(plan: PlanId): string {
  const details = planCatalog[plan];
  return [
    `Plano ${details.nome}`,
    `Coberturas: ${details.coberturas.join(", ")}.`,
    `Franquia: ${formatMoney(details.franquia, "BRL")}.`,
    "Roubo e furto passam a valer após 30 dias contados do início da cobertura.",
  ].join("\n");
}

function refusalReply(requestId: string, reason?: string | null): AgentReply {
  const cleanReason = reason?.trim().replace(/\.+$/u, "");
  const detail = cleanReason && !/api/iu.test(cleanReason) ? ` Motivo: ${cleanReason}.` : "";
  return {
    text: `Não foi possível seguir com esta cotação.${detail} Uma pessoa do time vai orientar você. Referência: ${reference(requestId)}`,
    outcome: "handoff",
    quote_request_id: requestId,
  };
}

function failureReply(requestId: string): AgentReply {
  return {
    text: `Não consegui concluir a cotação agora. Uma pessoa do time vai ajudar você. Referência: ${reference(requestId)}`,
    outcome: "handoff",
    quote_request_id: requestId,
  };
}

export class AutoSeguroAgent {
  private readonly store: FileConversationStore;
  private readonly audit: AuditLog;
  private readonly llm: LanguageModel;
  private readonly quoteClient: QuoteClientPort;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly fieldSource: FieldOrigin["source"];
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    store: FileConversationStore,
    audit: AuditLog,
    llm: LanguageModel,
    quoteClient: QuoteClientPort,
    options: AgentOptions = {},
  ) {
    this.store = store;
    this.audit = audit;
    this.llm = llm;
    this.quoteClient = quoteClient;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.fieldSource = options.fieldSource ?? "llm";
  }

  async handle(input: IncomingMessage): Promise<AgentReply> {
    validateMessage(input);
    return this.locked(input.conversation_id, () => this.process(input));
  }

  async resume(conversationId: string): Promise<boolean> {
    const job = await this.locked(conversationId, async () => {
      const state = await this.store.load(conversationId);
      if (state.stage !== "quoting") {
        return null;
      }
      const active = findJob(state, state.active_quote_request_id);
      return active && ["pending", "retrying"].includes(active.status) ? structuredClone(active) : null;
    });
    if (!job) {
      return false;
    }
    this.launchQuote(conversationId, job);
    return true;
  }

  async waitForIdle(conversationId: string): Promise<void> {
    while (true) {
      const active = this.activeJobs.get(conversationId);
      if (!active) {
        return;
      }
      await active.promise;
    }
  }

  async deliverOutbox(
    conversationId: string,
    deliver: (message: OutboxMessage) => Promise<void> | void,
  ): Promise<number> {
    return this.locked(conversationId, async () => {
      const state = await this.store.load(conversationId);
      const pending = state.outbox.filter((message) => message.delivered_at === null);
      for (const message of pending) {
        await deliver(structuredClone(message));
        message.delivered_at = this.timestamp();
      }
      if (pending.length > 0) {
        await this.store.save(state);
        for (const message of pending) {
          await this.writeAudit("outbox_delivered", state, message.source_message_id, message.outcome);
        }
      }
      return pending.length;
    });
  }

  private async process(input: IncomingMessage): Promise<AgentReply> {
    const state = await this.store.load(input.conversation_id);
    const duplicate = state.processed_messages[input.message_id];
    if (duplicate) {
      await this.writeAudit("message", state, input.message_id, duplicate.outcome);
      return duplicate;
    }
    const deterministic = await this.deterministicReply(state, input);
    if (deterministic) {
      return deterministic;
    }
    if (["resolved", "handoff", "closed"].includes(state.stage)) {
      return this.finish(state, input.message_id, terminalReply(state), "message");
    }
    if (input.message_type !== "text") {
      return this.handoff(state, input.message_id, "unprocessed_media");
    }
    const understanding = await this.understand(state, input);
    if (!understanding) {
      return this.handoff(state, input.message_id, "llm_unavailable");
    }
    return state.stage === "quoting"
      ? this.processPending(state, input.message_id, understanding)
      : this.processCollecting(state, input.message_id, understanding);
  }

  private async deterministicReply(
    state: ConversationState,
    input: IncomingMessage,
  ): Promise<AgentReply | null> {
    if (input.action) {
      return this.processAction(state, input.message_id, input.action);
    }
    if (input.message_type !== "text") {
      return null;
    }
    if (normalizeCommand(input.text) === "nova cotacao") {
      return this.newQuote(state, input.message_id);
    }
    if (state.stage === "resolved") {
      if (endPattern.test(input.text)) {
        return this.endService(state, input.message_id);
      }
      if (isClosingIntent(input.text)) {
        return this.closeDeal(state, input.message_id);
      }
    }
    if (greetingPattern.test(input.text) && state.stage === "collecting") {
      return this.welcome(state, input.message_id);
    }
    return state.stage === "collecting"
      ? this.collectScalar(state, input.message_id, input.text)
      : null;
  }

  private async understand(
    state: ConversationState,
    input: IncomingMessage,
  ): Promise<LanguageUnderstanding | null> {
    try {
      return await this.llm.understand({
        text: redactSensitiveText(input.text),
        missing_fields: missingFields(state.fields),
        current_date: this.timestamp().slice(0, 10),
      });
    } catch {
      return null;
    }
  }

  private async collectScalar(
    state: ConversationState,
    messageId: string,
    text: string,
  ): Promise<AgentReply | null> {
    const field = missingFields(state.fields)[0];
    if (!field || !isScalarInput(field, text)) {
      return null;
    }
    const validated = validateField(field, text, this.timestamp().slice(0, 10));
    state.fields = mergeFields(state.fields, validated.values, messageId, "deterministic");
    const confirmation = state.fields[field]?.origin.message_id === messageId
      ? fieldConfirmations[field]
      : undefined;
    const missing = missingFields(state.fields);
    return validated.errors.length > 0 || missing.length > 0
      ? this.awaitData(state, messageId, missing, validated.errors, undefined, confirmation)
      : this.startQuote(state, messageId, false);
  }

  private async processCollecting(
    state: ConversationState,
    messageId: string,
    understanding: LanguageUnderstanding,
  ): Promise<AgentReply> {
    if (understanding.intent === "human") {
      return this.handoff(state, messageId, "human_requested");
    }
    if (understanding.intent === "unsupported") {
      return this.handoff(state, messageId, "unsupported_request");
    }
    if (understanding.ambiguous) {
      return this.handleAmbiguity(state, messageId, false);
    }
    if (understanding.intent === "information") {
      const candidates = { ...understanding.fields };
      const queriedPlan = candidates.plano;
      delete candidates.plano;
      const validated = validateCandidates(candidates, this.timestamp().slice(0, 10));
      state.fields = mergeFields(state.fields, validated.values, messageId, this.fieldSource);
      const explanation = typeof queriedPlan === "string" && queriedPlan in planCatalog
        ? explainPlanDetails(queriedPlan as PlanId)
        : formatPlanCatalogSummary();
      const missing = missingFields(state.fields);
      return this.awaitData(state, messageId, missing, validated.errors, explanation);
    }
    state.ambiguity_count = 0;
    const validated = validateCandidates(understanding.fields, this.timestamp().slice(0, 10));
    state.fields = mergeFields(state.fields, validated.values, messageId, this.fieldSource);
    const missing = missingFields(state.fields);
    if (validated.errors.length > 0 || missing.length > 0) {
      return this.awaitData(state, messageId, missing, validated.errors);
    }
    return this.startQuote(state, messageId, false);
  }

  private async processPending(
    state: ConversationState,
    messageId: string,
    understanding: LanguageUnderstanding,
  ): Promise<AgentReply> {
    if (understanding.intent === "human") {
      return this.handoff(state, messageId, "human_requested");
    }
    if (understanding.intent === "unsupported") {
      return this.handoff(state, messageId, "unsupported_request");
    }
    if (understanding.ambiguous) {
      return this.handleAmbiguity(state, messageId, true);
    }
    if (["status", "information"].includes(understanding.intent)) {
      return this.finish(
        state,
        messageId,
        pendingStatusReply(state, understanding.intent === "information"),
        "message",
      );
    }
    const validated = validateCandidates(understanding.fields, this.timestamp().slice(0, 10));
    if (validated.errors.length > 0) {
      return this.pendingInformation(state, messageId, `Não consegui validar: ${validated.errors.join(" e ")}.`);
    }
    if (hasFieldChanges(state.fields, validated.values)) {
      this.cancelActiveJob(state.conversation_id);
      this.failActiveStateJob(state, "superseded_by_correction");
      state.fields = mergeFields(state.fields, validated.values, messageId, this.fieldSource);
      state.ambiguity_count = 0;
      return this.startQuote(state, messageId, true);
    }
    return this.finish(state, messageId, pendingStatusReply(state, false), "message");
  }

  private async handleAmbiguity(
    state: ConversationState,
    messageId: string,
    quotePending: boolean,
  ): Promise<AgentReply> {
    state.ambiguity_count += 1;
    if (state.ambiguity_count >= 2) {
      return this.handoff(state, messageId, "repeated_ambiguity");
    }
    if (quotePending) {
      return this.pendingInformation(
        state,
        messageId,
        "Não consegui confirmar a alteração. Vou manter sua cotação atual.",
      );
    }
    return this.awaitData(
      state,
      messageId,
      missingFields(state.fields),
      ["não consegui confirmar os dados desta mensagem"],
    );
  }

  private async awaitData(
    state: ConversationState,
    messageId: string,
    missing: RequiredFieldName[],
    errors: string[],
    guidance?: string,
    confirmation?: string,
  ): Promise<AgentReply> {
    state.stage = "collecting";
    const field = missing[0];
    const prefix = guidance ? `${guidance}\n\n` : "";
    const issue = errors.length > 0
      ? `${errors[0]}.`
      : guidance
        ? "Para continuarmos:"
        : confirmation ?? "Vamos montar a sua cotação.";
    const question = field ? fieldQuestions[field] : "Envie o dado corrigido, por favor.";
    return this.finish(state, messageId, {
      text: `${prefix}${issue}\n\n${question}`,
      outcome: "awaiting_data",
      quote_request_id: null,
      ...(field === "plano" ? { interaction: planInteraction } : field === "data_inicio" ? { interaction: dateInteraction } : {}),
    }, "message");
  }

  private async pendingInformation(
    state: ConversationState,
    messageId: string,
    text: string,
  ): Promise<AgentReply> {
    return this.finish(
      state,
      messageId,
      {
        text,
        outcome: "awaiting_data",
        quote_request_id: state.active_quote_request_id,
      },
      "message",
    );
  }

  private async startQuote(
    state: ConversationState,
    messageId: string,
    corrected: boolean,
  ): Promise<AgentReply> {
    const timestamp = this.timestamp();
    const requestId = this.createId();
    const payload = toQuotePayload(state.fields);
    const job: QuoteJob = {
      request_id: requestId,
      initiated_by_message_id: messageId,
      payload,
      fields: structuredClone(state.fields),
      status: "pending",
      attempts: [],
      transitions: [{ status: "pending", timestamp, reason: null }],
      created_at: timestamp,
      updated_at: timestamp,
      failure_reason: null,
    };
    state.stage = "quoting";
    state.active_quote_request_id = requestId;
    state.quote = null;
    state.handoff_reason = null;
    state.quote_jobs.push(job);
    const reply = await this.finish(state, messageId, pendingReply(requestId, corrected), "quote_started");
    this.launchQuote(state.conversation_id, job);
    return reply;
  }

  private launchQuote(conversationId: string, job: QuoteJob): void {
    const current = this.activeJobs.get(conversationId);
    if (current?.requestId === job.request_id) {
      return;
    }
    current?.controller.abort();
    const controller = new AbortController();
    const active: ActiveJob = {
      requestId: job.request_id,
      controller,
      promise: Promise.resolve(),
    };
    this.activeJobs.set(conversationId, active);
    active.promise = Promise.resolve()
      .then(() => this.executeQuote(conversationId, job, controller.signal))
      .finally(() => {
        if (this.activeJobs.get(conversationId) === active) {
          this.activeJobs.delete(conversationId);
        }
      });
    void active.promise.catch(() => undefined);
  }

  private async executeQuote(
    conversationId: string,
    job: QuoteJob,
    signal: AbortSignal,
  ): Promise<void> {
    let result: QuoteResult;
    try {
      result = await this.quoteClient.request(
        job.payload,
        job.request_id,
        (attempt) => this.recordAttempt(conversationId, job.request_id, attempt),
        job.attempts.length,
        signal,
      );
    } catch {
      await this.failQuote(conversationId, job.request_id, "quote_worker_error");
      return;
    }
    await this.completeQuote(conversationId, job.request_id, result);
  }

  private async recordAttempt(
    conversationId: string,
    requestId: string,
    attempt: QuoteAttempt,
  ): Promise<void> {
    await this.locked(conversationId, async () => {
      const state = await this.store.load(conversationId);
      const job = findJob(state, requestId);
      if (!job) {
        return;
      }
      if (!job.attempts.some((saved) => saved.attempt === attempt.attempt)) {
        job.attempts.push(attempt);
      }
      if (state.active_quote_request_id === requestId && attempt.will_retry) {
        transitionJob(job, "retrying", this.timestamp(), null);
      }
      job.updated_at = this.timestamp();
      await this.store.save(state);
      await this.writeAudit(
        "quote_attempt",
        state,
        job.initiated_by_message_id,
        attemptOutcome(attempt),
        { attempt, job },
      );
    });
  }

  private async completeQuote(
    conversationId: string,
    requestId: string,
    result: QuoteResult,
  ): Promise<void> {
    await this.locked(conversationId, async () => {
      const state = await this.store.load(conversationId);
      const job = findJob(state, requestId);
      if (!job) {
        return;
      }
      if (state.active_quote_request_id !== requestId || state.stage !== "quoting" || ["failed", "delivered"].includes(job.status)) {
        await this.writeAudit("quote_ignored", state, job.initiated_by_message_id, stateOutcome(state), { job });
        return;
      }
      if (result.kind === "success") {
        await this.completeSuccess(state, job, result.quote);
        return;
      }
      if (result.kind === "refused") {
        await this.completeFailure(state, job, "quote_refused", refusalReply(requestId, result.reason));
        return;
      }
      if (result.kind === "cancelled") {
        await this.completeFailure(state, job, "quote_cancelled", failureReply(requestId));
        return;
      }
      await this.completeFailure(state, job, result.reason, failureReply(requestId));
    });
  }

  private async completeSuccess(
    state: ConversationState,
    job: QuoteJob,
    quote: QuoteResponse,
  ): Promise<void> {
    transitionJob(job, "delivered", this.timestamp(), null);
    state.stage = "resolved";
    state.quote = quote;
    const reply = quoteReply(quote, job.request_id, job.payload.data_inicio);
    this.enqueue(state, job, reply);
    await this.store.save(state);
    await this.writeAudit("quote_completed", state, job.initiated_by_message_id, "resolved", { job });
  }

  private async completeFailure(
    state: ConversationState,
    job: QuoteJob,
    reason: string,
    reply: AgentReply,
  ): Promise<void> {
    transitionJob(job, "failed", this.timestamp(), reason);
    state.stage = "handoff";
    state.handoff_reason = reason;
    this.enqueue(state, job, reply);
    await this.store.save(state);
    await this.writeAudit("handoff", state, job.initiated_by_message_id, "handoff", { job });
  }

  private async failQuote(conversationId: string, requestId: string, reason: string): Promise<void> {
    await this.locked(conversationId, async () => {
      const state = await this.store.load(conversationId);
      const job = findJob(state, requestId);
      if (!job || state.active_quote_request_id !== requestId || state.stage !== "quoting") {
        return;
      }
      await this.completeFailure(state, job, reason, failureReply(requestId));
    });
  }

  private enqueue(state: ConversationState, job: QuoteJob, reply: AgentReply): void {
    const id = `${job.request_id}-terminal`;
    if (state.outbox.some((message) => message.id === id)) {
      return;
    }
    state.outbox.push({
      ...reply,
      id,
      source_message_id: job.initiated_by_message_id,
      created_at: this.timestamp(),
      delivered_at: null,
    });
  }

  private async handoff(
    state: ConversationState,
    messageId: string,
    reason: string,
  ): Promise<AgentReply> {
    this.cancelActiveJob(state.conversation_id);
    this.failActiveStateJob(state, reason);
    state.stage = "handoff";
    state.awaiting_csat = false;
    state.handoff_reason = reason;
    state.active_quote_request_id ??= this.createId();
    return this.finish(state, messageId, failureReply(state.active_quote_request_id), "handoff");
  }

  private async processAction(
    state: ConversationState,
    messageId: string,
    action: ActionId,
  ): Promise<AgentReply> {
    if (action in planActions) {
      return this.selectPlan(state, messageId, planActions[action as keyof typeof planActions]);
    }
    if (action in csatRatings) {
      return this.recordCsat(state, messageId, csatRatings[action as keyof typeof csatRatings]);
    }
    if (dateActions.has(action)) {
      return this.chooseDate(state, messageId, action as "date_today" | "date_tomorrow" | "date_other");
    }
    switch (action) {
      case "quote_hire":
        return this.closeDeal(state, messageId);
      case "human_help":
        return this.handoff(state, messageId, "human_requested");
      case "plans_view":
        return this.finish(state, messageId, {
          text: formatPlanCatalogSummary(),
          outcome: stateOutcome(state),
          quote_request_id: state.active_quote_request_id,
          interaction: planInteraction,
        }, "message");
      case "quote_start":
        return state.stage === "collecting"
          ? this.awaitData(state, messageId, missingFields(state.fields), [])
          : this.finish(state, messageId, terminalReply(state), "message");
      case "quote_new":
        return this.newQuote(state, messageId);
      case "service_end":
        return this.endService(state, messageId);
    }
    return this.finish(state, messageId, terminalReply(state), "message");
  }

  private async selectPlan(state: ConversationState, messageId: string, plan: PlanId): Promise<AgentReply> {
    if (state.stage !== "collecting") {
      return this.finish(state, messageId, terminalReply(state), "message");
    }
    state.fields = mergeFields(state.fields, { plano: plan }, messageId, "deterministic");
    return this.finish(state, messageId, {
      text: `${explainPlanDetails(plan)}\nQuer seguir com este plano?`,
      outcome: "awaiting_data",
      quote_request_id: null,
      interaction: {
        kind: "buttons",
        actions: [
          { id: "quote_start", title: "Continuar" },
          { id: "plans_view", title: "Comparar planos" },
          { id: "human_help", title: "Falar com uma pessoa" },
        ],
      },
    }, "message");
  }

  private async chooseDate(
    state: ConversationState,
    messageId: string,
    action: "date_today" | "date_tomorrow" | "date_other",
  ): Promise<AgentReply> {
    if (state.stage !== "collecting" || !missingFields(state.fields).includes("data_inicio")) {
      return this.finish(state, messageId, terminalReply(state), "message");
    }
    if (action === "date_other") {
      return this.finish(state, messageId, {
        text: "Envie a data em DD/MM/AAAA.",
        outcome: "awaiting_data",
        quote_request_id: null,
      }, "message");
    }
    const selected = await this.collectScalar(state, messageId, action === "date_today" ? "hoje" : "amanhã");
    return selected ?? this.awaitData(state, messageId, missingFields(state.fields), []);
  }

  private async newQuote(state: ConversationState, messageId: string): Promise<AgentReply> {
    state.stage = "collecting";
    state.fields = {};
    state.ambiguity_count = 0;
    state.active_quote_request_id = null;
    state.quote = null;
    state.handoff_reason = null;
    state.awaiting_csat = false;
    return this.awaitData(state, messageId, missingFields(state.fields), []);
  }

  private async welcome(state: ConversationState, messageId: string): Promise<AgentReply> {
    return this.finish(state, messageId, {
      text: "Como você quer seguir?",
      outcome: "awaiting_data",
      quote_request_id: state.active_quote_request_id,
      interaction: {
        kind: "buttons",
        actions: [
          { id: "quote_start", title: "Começar cotação" },
          { id: "plans_view", title: "Ver planos" },
          { id: "human_help", title: "Falar com uma pessoa" },
        ],
      },
    }, "message");
  }

  private async endService(state: ConversationState, messageId: string): Promise<AgentReply> {
    if (state.stage !== "resolved" || state.awaiting_csat) {
      return this.finish(state, messageId, terminalReply(state), "message");
    }
    state.awaiting_csat = true;
    return this.finish(state, messageId, {
      text: "Como você avalia este atendimento?",
      outcome: "resolved",
      quote_request_id: state.active_quote_request_id,
      interaction: csatActions,
    }, "message");
  }

  private async closeDeal(state: ConversationState, messageId: string): Promise<AgentReply> {
    if (state.stage !== "resolved" || state.quote === null || state.active_quote_request_id === null) {
      return this.finish(state, messageId, {
        text: state.stage === "quoting"
          ? "Sua cotação está em andamento. Quando estiver pronta, você poderá solicitar a contratação."
          : "A contratação fica disponível depois que sua cotação estiver pronta.",
        outcome: stateOutcome(state),
        quote_request_id: state.active_quote_request_id,
      }, "message");
    }
    const requestId = state.active_quote_request_id;
    state.stage = "handoff";
    state.awaiting_csat = false;
    state.handoff_reason = "issuance_requested";
    return this.finish(state, messageId, {
      text: `Sua cotação foi separada para emissão. Uma pessoa do nosso time vai orientar você com os próximos passos. Referência: ${reference(requestId)}`,
      outcome: "handoff",
      quote_request_id: requestId,
    }, "handoff");
  }

  private async recordCsat(
    state: ConversationState,
    messageId: string,
    rating: "great" | "regular" | "bad",
  ): Promise<AgentReply> {
    if (state.stage !== "resolved" || !state.awaiting_csat) {
      return this.finish(state, messageId, terminalReply(state), "message");
    }
    state.awaiting_csat = false;
    state.csat_rating = rating;
    state.csat_timestamp = this.timestamp();
    state.stage = "closed";
    return this.finish(state, messageId, {
      text: "Obrigado pela avaliação. Encerramos este atendimento. Quando precisar, estarei por aqui.",
      outcome: "resolved",
      quote_request_id: state.active_quote_request_id,
    }, "csat");
  }

  private failActiveStateJob(state: ConversationState, reason: string): void {
    const job = findJob(state, state.active_quote_request_id);
    if (job && ["pending", "retrying"].includes(job.status)) {
      transitionJob(job, "failed", this.timestamp(), reason);
    }
  }

  private cancelActiveJob(conversationId: string): void {
    this.activeJobs.get(conversationId)?.controller.abort();
  }

  private async finish(
    state: ConversationState,
    messageId: string,
    reply: AgentReply,
    event: AuditEvent["event"],
  ): Promise<AgentReply> {
    const greeted = !state.greeted;
    state.greeted = true;
    const decorated = greeted
      ? { ...reply, text: `Olá! Eu sou a AutoSeguro. Em poucos passos, monto sua cotação. Os valores são definidos pela seguradora.\n\n${reply.text}` }
      : reply;
    state.processed_messages[messageId] = decorated;
    await this.store.save(state);
    await this.writeAudit(event, state, messageId, decorated.outcome);
    return decorated;
  }

  private async writeAudit(
    event: AuditEvent["event"],
    state: ConversationState,
    messageId: string,
    outcome: Outcome,
    context: AuditContext = {},
  ): Promise<void> {
    const job = context.job ?? findJob(state, state.active_quote_request_id);
    await this.audit.append({
      event,
      conversation_id: state.conversation_id,
      message_id: messageId,
      timestamp: this.timestamp(),
      stage: state.stage,
      ...jobAuditFields(state, job),
      ...attemptAuditFields(context.attempt),
      outcome,
      handoff_reason: state.handoff_reason,
      csat_rating: event === "csat" ? state.csat_rating : null,
    });
  }

  private async locked<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(conversationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(conversationId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(conversationId) === current) {
        this.locks.delete(conversationId);
      }
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
