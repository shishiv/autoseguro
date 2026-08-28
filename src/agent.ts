import { randomUUID } from "node:crypto";
import { AuditLog, fieldsForAudit, FileConversationStore } from "./persistence.ts";
import { redactSensitiveText } from "./privacy.ts";
import {
  hasFieldChanges,
  mergeFields,
  missingFields,
  toQuotePayload,
  validateCandidates,
} from "./validation.ts";
import type {
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

const fieldLabels: Record<RequiredFieldName, string> = {
  plano: "plano (Essencial, Completo ou Premium)",
  idade: "idade",
  veiculo_ano: "ano do veículo",
  cep: "CEP onde o veículo dorme",
  data_inicio: "data de início (AAAA-MM-DD)",
};
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

function safeNaturalPhrase(value: string, fallback: string): string {
  const text = redactSensitiveText(value).trim();
  return text.length > 0 && text.length <= 300 && !/R\$|\b\d+[,.]\d{2}\b/u.test(text)
    ? text
    : fallback;
}

function quoteReply(quote: QuoteResponse, requestId: string): AgentReply {
  const monthly = formatMoney(quote.premio_mensal, quote.moeda);
  const deductible = formatMoney(quote.franquia, quote.moeda);
  const firstPayment = quote.primeiro_pagamento_pro_rata
    ? ` O primeiro pagamento proporcional é ${formatMoney(quote.primeiro_pagamento_pro_rata.valor_primeiro_pagamento, quote.moeda)}.`
    : "";
  return {
    text: `Cotação confirmada pela API. Plano ${quote.plano_nome}: ${monthly} por mês, franquia de ${deductible}. Coberturas: ${quote.coberturas.join(", ")}.${firstPayment} Protocolo ${requestId}.`,
    outcome: "resolved",
    quote_request_id: requestId,
  };
}

function terminalReply(state: ConversationState): AgentReply {
  const requestId = state.active_quote_request_id;
  if (state.stage === "resolved") {
    return {
      text: `Esta cotação já foi concluída. Para uma nova cotação, inicie outra conversa. Protocolo ${requestId ?? "indisponível"}.`,
      outcome: "resolved",
      quote_request_id: requestId,
    };
  }
  return {
    text: `O atendimento já está com uma pessoa do time. Protocolo ${requestId ?? "indisponível"}.`,
    outcome: "handoff",
    quote_request_id: requestId,
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
  if (state.stage === "resolved") {
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
      ? `Dados corrigidos. Iniciei uma nova cotação sem aguardar a anterior. Aviso aqui quando terminar. Protocolo ${requestId}.`
      : `Dados recebidos. A cotação começou em segundo plano e eu aviso aqui quando terminar. Protocolo ${requestId}.`,
    outcome: "awaiting_data",
    quote_request_id: requestId,
  };
}

function pendingStatusReply(state: ConversationState, information: boolean): AgentReply {
  const requestId = state.active_quote_request_id;
  return {
    text: information
      ? `A API ainda está confirmando o plano, as coberturas e os valores. Não vou antecipar dados como definitivos. Protocolo ${requestId}.`
      : `A cotação segue em processamento com tentativas limitadas. Não abri outra solicitação. Protocolo ${requestId}.`,
    outcome: "awaiting_data",
    quote_request_id: requestId,
  };
}

function refusalReply(reason: string, requestId: string): AgentReply {
  return {
    text: `A API recusou a cotação: ${redactSensitiveText(reason).slice(0, 300)}. Não há preço atual para apresentar. Encaminhei o caso para orientação comercial. Protocolo ${requestId}.`,
    outcome: "handoff",
    quote_request_id: requestId,
  };
}

function failureReply(requestId: string): AgentReply {
  return {
    text: `Não consegui concluir a cotação e não vou estimar um preço. Encaminhei os dados já coletados para uma pessoa do time. Protocolo ${requestId}.`,
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
    if (["resolved", "handoff"].includes(state.stage)) {
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
    state.ambiguity_count = 0;
    const validated = validateCandidates(understanding.fields);
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
    const validated = validateCandidates(understanding.fields);
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
        "Não consegui confirmar a alteração. A cotação atual segue em processamento.",
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
  ): Promise<AgentReply> {
    state.stage = "collecting";
    const issue = errors.length > 0 ? `${errors.join(" e ")}.` : "Vamos seguir com a cotação.";
    const requested = missing.length > 0
      ? `Preciso de: ${missing.map((name) => fieldLabels[name]).join(", ")}.`
      : "Envie o dado corrigido, por favor.";
    let preface = issue;
    try {
      preface = safeNaturalPhrase(
        await this.llm.phrase({ draft: issue, missing_fields: [] }),
        issue,
      );
    } catch {
      preface = issue;
    }
    return this.finish(
      state,
      messageId,
      { text: `${preface} ${requested}`, outcome: "awaiting_data", quote_request_id: null },
      "message",
    );
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
        text: `${text} Protocolo ${state.active_quote_request_id}.`,
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
    const reply = pendingReply(requestId, corrected);
    await this.finish(state, messageId, reply, "quote_started");
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
        await this.completeFailure(state, job, "quote_refused", refusalReply(result.reason, requestId));
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
    const reply = quoteReply(quote, job.request_id);
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
    state.handoff_reason = reason;
    state.active_quote_request_id ??= this.createId();
    return this.finish(
      state,
      messageId,
      failureReply(state.active_quote_request_id),
      "handoff",
    );
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
    state.processed_messages[messageId] = reply;
    await this.store.save(state);
    await this.writeAudit(event, state, messageId, reply.outcome);
    return reply;
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
