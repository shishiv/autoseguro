import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { AutoSeguroAgent } from "./agent.ts";
import { actionFromChoice, renderPlainText } from "./interactions.ts";
import { OpenAICompatibleLlm } from "./llm.ts";
import { AuditLog, FileConversationStore } from "./persistence.ts";
import { redactSensitiveText } from "./privacy.ts";
import { QuoteClient } from "./quote-client.ts";
import type { AgentReply, IncomingMessage, MessageType, OutboxMessage } from "./types.ts";

interface ReplayRecord {
  conversation_id?: unknown;
  message_id?: unknown;
  message_index?: unknown;
  sender_role?: unknown;
  message_type?: unknown;
  message_body?: unknown;
  text?: unknown;
}

const messageTypes = new Set<MessageType>(["text", "audio", "image", "document"]);

function readReplayRecord(line: string, fallbackConversationId: string, index: number): IncomingMessage | null {
  const record = JSON.parse(line) as ReplayRecord;
  if (record.sender_role !== undefined && record.sender_role !== "lead") {
    return null;
  }
  const conversationId = typeof record.conversation_id === "string"
    ? record.conversation_id
    : fallbackConversationId;
  const text = typeof record.text === "string" ? record.text : record.message_body;
  const rawType = typeof record.message_type === "string" ? record.message_type : "text";
  if (typeof text !== "string" || !messageTypes.has(rawType as MessageType)) {
    throw new Error(`Linha ${index + 1} do replay é inválida`);
  }
  const sourceIndex = typeof record.message_index === "number" ? record.message_index : index;
  const messageId = typeof record.message_id === "string"
    ? record.message_id
    : `${conversationId}-${sourceIndex}`;
  return {
    conversation_id: conversationId,
    message_id: messageId,
    message_type: rawType as MessageType,
    text,
  };
}

function printReply(prefix: string, reply: AgentReply): void {
  console.log(`${prefix}${renderPlainText(reply)}`);
}

function printAsyncReply(message: OutboxMessage): void {
  printReply("AutoSeguro [assíncrono]: ", message);
}

async function emitReady(
  agent: AutoSeguroAgent,
  conversationId: string,
  onReply: (reply: AgentReply) => void = () => undefined,
): Promise<void> {
  await agent.waitForIdle(conversationId);
  await agent.deliverOutbox(conversationId, (message) => {
    printAsyncReply(message);
    onReply(message);
  });
}

function watchOutbox(agent: AutoSeguroAgent, conversationId: string, onReply: (reply: AgentReply) => void): void {
  void emitReady(agent, conversationId, onReply).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Erro assíncrono: ${redactSensitiveText(message)}`);
  });
}

async function prepareConversation(agent: AutoSeguroAgent, conversationId: string): Promise<void> {
  await agent.deliverOutbox(conversationId, printAsyncReply);
  if (await agent.resume(conversationId)) {
    watchOutbox(agent, conversationId, () => undefined);
  }
}

async function replay(path: string, conversationId: string, agent: AutoSeguroAgent): Promise<void> {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/u).filter((line) => line.trim() !== "");
  let previous: AgentReply | null = null;
  for (const [index, line] of lines.entries()) {
    const message = readReplayRecord(line, conversationId, index);
    if (!message) {
      continue;
    }
    console.log(`Lead: ${redactSensitiveText(message.text)}`);
    const action = actionFromChoice(previous, message.text);
    const reply = await agent.handle(action ? { ...message, action } : message);
    printReply("AutoSeguro: ", reply);
    previous = reply;
  }
  await emitReady(agent, conversationId, (reply) => { previous = reply; });
}

async function interactive(conversationId: string, agent: AutoSeguroAgent): Promise<void> {
  const terminal = createInterface({ input: stdin, output: stdout });
  let previous: AgentReply | null = null;
  console.log(`AutoSeguro: Olá. Envie "sair" para encerrar. Conversa ${conversationId}.`);
  try {
    while (true) {
      const text = await terminal.question("Você: ");
      if (text.trim().toLowerCase() === "sair") {
        await emitReady(agent, conversationId, (reply) => { previous = reply; });
        return;
      }
      const message: IncomingMessage = {
        conversation_id: conversationId,
        message_id: `${conversationId}-${randomUUID()}`,
        message_type: "text",
        text,
      };
      const action = actionFromChoice(previous, text);
      const reply = await agent.handle(action ? { ...message, action } : message);
      printReply("AutoSeguro: ", reply);
      previous = reply;
      watchOutbox(agent, conversationId, (outbox) => { previous = outbox; });
    }
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      conversation: { type: "string", short: "c" },
      replay: { type: "string", short: "r" },
      reset: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("npm run chat -- [--conversation ID] [--replay arquivo.jsonl] [--reset]");
    return;
  }
  const conversationId = values.conversation ?? `cli-${randomUUID()}`;
  const store = new FileConversationStore(process.env.STATE_DIR ?? ".runtime/conversations");
  if (values.reset) {
    await store.reset(conversationId);
  }
  const agent = new AutoSeguroAgent(
    store,
    new AuditLog(process.env.AUDIT_LOG_PATH ?? ".runtime/audit.jsonl"),
    OpenAICompatibleLlm.fromEnv(),
    new QuoteClient({
      baseUrl: process.env.QUOTE_API_URL ?? "http://127.0.0.1:8000",
      timeoutMs: Number(process.env.QUOTE_TIMEOUT_MS ?? "3000"),
      maxAttempts: Number(process.env.QUOTE_MAX_ATTEMPTS ?? "3"),
    }),
  );
  await prepareConversation(agent, conversationId);
  if (values.replay) {
    await replay(values.replay, conversationId, agent);
    return;
  }
  await interactive(conversationId, agent);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Erro: ${redactSensitiveText(message)}`);
  process.exitCode = 1;
});
