import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { AutoSeguroAgent } from "./agent.ts";
import { FileConversationStore } from "./persistence.ts";
import type { ActionId, AgentReply, IncomingMessage, MessageType, OutboxMessage, ReplyInteraction } from "./types.ts";

export const META_GRAPH_VERSION = "v25.0";
export const TEST_WABA_ID = "917767274033519";
export const TEST_PHONE_NUMBER_ID = "946560951879475";

export interface MetaRuntimeConfig {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  allowedRecipient: string;
  publicBaseUrl: string;
}

interface MetaIncoming {
  metaMessageId: string;
  internalMessage: IncomingMessage;
  recipient: string;
}

interface MetaFailure {
  timestamp: string;
  http_status: number | null;
  error_code: string;
  error_subcode: number | null;
}

interface MetaDelivery {
  outbound_message_id: string | null;
  delivered_at: string | null;
  failures: MetaFailure[];
}

interface SealedPayload {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface IntakePayload {
  recipient: string;
  text: string;
  action?: ActionId;
}

interface MetaIntakeRecord {
  version: 1;
  meta_message_id: string;
  internal_message_id: string;
  conversation_id: string;
  sealed_payload: SealedPayload | null;
  message_type: MessageType;
  received_at: string;
  immediate: MetaDelivery;
  final: Record<string, MetaDelivery>;
  completed_at: string | null;
}

interface MetaGraphErrorBody {
  error?: {
    code?: unknown;
    error_subcode?: unknown;
  };
}

interface MetaGraphSuccessBody {
  messages?: Array<{ id?: unknown }>;
}

interface MetaTransportOptions {
  now?: () => Date;
  retryMs?: number;
  typingDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
}

const emptyDelivery = (): MetaDelivery => ({
  outbound_message_id: null,
  delivered_at: null,
  failures: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePhone(value: string): string {
  return value.replace(/\D/gu, "");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function textMessage(value: Record<string, unknown>): string {
  const text = value.text;
  if (
    !isRecord(text)
    || typeof text.body !== "string"
    || text.body.trim() === ""
    || text.body.length > 10_000
  ) {
    throw new MetaWebhookError(400, "malformed_payload");
  }
  return text.body;
}

const actionIds = new Set<ActionId>([
  "quote_start", "plans_view", "human_help", "quote_new", "service_end",
  "csat_great", "csat_regular", "csat_bad", "plan_essencial", "plan_completo", "plan_premium",
  "date_today", "date_tomorrow", "date_other",
]);

function interactiveAction(value: Record<string, unknown>): { action: ActionId; text: string } | null {
  if (value.type !== "interactive" || !isRecord(value.interactive)) {
    return null;
  }
  const interactive = value.interactive;
  const reply = interactive.type === "button_reply" ? interactive.button_reply : interactive.list_reply;
  if (!isRecord(reply) || typeof reply.id !== "string" || typeof reply.title !== "string" || !actionIds.has(reply.id as ActionId)) {
    throw new MetaWebhookError(400, "malformed_payload");
  }
  return { action: reply.id as ActionId, text: reply.title };
}

function messageType(value: Record<string, unknown>): MessageType {
  if (value.type === "interactive") {
    return "text";
  }
  if (value.type === "text" || value.type === "audio" || value.type === "image" || value.type === "document") {
    return value.type;
  }
  return "document";
}

function parseMessage(value: unknown, config: MetaRuntimeConfig): MetaIncoming {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.from !== "string") {
    throw new MetaWebhookError(400, "malformed_payload");
  }
  const recipient = normalizePhone(value.from);
  if (recipient !== config.allowedRecipient) {
    throw new MetaWebhookError(403, "recipient_not_allowlisted");
  }
  const action = interactiveAction(value);
  const type = messageType(value);
  const hash = digest(value.id);
  return {
    metaMessageId: value.id,
    recipient,
    internalMessage: {
      conversation_id: `wa-${digest(recipient)}`,
      message_id: `wamid-${hash}`,
      message_type: type,
      text: action?.text ?? (type === "text" ? textMessage(value) : `[unsupported:${String(value.type ?? "unknown")}]`),
      ...(action ? { action: action.action } : {}),
    },
  };
}

function parseChange(value: unknown, config: MetaRuntimeConfig): MetaIncoming[] {
  if (!isRecord(value) || value.field !== "messages" || !isRecord(value.value)) {
    return [];
  }
  const metadata = value.value.metadata;
  if (!isRecord(metadata) || metadata.phone_number_id !== config.phoneNumberId) {
    throw new MetaWebhookError(403, "wrong_phone_number");
  }
  if (value.value.messages === undefined) {
    return [];
  }
  if (!Array.isArray(value.value.messages)) {
    throw new MetaWebhookError(400, "malformed_payload");
  }
  return value.value.messages.map((message) => parseMessage(message, config));
}

function parseEntry(value: unknown, config: MetaRuntimeConfig): MetaIncoming[] {
  if (!isRecord(value) || value.id !== config.wabaId || !Array.isArray(value.changes)) {
    throw new MetaWebhookError(403, "wrong_waba");
  }
  return value.changes.flatMap((change) => parseChange(change, config));
}

export function parseMetaWebhook(rawBody: Buffer, config: MetaRuntimeConfig): MetaIncoming[] {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new MetaWebhookError(400, "malformed_json");
  }
  if (!isRecord(body) || body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) {
    throw new MetaWebhookError(400, "malformed_payload");
  }
  return body.entry.flatMap((entry) => parseEntry(entry, config));
}

export function verifyMetaSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[a-f\d]{64}$/u.test(signature)) {
    return false;
  }
  const supplied = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export class MetaWebhookError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export class MetaSendError extends Error {
  readonly httpStatus: number | null;
  readonly errorCode: string;
  readonly errorSubcode: number | null;

  constructor(httpStatus: number | null, errorCode: string, errorSubcode: number | null = null) {
    super("Meta outbound delivery failed");
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.errorSubcode = errorSubcode;
  }
}

export class MetaGraphClient {
  private readonly config: MetaRuntimeConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: MetaRuntimeConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  async sendPresence(messageId: string): Promise<void> {
    const body = await this.post({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }, 1_000) as { success?: unknown };
    if (body.success !== true) {
      throw new MetaSendError(200, "missing_success");
    }
  }

