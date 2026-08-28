import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "./privacy.ts";
import { AuditLog, fieldsForAudit, FileConversationStore } from "./persistence.ts";
import { mergeFields, missingFields, toQuotePayload, validateCandidates } from "./validation.ts";
import type {
  AgentReply,
  AuditEvent,
  ConversationState,
  IncomingMessage,
  LanguageModel,
  Outcome,
  QuoteAttempt,
  QuoteClientPort,
  QuoteResponse,
  RequiredFieldName,
} from "./types.ts";

interface AgentOptions {
  now?: () => Date;
  createId?: () => string;
}

const fieldLabels: Record<RequiredFieldName, string> = {
  plano: "plano (Essencial, Completo ou Premium)",
  idade: "idade",
  veiculo_ano: "ano do veículo",
  cep: "CEP onde o veículo dorme",
  data_inicio: "data de início (AAAA-MM-DD)",
};
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

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
  const requestId = state.quote_request_id ?? null;
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

export class AutoSeguroAgent {
  private readonly store: FileConversationStore;
  private readonly audit: AuditLog;
  private readonly llm: LanguageModel;
  private readonly quoteClient: QuoteClientPort;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly inFlight = new Map<string, Promise<AgentReply>>();

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
  }

  async handle(input: IncomingMessage): Promise<AgentReply> {
    validateMessage(input);
    const key = `${input.conversation_id}:${input.message_id}`;
    const active = this.inFlight.get(key);
    if (active) {
      return active;
    }
    const task = this.process(input);
    this.inFlight.set(key, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async process(input: IncomingMessage): Promise<AgentReply> {
    const state = await this.store.load(input.conversation_id);
    const duplicate = state.processed_messages[input.message_id];
    if (duplicate) {
      await this.writeAudit("message", state, input.message_id, duplicate.outcome);
      return duplicate;
    }
    if (state.stage === "resolved" || state.stage === "handoff") {
      return this.finish(state, input.message_id, terminalReply(state), "message");
    }
    if (input.message_type !== "text") {
      return this.handoff(state, input.message_id, "unprocessed_media");
    }
    const understanding = await this.understandOrHandoff(state, input);
    if (!understanding) {
      return this.handoff(state, input.message_id, "llm_unavailable");
    }
    if (understanding.intent === "human") {
      return this.handoff(state, input.message_id, "human_requested");
    }
    if (understanding.intent === "unsupported") {
      return this.handoff(state, input.message_id, "unsupported_request");
    }
    if (understanding.ambiguous) {
      return this.handleAmbiguity(state, input.message_id);
    }
    state.ambiguity_count = 0;
    const validated = validateCandidates(understanding.fields);
    state.fields = mergeFields(state.fields, validated.values, input.message_id);
    const missing = missingFields(state.fields);
    if (validated.errors.length > 0 || missing.length > 0) {
      return this.awaitData(state, input.message_id, missing, validated.errors);
    }
    return this.requestQuote(state, input.message_id);
  }

  private async understandOrHandoff(
    state: ConversationState,
    input: IncomingMessage,
  ): Promise<Awaited<ReturnType<LanguageModel["understand"]>> | null> {
    try {
      return await this.llm.understand({
        text: redactSensitiveText(input.text),
        missing_fields: missingFields(state.fields),
        current_date: this.now().toISOString().slice(0, 10),
      });
    } catch {
      return null;
    }
  }

  private async handleAmbiguity(state: ConversationState, messageId: string): Promise<AgentReply> {
    state.ambiguity_count += 1;
    if (state.ambiguity_count >= 2) {
      return this.handoff(state, messageId, "repeated_ambiguity");
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

  private async requestQuote(state: ConversationState, messageId: string): Promise<AgentReply> {
    state.stage = "quoting";
    state.quote_request_id ??= this.createId();
    await this.store.save(state);
    const requestId = state.quote_request_id;
    const result = await this.quoteClient.request(
      toQuotePayload(state.fields),
      requestId,
      async (attempt) => {
        await this.writeAudit(
          "quote_attempt",
          state,
          messageId,
          attemptOutcome(attempt),
          attempt,
        );
      },
    );
    if (result.kind === "success") {
      state.stage = "resolved";
      state.quote = result.quote;
      return this.finish(state, messageId, quoteReply(result.quote, requestId), "message");
    }
    if (result.kind === "refused") {
      state.stage = "handoff";
      state.handoff_reason = "quote_refused";
      const reason = redactSensitiveText(result.reason).slice(0, 300);
      return this.finish(
        state,
        messageId,
        {
          text: `A API recusou a cotação: ${reason}. Não há preço atual para apresentar. Encaminhei o caso para orientação comercial. Protocolo ${requestId}.`,
          outcome: "handoff",
          quote_request_id: requestId,
        },
        "handoff",
      );
    }
    return this.handoff(state, messageId, result.reason);
  }

  private async handoff(
    state: ConversationState,
    messageId: string,
    reason: string,
  ): Promise<AgentReply> {
    state.stage = "handoff";
    state.handoff_reason = reason;
    state.quote_request_id ??= this.createId();
    const reply: AgentReply = {
      text: `Não consegui concluir a cotação e não vou estimar um preço. Encaminhei os dados já coletados para uma pessoa do time. Protocolo ${state.quote_request_id}.`,
      outcome: "handoff",
      quote_request_id: state.quote_request_id,
    };
    return this.finish(state, messageId, reply, "handoff");
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
    attempt?: QuoteAttempt,
  ): Promise<void> {
    await this.audit.append({
      event,
      conversation_id: state.conversation_id,
      message_id: messageId,
      timestamp: this.now().toISOString(),
      stage: state.stage,
      collected_fields: fieldsForAudit(state.fields),
      quote_request_id: state.quote_request_id ?? null,
      attempt: attempt?.attempt ?? null,
      latency_ms: attempt?.latency_ms ?? null,
      http_status: attempt?.http_status ?? null,
      outcome,
      handoff_reason: state.handoff_reason ?? null,
      failure_kind: attempt?.failure_kind ?? null,
    });
  }
}
