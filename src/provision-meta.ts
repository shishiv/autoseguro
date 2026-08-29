import { parseArgs } from "node:util";
import {
  META_GRAPH_VERSION,
  metaRuntimeConfig,
  TEST_PHONE_NUMBER_ID,
  TEST_WABA_ID,
} from "./meta.ts";
import type { MetaRuntimeConfig } from "./meta.ts";

const EXPECTED_APP_CALLBACK = "https://api.triangulotec.com.br/webhook";

interface AppSubscription {
  object?: unknown;
  callback_url?: unknown;
}

interface WabaSubscription {
  whatsapp_business_api_data?: { id?: unknown };
  override_callback_uri?: unknown;
}

interface GraphList<T> {
  data?: T[];
  error?: { code?: unknown };
}

class ProvisioningError extends Error {}

function masked(value: string): string {
  return value.length <= 4 ? "****" : `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

async function graph<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({})) as T & { error?: { code?: unknown } };
  if (!response.ok) {
    const code = typeof body.error?.code === "number" ? body.error.code : "unknown";
    throw new ProvisioningError(`Graph API falhou com HTTP ${response.status}, código ${code}`);
  }
  return body;
}

async function wabaSubscription(wabaId: string, appId: string, token: string): Promise<WabaSubscription | null> {
  const body = await graph<GraphList<WabaSubscription>>(`${wabaId}/subscribed_apps`, token);
  if (!Array.isArray(body.data)) {
    throw new ProvisioningError("Resposta inválida ao consultar a assinatura do WABA");
  }
  return body.data.find((item) => item.whatsapp_business_api_data?.id === appId) ?? null;
}

async function appCallback(appId: string, token: string): Promise<string> {
  const body = await graph<GraphList<AppSubscription>>(
    `${appId}/subscriptions?fields=object,callback_url`,
    token,
  );
  const subscription = body.data?.find((item) => item.object === "whatsapp_business_account");
  if (typeof subscription?.callback_url !== "string") {
    throw new ProvisioningError("Não foi possível provar o callback padrão do app");
  }
  return subscription.callback_url.replace(/\/$/u, "");
}

async function postSubscription(
  wabaId: string,
  token: string,
  body?: { override_callback_uri: string; verify_token: string },
): Promise<void> {
  await graph(`${wabaId}/subscribed_apps`, token, {
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function deleteSubscription(wabaId: string, token: string): Promise<void> {
  await graph(`${wabaId}/subscribed_apps`, token, { method: "DELETE" });
}

function assertSafety(appCallbackUrl: string, callbackUrl: string): void {
  if (appCallbackUrl !== EXPECTED_APP_CALLBACK) {
    throw new ProvisioningError("O callback padrão do app não corresponde ao endpoint canônico esperado");
  }
  if (callbackUrl === appCallbackUrl || !callbackUrl.startsWith("https://")) {
    throw new ProvisioningError("O override deve apontar para um endpoint HTTPS isolado");
  }
}

async function apply(
  wabaId: string,
  appId: string,
  token: string,
  callbackUrl: string,
  verifyToken: string,
): Promise<void> {
  let subscription = await wabaSubscription(wabaId, appId, token);
  if (!subscription) {
    await postSubscription(wabaId, token);
    subscription = await wabaSubscription(wabaId, appId, token);
    if (!subscription) {
      throw new ProvisioningError("A assinatura do app no WABA de teste não foi confirmada");
    }
  }
  await postSubscription(wabaId, token, {
    override_callback_uri: callbackUrl,
    verify_token: verifyToken,
  });
  subscription = await wabaSubscription(wabaId, appId, token);
  if (subscription?.override_callback_uri !== callbackUrl) {
    throw new ProvisioningError("O override do WABA de teste não foi confirmado");
  }
}

async function rollback(wabaId: string, appId: string, token: string): Promise<void> {
  const subscription = await wabaSubscription(wabaId, appId, token);
  if (!subscription) {
    return;
  }
  if (typeof subscription.override_callback_uri === "string") {
    await postSubscription(wabaId, token);
    const cleared = await wabaSubscription(wabaId, appId, token);
    if (!cleared || typeof cleared.override_callback_uri === "string") {
      throw new ProvisioningError("A remoção do override não foi confirmada");
    }
  }
  await deleteSubscription(wabaId, token);
  if (await wabaSubscription(wabaId, appId, token)) {
    throw new ProvisioningError("A remoção da assinatura não foi confirmada");
  }
}

interface ProvisionOptions {
  apply: boolean;
  rollback: boolean;
  smoke: boolean;
}

function requiredAppId(): string {
  const appId = process.env.META_APP_ID?.trim();
  if (!appId) {
    throw new ProvisioningError("Configure META_APP_ID");
  }
  return appId;
}

function printState(
  options: ProvisionOptions,
  config: MetaRuntimeConfig,
  appId: string,
  subscription: WabaSubscription | null,
): void {
  console.log(JSON.stringify({
    mode: options.apply ? "apply" : "dry-run",
    operation: options.rollback ? "rollback" : options.smoke ? "smoke" : "provision",
    app_id: masked(appId),
    waba_id: masked(config.wabaId),
    phone_number_id: masked(config.phoneNumberId),
    subscribed: subscription !== null,
    override_present: typeof subscription?.override_callback_uri === "string",
    app_callback_unchanged: true,
  }));
}

async function verifyEndpoint(config: MetaRuntimeConfig): Promise<void> {
  const health = await fetch(`${config.publicBaseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!health.ok || (await health.json() as { status?: unknown }).status !== "ok") {
    throw new ProvisioningError("O health check isolado falhou");
  }
  const url = new URL(`${config.publicBaseUrl}/webhook`);
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", config.verifyToken);
  url.searchParams.set("hub.challenge", "autoseguro-smoke");
  const verification = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!verification.ok || await verification.text() !== "autoseguro-smoke") {
    throw new ProvisioningError("A verificação do webhook isolado falhou");
  }
}

