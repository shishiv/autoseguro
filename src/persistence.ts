import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { maskCep, redactSensitiveText } from "./privacy.ts";
import type {
  AuditEvent,
  CollectedFields,
  CollectedValue,
  ConversationState,
} from "./types.ts";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const stages = new Set(["collecting", "quoting", "resolved", "handoff"]);

function statePath(directory: string, conversationId: string): string {
  if (!identifierPattern.test(conversationId)) {
    throw new Error("conversation_id inválido");
  }
  return join(directory, `${conversationId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(raw: string, conversationId: string): ConversationState {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.conversation_id !== conversationId ||
    typeof value.stage !== "string" ||
    !stages.has(value.stage) ||
    !isRecord(value.fields) ||
    !isRecord(value.processed_messages) ||
    !Array.isArray(value.quote_jobs) ||
    !Array.isArray(value.outbox) ||
    typeof value.ambiguity_count !== "number"
  ) {
    throw new Error(`Estado inválido para ${conversationId}`);
  }
  return value as unknown as ConversationState;
}

function initialState(conversationId: string): ConversationState {
  return {
    version: 2,
    conversation_id: conversationId,
    stage: "collecting",
    fields: {},
    ambiguity_count: 0,
    processed_messages: {},
    active_quote_request_id: null,
    quote_jobs: [],
    outbox: [],
    quote: null,
    handoff_reason: null,
  };
}

export class FileConversationStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async load(conversationId: string): Promise<ConversationState> {
    const path = statePath(this.directory, conversationId);
    try {
      return parseState(await readFile(path, "utf8"), conversationId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return initialState(conversationId);
    }
  }

  async save(state: ConversationState): Promise<void> {
    const path = statePath(this.directory, state.conversation_id);
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  }

  async reset(conversationId: string): Promise<void> {
    await rm(statePath(this.directory, conversationId), { force: true });
  }
}

export function fieldsForAudit(
  fields: CollectedFields,
): Record<string, CollectedValue<unknown>> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, collected]) => [
      name,
      name === "cep"
        ? { ...collected, value: maskCep(String(collected.value)) }
        : collected,
    ]),
  );
}

export class AuditLog {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const line = redactSensitiveText(JSON.stringify(event));
    await appendFile(this.path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