  async sendText(recipient: string, text: string): Promise<string> {
    return this.send(recipient, { type: "text", text: { body: text } });
  }

  async sendInteractive(recipient: string, text: string, interaction: ReplyInteraction): Promise<string> {
    const interactive = interaction.kind === "buttons"
      ? {
        type: "button",
        body: { text },
        action: { buttons: interaction.actions.map((action) => ({ type: "reply", reply: action })) },
      }
      : {
        type: "list",
        body: { text },
        action: {
          button: interaction.button_label ?? "Opções",
          sections: [{
            title: "Planos",
            rows: interaction.actions.map((action) => {
              const [title, description] = action.title.split(" — ");
              return { id: action.id, title, description };
            }),
          }],
        },
      };
    return this.send(recipient, { type: "interactive", interactive });
  }

  private async send(recipient: string, payload: Record<string, unknown>): Promise<string> {
    if (normalizePhone(recipient) !== this.config.allowedRecipient) {
      throw new MetaSendError(null, "recipient_not_allowlisted");
    }
    const body = await this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      ...payload,
    }, 10_000) as MetaGraphSuccessBody;
    const id = body.messages?.[0]?.id;
    if (typeof id !== "string" || id === "") {
      throw new MetaSendError(200, "missing_message_id");
    }
    return id;
  }

  private async post(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${this.config.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch {
      throw new MetaSendError(null, "network");
    }
    const body = await response.json().catch(() => ({})) as MetaGraphErrorBody;
    if (!response.ok) {
      const code = typeof body.error?.code === "number" ? String(body.error.code) : "http_error";
      const subcode = typeof body.error?.error_subcode === "number" ? body.error.error_subcode : null;
      throw new MetaSendError(response.status, code, subcode);
    }
    return body;
  }
}