async function verifyPostcondition(
  options: ProvisionOptions,
  config: MetaRuntimeConfig,
  appId: string,
  appAccessToken: string,
  callbackUrl: string,
  beforeCallback: string,
): Promise<WabaSubscription | null> {
  const afterCallback = await appCallback(appId, appAccessToken);
  if (afterCallback !== beforeCallback) {
    throw new ProvisioningError("O callback padrão do app mudou; interrompa e investigue");
  }
  const after = await wabaSubscription(config.wabaId, appId, config.accessToken);
  const valid = options.rollback ? after === null : after?.override_callback_uri === callbackUrl;
  if (!valid) {
    throw new ProvisioningError("A pós-condição Meta não foi confirmada");
  }
  return after;
}

async function run(options: ProvisionOptions): Promise<void> {
  const config = metaRuntimeConfig();
  const appId = requiredAppId();
  const appAccessToken = `${appId}|${config.appSecret}`;
  if (config.wabaId !== TEST_WABA_ID || config.phoneNumberId !== TEST_PHONE_NUMBER_ID) {
    throw new ProvisioningError("O alvo não é a conta Meta de teste autorizada");
  }
  const callbackUrl = `${config.publicBaseUrl}/webhook`;
  if (callbackUrl.length > 200) {
    throw new ProvisioningError("O callback excede 200 caracteres");
  }
  const beforeCallback = await appCallback(appId, appAccessToken);
  assertSafety(beforeCallback, callbackUrl);
  const before = await wabaSubscription(config.wabaId, appId, config.accessToken);
  printState(options, config, appId, before);
  if (options.smoke) {
    await verifyEndpoint(config);
    await verifyPostcondition(options, config, appId, appAccessToken, callbackUrl, beforeCallback);
    console.log(JSON.stringify({ result: "smoke_passed" }));
    return;
  }
  if (!options.apply) {
    return;
  }
  if (options.rollback) {
    await rollback(config.wabaId, appId, config.accessToken);
  } else {
    await apply(config.wabaId, appId, config.accessToken, callbackUrl, config.verifyToken);
  }
  const after = await verifyPostcondition(options, config, appId, appAccessToken, callbackUrl, beforeCallback);
  printState(options, config, appId, after);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      rollback: { type: "boolean", default: false },
      smoke: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("npm run meta:provision -- [--apply] [--rollback] | npm run meta:smoke");
    return;
  }
  if (values.smoke && (values.apply || values.rollback)) {
    throw new ProvisioningError("O smoke verifier é somente leitura");
  }
  await run(values);
}

main().catch((error: unknown) => {
  const message = error instanceof ProvisioningError ? error.message : "Falha inesperada no provisionamento";
  console.error(message);
  process.exitCode = 1;
});
