import { createServer } from "node:http";
import { AutoSeguroAgent } from "./agent.ts";
import { OpenAICompatibleLlm } from "./llm.ts";
import {
  createMetaHttpHandler,
  MetaGraphClient,
  MetaInbox,
  metaRuntimeConfig,
  MetaTransport,
} from "./meta.ts";
import { AuditLog, FileConversationStore } from "./persistence.ts";
import { QuoteClient } from "./quote-client.ts";

function revision(): string {
  return process.env.REVISION ?? "unknown";
}

function transportOptions(): { typingDelayMs: number; log: (event: Record<string, unknown>) => void } {
  return {
    typingDelayMs: Number(process.env.META_TYPING_DELAY_MS ?? "250"),
    log: (event) => console.log(JSON.stringify({
      service: "autoseguro-meta",
      revision: revision(),
      ...event,
    })),
  };
}

async function main(): Promise<void> {
  const config = metaRuntimeConfig();
  const stateDirectory = process.env.STATE_DIR ?? ".runtime/conversations";
  const store = new FileConversationStore(stateDirectory);
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
  const transport = new MetaTransport(
    agent,
    store,
    new MetaInbox(process.env.META_INTAKE_DIR ?? ".runtime/meta-intake", config.appSecret),
    new MetaGraphClient(config),
    config,
    transportOptions(),
  );
  const server = createServer(createMetaHttpHandler(config, transport, revision()));
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT inválida");
  }
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  await transport.recover();
  console.log(JSON.stringify({
    service: "autoseguro-meta",
    revision: revision(),
    event: "server_started",
    port,
  }));

  const shutdown = (): void => {
    transport.stop();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(() => {
  console.error("Falha ao iniciar o servidor AutoSeguro Meta");
  process.exitCode = 1;
});
