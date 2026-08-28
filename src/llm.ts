import { redactSensitiveText } from "./privacy.ts";
import type {
  CandidateFields,
  LanguageModel,
  LanguageUnderstanding,
  ReplyInput,
  UnderstandingInput,
} from "./types.ts";

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(content: string): Record<string, unknown> {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("O LLM não retornou JSON");
  }
  const parsed: unknown = JSON.parse(content.slice(start, end + 1));
  if (!isRecord(parsed)) {
    throw new Error("O LLM retornou JSON inválido");
  }
  return parsed;
}

function parseUnderstanding(content: string): LanguageUnderstanding {
  const parsed = parseObject(content);
  const fields = isRecord(parsed.fields) ? parsed.fields : {};
  const intent = parsed.intent;
  if (!new Set(["continue", "human", "unsupported"]).has(String(intent))) {
    throw new Error("O LLM retornou uma intenção inválida");
  }
  if (typeof parsed.ambiguous !== "boolean") {
    throw new Error("O LLM não informou ambiguidade");
  }
  const candidates: CandidateFields = {
    plano: fields.plano,
    idade: fields.idade,
    veiculo_ano: fields.veiculo_ano,
    cep: fields.cep,
    data_inicio: fields.data_inicio,
  };
  return {
    fields: candidates,
    intent: intent as LanguageUnderstanding["intent"],
    ambiguous: parsed.ambiguous,
  };
}

export class OpenAICompatibleLlm implements LanguageModel {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(config: LlmConfig, fetcher: typeof fetch = fetch) {
    this.baseUrl = config.baseUrl.replace(/\/$/u, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.fetcher = fetcher;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleLlm {
    const baseUrl = env.LLM_BASE_URL?.trim();
    const apiKey = env.LLM_API_KEY?.trim();
    const model = env.LLM_MODEL?.trim();
    if (!baseUrl || !apiKey || !model) {
      throw new Error("Configure LLM_BASE_URL, LLM_API_KEY e LLM_MODEL");
    }
    return new OpenAICompatibleLlm({ baseUrl, apiKey, model });
  }

  async understand(input: UnderstandingInput): Promise<LanguageUnderstanding> {
    const system = [
      "Extraia somente dados explicitamente informados pelo lead de seguro auto.",
      "Retorne apenas JSON com fields, intent e ambiguous.",
      "fields aceita plano, idade, veiculo_ano, cep e data_inicio.",
      "Normalize plano para essencial, completo ou premium e data para YYYY-MM-DD.",
      "Use null quando ausente. Nunca infira. intent é continue, human ou unsupported.",
      "ambiguous só é true quando o texto traz um dado essencial conflitante ou incerto.",
    ].join(" ");
    const user = JSON.stringify({
      mensagem: redactSensitiveText(input.text),
      campos_faltantes: input.missing_fields,
      data_atual: input.current_date,
    });
    return parseUnderstanding(await this.complete(system, user));
  }

  async phrase(input: ReplyInput): Promise<string> {
    const system = [
      "Reescreva o rascunho em português do Brasil, com tom humano e curto de WhatsApp.",
      "Preserve os fatos e os campos pedidos. Não acrescente preço, promessa, regra ou decisão.",
      "Retorne somente a mensagem.",
    ].join(" ");
    try {
      const answer = redactSensitiveText(
        await this.complete(system, JSON.stringify(input)),
      ).trim();
      return answer && !/R\$|\b\d+[,.]\d{2}\b/u.test(answer) ? answer : input.draft;
    } catch {
      return input.draft;
    }
  }

  private async complete(system: string, user: string): Promise<string> {
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`LLM indisponível: HTTP ${response.status}`);
    }
    const body = (await response.json()) as ChatResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("LLM retornou resposta vazia");
    }
    return content;
  }
}
