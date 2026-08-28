export const requiredFieldNames = [
  "plano",
  "idade",
  "veiculo_ano",
  "cep",
  "data_inicio",
] as const;

export type RequiredFieldName = (typeof requiredFieldNames)[number];
export type ConversationStage = "collecting" | "quoting" | "resolved" | "handoff";
export type Outcome = "resolved" | "awaiting_data" | "refused" | "handoff";
export type MessageType = "text" | "audio" | "image" | "document";
export type QuoteJobStatus = "pending" | "retrying" | "delivered" | "failed";

export interface FieldOrigin {
  message_id: string;
  source: "llm" | "deterministic";
}

export interface CollectedValue<T> {
  value: T;
  origin: FieldOrigin;
}

export interface CollectedFields {
  plano?: CollectedValue<string>;
  idade?: CollectedValue<number>;
  veiculo_ano?: CollectedValue<number>;
  cep?: CollectedValue<string>;
  data_inicio?: CollectedValue<string>;
}

export interface QuotePayload {
  plano_id: string;
  idade: number;
  veiculo_ano: number;
  cep: string;
  data_inicio: string;
}

export interface ProRataPayment {
  dias_no_mes: number;
  dias_cobrados: number;
  valor_primeiro_pagamento: number;
}

export interface QuoteResponse {
  plano_id: string;
  plano_nome: string;
  premio_mensal: number;
  franquia: number;
  coberturas: string[];
  moeda: string;
  primeiro_pagamento_pro_rata?: ProRataPayment;
}

export interface QuoteAttempt {
  attempt: number;
  latency_ms: number;
  http_status: number | null;
  failure_kind: "timeout" | "network" | "cancelled" | null;
  will_retry: boolean;
}

export interface QuoteTransition {
  status: QuoteJobStatus;
  timestamp: string;
  reason: string | null;
}

export interface QuoteJob {
  request_id: string;
  initiated_by_message_id: string;
  payload: QuotePayload;
  fields: CollectedFields;
  status: QuoteJobStatus;
  attempts: QuoteAttempt[];
  transitions: QuoteTransition[];
  created_at: string;
  updated_at: string;
  failure_reason: string | null;
}

export interface AgentReply {
  text: string;
  outcome: Outcome;
  quote_request_id: string | null;
}

export interface OutboxMessage extends AgentReply {
  id: string;
  source_message_id: string;
  created_at: string;
  delivered_at: string | null;
}

export interface ConversationState {
  version: 2;
  conversation_id: string;
  stage: ConversationStage;
  fields: CollectedFields;
  ambiguity_count: number;
  processed_messages: Record<string, AgentReply>;
  active_quote_request_id: string | null;
  quote_jobs: QuoteJob[];
  outbox: OutboxMessage[];
  quote: QuoteResponse | null;
  handoff_reason: string | null;
}

export interface IncomingMessage {
  conversation_id: string;
  message_id: string;
  text: string;
  message_type: MessageType;
}

export interface CandidateFields {
  plano?: unknown;
  idade?: unknown;
  veiculo_ano?: unknown;
  cep?: unknown;
  data_inicio?: unknown;
}

export interface LanguageUnderstanding {
  fields: CandidateFields;
  intent: "continue" | "status" | "information" | "human" | "unsupported";
  ambiguous: boolean;
}

export interface UnderstandingInput {
  text: string;
  missing_fields: RequiredFieldName[];
  current_date: string;
}

export interface ReplyInput {
  draft: string;
  missing_fields: RequiredFieldName[];
}

export interface LanguageModel {
  understand(input: UnderstandingInput): Promise<LanguageUnderstanding>;
  phrase(input: ReplyInput): Promise<string>;
}

export type QuoteResult =
  | { kind: "success"; quote: QuoteResponse; attempts: QuoteAttempt[] }
  | { kind: "refused"; reason: string; attempts: QuoteAttempt[] }
  | { kind: "handoff"; reason: string; attempts: QuoteAttempt[] }
  | { kind: "cancelled"; attempts: QuoteAttempt[] };

export interface QuoteClientPort {
  request(
    payload: QuotePayload,
    quoteRequestId: string,
    onAttempt: (attempt: QuoteAttempt) => Promise<void>,
    completedAttempts?: number,
    signal?: AbortSignal,
  ): Promise<QuoteResult>;
}

export interface AuditEvent {
  event: "message" | "quote_started" | "quote_attempt" | "quote_completed" | "quote_ignored" | "handoff" | "outbox_delivered";
  conversation_id: string;
  message_id: string;
  timestamp: string;
  stage: ConversationStage;
  collected_fields: Record<string, CollectedValue<unknown>>;
  quote_request_id: string | null;
  quote_status: QuoteJobStatus | null;
  attempt: number | null;
  latency_ms: number | null;
  http_status: number | null;
  outcome: Outcome;
  handoff_reason: string | null;
  failure_kind: "timeout" | "network" | "cancelled" | null;
}