export class MetaInbox {
  private readonly directory: string;
  private readonly key: Buffer;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(directory: string, encryptionSecret: string) {
    this.directory = directory;
    this.key = createHash("sha256").update(encryptionSecret).digest();
  }

  async add(messages: MetaIncoming[], timestamp: string): Promise<number> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let added = 0;
    for (const message of messages) {
      const record: MetaIntakeRecord = {
        version: 1,
        meta_message_id: message.metaMessageId,
        internal_message_id: message.internalMessage.message_id,
        conversation_id: message.internalMessage.conversation_id,
        sealed_payload: this.seal(message.internalMessage.message_id, {
          recipient: message.recipient,
          text: message.internalMessage.text,
          ...(message.internalMessage.action ? { action: message.internalMessage.action } : {}),
        }),
        message_type: message.internalMessage.message_type,
        received_at: timestamp,
        immediate: emptyDelivery(),
        final: {},
        completed_at: null,
      };
      try {
        await writeFile(this.path(record.internal_message_id), `${JSON.stringify(record)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        added += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }
    return added;
  }

  async open(): Promise<MetaIntakeRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const records = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => this.read(join(this.directory, name))),
    );
    return records.filter((record) => record.completed_at === null);
  }

  async byInternalMessageId(messageId: string): Promise<MetaIntakeRecord> {
    return this.read(this.path(messageId));
  }

  payload(record: MetaIntakeRecord): IntakePayload {
    if (!record.sealed_payload) {
      throw new Error("Payload do intake Meta ausente");
    }
    const sealed = record.sealed_payload;
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(record.internal_message_id));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as IntakePayload;
  }

  async recordSuccess(
    messageId: string,
    deliveryKind: "immediate" | "final",
    outboundId: string,
    timestamp: string,
    outboxId?: string,
  ): Promise<void> {
    await this.update(messageId, (record) => {
      const delivery = this.delivery(record, deliveryKind, outboxId);
      delivery.outbound_message_id = outboundId;
      delivery.delivered_at = timestamp;
    });
  }

  async recordFailure(
    messageId: string,
    deliveryKind: "immediate" | "final",
    error: MetaSendError,
    timestamp: string,
    outboxId?: string,
  ): Promise<void> {
    await this.update(messageId, (record) => {
      this.delivery(record, deliveryKind, outboxId).failures.push({
        timestamp,
        http_status: error.httpStatus,
        error_code: error.errorCode,
        error_subcode: error.errorSubcode,
      });
    });
  }

  async completeConversation(conversationId: string, timestamp: string): Promise<void> {
    const records = (await this.open()).filter((record) => (
      record.conversation_id === conversationId && record.immediate.delivered_at !== null
    ));
    await Promise.all(records.map((record) => this.update(record.internal_message_id, (current) => {
      current.sealed_payload = null;
      current.completed_at = timestamp;
    })));
  }

  private delivery(
    record: MetaIntakeRecord,
    kind: "immediate" | "final",
    outboxId: string | undefined,
  ): MetaDelivery {
    if (kind === "immediate") {
      return record.immediate;
    }
    if (!outboxId) {
      throw new Error("outboxId ausente");
    }
    record.final[outboxId] ??= emptyDelivery();
    return record.final[outboxId];
  }

  private seal(messageId: string, payload: IntakePayload): SealedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(messageId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  private path(messageId: string): string {
    const hash = messageId.startsWith("wamid-") ? messageId.slice(6) : digest(messageId);
    return join(this.directory, `${hash}.json`);
  }

  private async read(path: string): Promise<MetaIntakeRecord> {
    const value = JSON.parse(await readFile(path, "utf8")) as MetaIntakeRecord;
    if (value.version !== 1 || typeof value.internal_message_id !== "string") {
      throw new Error("Registro de intake Meta inválido");
    }
    return value;
  }

  private async update(messageId: string, change: (record: MetaIntakeRecord) => void): Promise<void> {
    const path = this.path(messageId);
    await this.locked(path, async () => {
      const record = await this.read(path);
      change(record);
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    });
  }

  private async locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }
}

export class MetaTransport {
  private readonly agent: AutoSeguroAgent;
  private readonly store: FileConversationStore;
  private readonly inbox: MetaInbox;
  private readonly graph: MetaGraphClient;
  private readonly config: MetaRuntimeConfig;
  private readonly now: () => Date;
  private readonly retryMs: number;
  private readonly typingDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly log: (event: Record<string, unknown>) => void;
  private drainPromise: Promise<void> | null = null;
  private drainRequested = false;
  private readonly watchers = new Map<string, Promise<void>>();
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    agent: AutoSeguroAgent,
    store: FileConversationStore,
    inbox: MetaInbox,
    graph: MetaGraphClient,
    config: MetaRuntimeConfig,
    options: MetaTransportOptions = {},
  ) {
    this.agent = agent;
    this.store = store;
    this.inbox = inbox;
    this.graph = graph;
    this.config = config;
    this.now = options.now ?? (() => new Date());
    this.retryMs = options.retryMs ?? 5_000;
    this.typingDelayMs = options.typingDelayMs ?? 250;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    if (!Number.isInteger(this.typingDelayMs) || this.typingDelayMs < 0 || this.typingDelayMs > 1_000) {
      throw new Error("META_TYPING_DELAY_MS deve estar entre 0 e 1000");
    }
    this.log = options.log ?? (() => undefined);

  }

  async intake(rawBody: Buffer, signature: string | undefined): Promise<number> {
    if (!verifyMetaSignature(rawBody, signature, this.config.appSecret)) {
      throw new MetaWebhookError(401, "invalid_signature");
    }
    const messages = parseMetaWebhook(rawBody, this.config);
    return this.inbox.add(messages, this.timestamp());
  }

  kick(): void {
    this.drainRequested = true;
    if (this.drainPromise) {
      return;
    }
    this.drainPromise = this.drainRequestedWork().finally(() => {
      this.drainPromise = null;
      if (this.drainRequested) {
        this.kick();
      }
    });
    void this.drainPromise.catch(() => this.scheduleRetry());
  }

  async recover(): Promise<void> {
    this.kick();
    await this.drainPromise;
  }

  async waitForIdle(): Promise<void> {
    while (this.drainPromise || this.watchers.size > 0) {
      const pending = [
        ...(this.drainPromise ? [this.drainPromise] : []),
        ...this.watchers.values(),
      ];
      await Promise.allSettled(pending);
    }
  }

  stop(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }


  private async drainRequestedWork(): Promise<void> {
    while (this.drainRequested) {
      this.drainRequested = false;
      await this.drain();
    }
  }
  private async drain(): Promise<void> {
    const records = await this.inbox.open();
    let failed = false;
    for (const record of records) {
      try {
        await this.processImmediate(record);
        this.watch(record.conversation_id);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      this.scheduleRetry();
    }
  }

  private async processImmediate(record: MetaIntakeRecord): Promise<void> {
    if (record.immediate.delivered_at !== null) {
      return;
    }
    const payload = this.inbox.payload(record);
    const reply = await this.agent.handle({
      conversation_id: record.conversation_id,
      message_id: record.internal_message_id,
      message_type: record.message_type,
      text: payload.text,
      ...(payload.action ? { action: payload.action } : {}),
    });
    await this.sendImmediate(record, payload.recipient, reply);
  }

  private async sendImmediate(record: MetaIntakeRecord, recipient: string, reply: AgentReply): Promise<void> {
    await this.showPresence(record, reply, "immediate", 0);
    const timestamp = this.timestamp();
    try {
      const outboundId = await this.sendReply(record, recipient, reply, "immediate", 0);
      await this.inbox.recordSuccess(record.internal_message_id, "immediate", outboundId, timestamp);
      this.logDelivery(record, reply, "immediate", "delivered", timestamp, outboundId, null, 0);
    } catch (error) {
      const failure = error instanceof MetaSendError ? error : new MetaSendError(null, "unknown");
      await this.inbox.recordFailure(record.internal_message_id, "immediate", failure, timestamp);
      this.logDelivery(record, reply, "immediate", "failed", timestamp, null, failure, 0);
      throw failure;
    }
  }

  private watch(conversationId: string): void {
    if (this.watchers.has(conversationId)) {
      return;
    }
    const watcher = this.deliverFinal(conversationId).then(
      () => {
        this.watchers.delete(conversationId);
        this.kick();
      },
      () => {
        this.watchers.delete(conversationId);
        this.scheduleRetry();
      },
    );
    this.watchers.set(conversationId, watcher);
  }

  private async deliverFinal(conversationId: string): Promise<void> {
    await this.agent.resume(conversationId);
    await this.agent.waitForIdle(conversationId);
    const before = await this.store.load(conversationId);
    const attempts = new Map(before.quote_jobs.map((job) => [job.request_id, job.attempts.length]));
    await this.agent.deliverOutbox(
      conversationId,
      (message) => this.sendFinal(message, attempts.get(message.quote_request_id ?? "") ?? 0),
    );
    const after = await this.store.load(conversationId);
    if (after.outbox.every((message) => message.delivered_at !== null)) {
      await this.inbox.completeConversation(conversationId, this.timestamp());
    }
  }

  private async sendFinal(message: OutboxMessage, attempts: number): Promise<void> {
    const record = await this.inbox.byInternalMessageId(message.source_message_id);
    const prior = record.final[message.id];
    if (prior?.outbound_message_id) {
      return;
    }
    const payload = this.inbox.payload(record);
    await this.showPresence(record, message, "final", attempts);
    const timestamp = this.timestamp();
    try {
      const outboundId = await this.sendReply(record, payload.recipient, message, "final", attempts);
      await this.inbox.recordSuccess(message.source_message_id, "final", outboundId, timestamp, message.id);
      this.logDelivery(record, message, "final", "delivered", timestamp, outboundId, null, attempts);
    } catch (error) {
      const failure = error instanceof MetaSendError ? error : new MetaSendError(null, "unknown");
      await this.inbox.recordFailure(message.source_message_id, "final", failure, timestamp, message.id);
      this.logDelivery(record, message, "final", "failed", timestamp, null, failure, attempts);
      throw failure;
    }
  }

  private async sendReply(
    record: MetaIntakeRecord,
    recipient: string,
    reply: AgentReply,
    delivery: "immediate" | "final",
    quoteAttempts: number,
  ): Promise<string> {
    if (!reply.interaction) {
      return this.graph.sendText(recipient, reply.text);
    }
    try {
      return await this.graph.sendInteractive(recipient, reply.text, reply.interaction);
    } catch (error) {
      const failure = error instanceof MetaSendError ? error : new MetaSendError(null, "unknown");
      this.log({
        event: "meta_interaction",
        timestamp: this.timestamp(),
        delivery,
        status: "fallback",
        inbound_message_id: record.internal_message_id,
        quote_attempts: quoteAttempts,
        http_status: failure.httpStatus,
        error_code: failure.errorCode,
      });
      return this.graph.sendText(recipient, this.plainText(reply));
    }
  }

  private plainText(reply: AgentReply): string {
    if (!reply.interaction) {
      return reply.text;
    }
    return `${reply.text}\n\n${reply.interaction.actions.map((action, index) => `${index + 1}. ${action.title}`).join("\n")}`;
  }

  private async showPresence(
    record: MetaIntakeRecord,
    reply: AgentReply,
    delivery: "immediate" | "final",
    quoteAttempts: number,
  ): Promise<void> {
    const timestamp = this.timestamp();
    try {
      await this.graph.sendPresence(record.meta_message_id);
      this.logPresence(record, reply, delivery, "delivered", timestamp, null, quoteAttempts);
      await this.sleep(this.typingDelayMs);
    } catch (error) {
      const failure = error instanceof MetaSendError ? error : new MetaSendError(null, "unknown");
      this.logPresence(record, reply, delivery, "failed", timestamp, failure, quoteAttempts);
    }
  }

  private logPresence(
    record: MetaIntakeRecord,
    reply: AgentReply,
    delivery: "immediate" | "final",
    status: "delivered" | "failed",
    timestamp: string,
    failure: MetaSendError | null,
    quoteAttempts: number,
  ): void {
    this.log({
      event: "meta_presence",
      timestamp,
      received_at: record.received_at,
      delivery,
      status,
      inbound_message_id: record.internal_message_id,
      quote_request_id: reply.quote_request_id,
      quote_attempts: quoteAttempts,
      outcome: reply.outcome,
      http_status: failure?.httpStatus ?? null,
      error_code: failure?.errorCode ?? null,
    });
  }

  private logDelivery(
    record: MetaIntakeRecord,
    reply: AgentReply,
    delivery: "immediate" | "final",
    status: "delivered" | "failed",
    timestamp: string,
    outboundId: string | null,
    failure: MetaSendError | null,
    quoteAttempts: number,
  ): void {
    this.log({
      event: "meta_delivery",
      timestamp,
      received_at: record.received_at,
      delivery,
      status,
      inbound_message_id: record.internal_message_id,
      outbound_message_id: outboundId ? `sha256:${digest(outboundId)}` : null,
      quote_request_id: reply.quote_request_id,
      quote_attempts: quoteAttempts,
      outcome: reply.outcome,
      http_status: failure?.httpStatus ?? null,
      error_code: failure?.errorCode ?? null,
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, this.retryMs);
    this.retryTimer.unref();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

async function readBody(request: HttpRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new MetaWebhookError(413, "payload_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function verifyWebhook(url: URL, config: MetaRuntimeConfig, response: ServerResponse): void {
  const valid = url.searchParams.get("hub.mode") === "subscribe"
    && url.searchParams.get("hub.verify_token") === config.verifyToken;
  const challenge = url.searchParams.get("hub.challenge");
  if (!valid || challenge === null) {
    sendJson(response, 403, { error: "verification_failed" });
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end(challenge);
}

export function createMetaHttpHandler(
  config: MetaRuntimeConfig,
  transport: MetaTransport,
  revision = "unknown",
): (request: HttpRequest, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", config.publicBaseUrl);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", revision });
      return;
    }
    if (request.method === "GET" && url.pathname === "/webhook") {
      verifyWebhook(url, config, response);
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = await readBody(request);
      await transport.intake(body, firstHeader(request.headers["x-hub-signature-256"]));
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("EVENT_RECEIVED");
      transport.kick();
    } catch (error) {
      const failure = error instanceof MetaWebhookError
        ? error
        : new MetaWebhookError(500, "intake_failed");
      sendJson(response, failure.status, { error: failure.code });
    }
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Configure ${name}`);
  }
  return value;
}

function assertMetaTarget(config: MetaRuntimeConfig): void {
  if (config.wabaId !== TEST_WABA_ID || config.phoneNumberId !== TEST_PHONE_NUMBER_ID) {
    throw new Error("Esta integração aceita somente o WABA e o número Meta de teste");
  }
  if (!/^\d{8,15}$/u.test(config.allowedRecipient)) {
    throw new Error("META_ALLOWED_RECIPIENT deve ser um único telefone válido");
  }
  const publicUrl = new URL(config.publicBaseUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.hostname === "api.triangulotec.com.br") {
    throw new Error("PUBLIC_BASE_URL deve usar HTTPS em um host isolado");
  }
}

export function metaRuntimeConfig(env: NodeJS.ProcessEnv = process.env): MetaRuntimeConfig {
  const config = {
    wabaId: requiredEnv(env, "META_WABA_ID"),
    phoneNumberId: requiredEnv(env, "META_PHONE_NUMBER_ID"),
    accessToken: requiredEnv(env, "META_ACCESS_TOKEN"),
    appSecret: requiredEnv(env, "META_APP_SECRET"),
    verifyToken: requiredEnv(env, "META_VERIFY_TOKEN"),
    allowedRecipient: normalizePhone(requiredEnv(env, "META_ALLOWED_RECIPIENT")),
    publicBaseUrl: requiredEnv(env, "PUBLIC_BASE_URL").replace(/\/$/u, ""),
  };
  assertMetaTarget(config);
  return config;
}
