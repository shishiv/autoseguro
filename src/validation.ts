import type {
  CandidateFields,
  CollectedFields,
  FieldOrigin,
  QuotePayload,
  RequiredFieldName,
} from "./types.ts";
import { requiredFieldNames } from "./types.ts";

export interface ValidatedValues {
  plano?: string;
  idade?: number;
  veiculo_ano?: number;
  cep?: string;
  data_inicio?: string;
}

export interface ValidationResult {
  values: ValidatedValues;
  errors: string[];
}

function normalizePlan(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const plan = value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
  return ["essencial", "completo", "premium"].includes(plan) ? plan : null;
}

function normalizeInteger(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/u.test(value.trim()))) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizeCep(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const digits = String(value).replace(/\D/gu, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : null;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? value
    : null;
}

function assignIfPresent<T>(
  candidate: unknown,
  normalized: T | null,
  name: RequiredFieldName,
  label: string,
  values: ValidatedValues,
  errors: string[],
): void {
  if (candidate === undefined || candidate === null) {
    return;
  }
  if (normalized === null) {
    errors.push(`${label} inválido`);
    return;
  }
  Object.assign(values, { [name]: normalized });
}

export function validateCandidates(candidates: CandidateFields): ValidationResult {
  const values: ValidatedValues = {};
  const errors: string[] = [];
  assignIfPresent(candidates.plano, normalizePlan(candidates.plano), "plano", "plano", values, errors);
  assignIfPresent(candidates.idade, normalizeInteger(candidates.idade, 0, 200), "idade", "idade", values, errors);
  assignIfPresent(
    candidates.veiculo_ano,
    normalizeInteger(candidates.veiculo_ano, 1950, 2100),
    "veiculo_ano",
    "ano do veículo",
    values,
    errors,
  );
  assignIfPresent(candidates.cep, normalizeCep(candidates.cep), "cep", "CEP", values, errors);
  assignIfPresent(
    candidates.data_inicio,
    normalizeDate(candidates.data_inicio),
    "data_inicio",
    "data de início",
    values,
    errors,
  );
  return { values, errors };
}

export function mergeFields(
  fields: CollectedFields,
  values: ValidatedValues,
  messageId: string,
  source: FieldOrigin["source"] = "llm",
): CollectedFields {
  const merged = { ...fields };
  for (const [name, value] of Object.entries(values)) {
    Object.assign(merged, {
      [name]: { value, origin: { message_id: messageId, source } },
    });
  }
  return merged;
}

export function hasFieldChanges(fields: CollectedFields, values: ValidatedValues): boolean {
  return Object.entries(values).some(([name, value]) => {
    const current = fields[name as RequiredFieldName];
    return current === undefined || current.value !== value;
  });
}

export function missingFields(fields: CollectedFields): RequiredFieldName[] {
  return requiredFieldNames.filter((name) => fields[name] === undefined);
}

export function toQuotePayload(fields: CollectedFields): QuotePayload {
  if (!fields.plano || !fields.idade || !fields.veiculo_ano || !fields.cep || !fields.data_inicio) {
    throw new Error("Campos obrigatórios incompletos");
  }
  return {
    plano_id: fields.plano.value,
    idade: fields.idade.value,
    veiculo_ano: fields.veiculo_ano.value,
    cep: fields.cep.value,
    data_inicio: fields.data_inicio.value,
  };
}
