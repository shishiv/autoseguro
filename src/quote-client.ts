import { performance } from "node:perf_hooks";
import type {
  ProRataPayment,
  QuoteAttempt,
  QuoteClientPort,
  QuotePayload,
  QuoteResponse,
  QuoteResult,
} from "./types.ts";

interface QuoteClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  jitterMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

interface AttemptResponse {
  response?: Response;
  record: QuoteAttempt;
}

const retryableStatuses = new Set([500, 502, 503]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMoney(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function parseProRata(value: unknown): ProRataPayment | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isFiniteNumber(value.dias_no_mes) ||
    !isFiniteNumber(value.dias_cobrados) ||
    !isMoney(value.valor_primeiro_pagamento)
  ) {
    return null;
  }
  return {
    dias_no_mes: value.dias_no_mes,
    dias_cobrados: value.dias_cobrados,
    valor_primeiro_pagamento: value.valor_primeiro_pagamento,
  };
}

function parseQuote(value: unknown): QuoteResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.plano_id !== "string" ||
    typeof value.plano_nome !== "string" ||
    !isMoney(value.premio_mensal) ||
    !isMoney(value.franquia) ||
    !Array.isArray(value.coberturas) ||
    !value.coberturas.every((item) => typeof item === "string") ||
    value.moeda !== "BRL"
  ) {
    return null;
  }
  const quote: QuoteResponse = {
    plano_id: value.plano_id,
    plano_nome: value.plano_nome,
    premio_mensal: value.premio_mensal,
    franquia: value.franquia,
    coberturas: value.coberturas,
    moeda: value.moeda,
  };
  if (value.primeiro_pagamento_pro_rata !== undefined) {
    const proRata = parseProRata(value.primeiro_pagamento_pro_rata);
    if (!proRata) {
      return null;
    }
    quote.primeiro_pagamento_pro_rata = proRata;
  }
  return quote;
}

async function errorReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.motivo === "string") {
      return body.motivo;
    }
  } catch {
    return "Cotação recusada pela API";
  }
  return "Cotação recusada pela API";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

function validPolicy(timeoutMs: number, maxAttempts: number, backoffMs: number, jitterMs: number): boolean {
  return Number.isFinite(timeoutMs)
    && timeoutMs > 0
    && timeoutMs < 8_000
    && Number.isInteger(maxAttempts)
    && maxAttempts >= 1
    && maxAttempts <= 3
    && Number.isFinite(backoffMs)
    && backoffMs >= 0
    && Number.isFinite(jitterMs)
    && jitterMs >= 0;
}

export class QuoteClient implements QuoteClientPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly jitterMs: number;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: QuoteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 200;
    this.jitterMs = options.jitterMs ?? 100;
    this.fetcher = options.fetcher ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    if (!validPolicy(this.timeoutMs, this.maxAttempts, this.baseBackoffMs, this.jitterMs)) {
      throw new Error("Política de tentativas inválida");
    }
  }

  async request(
    payload: QuotePayload,
    quoteRequestId: string,
    onAttempt: (attempt: QuoteAttempt) => Promise<void>,
    completedAttempts = 0,
    signal?: AbortSignal,
  ): Promise<QuoteResult> {
    const attempts: QuoteAttempt[] = [];
    for (let attempt = completedAttempts + 1; attempt <= this.maxAttempts; attempt += 1) {
      if (signal?.aborted) {
        return { kind: "cancelled", attempts };
      }
      const result = await this.call(payload, quoteRequestId, attempt, signal);
      const classified = await this.classify(result, completedAttempts + attempts.length + 1, attempts);
      result.record.will_retry = classified === null;
      attempts.push(result.record);
      await onAttempt(result.record);
      if (classified) {
        return classified;
      }
      await this.backoff(attempt);
    }
    return { kind: "handoff", reason: "quote_attempts_exhausted", attempts };
  }

  private async call(
    payload: QuotePayload,
    quoteRequestId: string,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<AttemptResponse> {
    const started = performance.now();
    try {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await this.fetcher(`${this.baseUrl}/quote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": quoteRequestId,
        },
        body: JSON.stringify(payload),
        signal: requestSignal,
      });
      return {
        response,
        record: {
          attempt,
          latency_ms: Math.round(performance.now() - started),
          http_status: response.status,
          failure_kind: null,
          will_retry: false,
        },
      };
    } catch (error) {
      const failureKind = signal?.aborted ? "cancelled" : isTimeout(error) ? "timeout" : "network";
      return {
        record: {
          attempt,
          latency_ms: Math.round(performance.now() - started),
          http_status: null,
          failure_kind: failureKind,
          will_retry: false,
        },
      };
    }
  }

  private async classify(
    result: AttemptResponse,
    totalAttemptCount: number,
    previousAttempts: QuoteAttempt[],
  ): Promise<QuoteResult | null> {
    const attempts = [...previousAttempts, result.record];
    if (!result.response) {
      if (result.record.failure_kind === "cancelled") {
        return { kind: "cancelled", attempts };
      }
      return result.record.failure_kind === "timeout" && totalAttemptCount < this.maxAttempts
        ? null
        : {
            kind: "handoff",
            reason: result.record.failure_kind === "timeout" ? "quote_timeout" : "quote_network_error",
            attempts,
          };
    }
    if (result.response.ok) {
      const quote = parseQuote(await result.response.json().catch(() => null));
      return quote
        ? { kind: "success", quote, attempts }
        : { kind: "handoff", reason: "invalid_quote_response", attempts };
    }
    if (result.response.status === 422) {
      return { kind: "refused", reason: await errorReason(result.response), attempts };
    }
    if (retryableStatuses.has(result.response.status)) {
      return totalAttemptCount < this.maxAttempts
        ? null
        : { kind: "handoff", reason: "quote_service_unavailable", attempts };
    }
    return {
      kind: "handoff",
      reason: result.response.status === 400 ? "invalid_quote_payload" : `quote_http_${result.response.status}`,
      attempts,
    };
  }

  private async backoff(attempt: number): Promise<void> {
    const milliseconds = this.baseBackoffMs * 2 ** (attempt - 1) + Math.floor(this.random() * this.jitterMs);
    await this.sleep(milliseconds);
  }
}
