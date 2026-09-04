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

function normalizeYear(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1950 && value <= 2100 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}$/u.test(trimmed)) {
      const parsed = Number(trimmed);
      return parsed >= 1950 && parsed <= 2100 ? parsed : null;
    }
    const match = /\b(19[5-9]\d|20\d{2}|2100)\b/u.exec(trimmed);
    if (match && match[1]) {
      return Number(match[1]);
    }
  }
  return null;
}

function normalizeCep(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const digits = String(value).replace(/\D/gu, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : null;
}

function normalizeDate(value: unknown, currentDate: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
  const today = parseIsoDate(currentDate);
  if (!today) {
    return null;
  }
  if (text === "hoje" || text === "amanha") {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + (text === "amanha" ? 1 : 0));
    return date.toISOString().slice(0, 10);
  }
  const parts = /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/u.exec(text);
  const iso = parts ? `${parts[3]}-${parts[2]}-${parts[1]}` : text;
  const date = parseIsoDate(iso);
  return date && date >= today ? iso : null;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
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

export function validateCandidates(
  candidates: CandidateFields,
  currentDate = new Date().toISOString().slice(0, 10),
): ValidationResult {
  const values: ValidatedValues = {};
  const errors: string[] = [];
  assignIfPresent(candidates.plano, normalizePlan(candidates.plano), "plano", "plano", values, errors);
  assignIfPresent(candidates.idade, normalizeInteger(candidates.idade, 0, 200), "idade", "idade", values, errors);
  assignIfPresent(
    candidates.veiculo_ano,
    normalizeYear(candidates.veiculo_ano),
    "veiculo_ano",
    "ano do veículo",
    values,
    errors,
  );
  assignIfPresent(candidates.cep, normalizeCep(candidates.cep), "cep", "CEP", values, errors);
  assignIfPresent(
    candidates.data_inicio,
    normalizeDate(candidates.data_inicio, currentDate),
    "data_inicio",
    "data de início",
    values,
    errors,
  );
  return { values, errors };
}

export function validateField(
  name: RequiredFieldName,
  value: unknown,
  currentDate: string,
): ValidationResult {
  return validateCandidates({ [name]: value }, currentDate);
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
