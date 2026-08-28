# AutoSeguro

Agente de vendas de seguro auto por uma CLI que simula uma conversa de WhatsApp. O fluxo coleta os cinco campos obrigatórios, consulta a API oficial de cotação e encerra com uma cotação confirmada ou com um handoff rastreável.

A API de cotação é a única autoridade de preço e aceitação. O agente não calcula prêmio, franquia, carência ou pró-rata.

## Política de falha

Esta é a parte central da solução.

| Situação em `POST /quote` | Ação |
|---|---|
| Sucesso `2xx` com resposta válida | Exibe apenas os valores recebidos da API |
| Timeout | Repete a chamada, até três tentativas no total |
| `500`, `502` ou `503` | Repete a chamada, até três tentativas no total |
| `400` | Não repete; cria handoff por payload rejeitado |
| `422` | Não repete; informa a recusa sem preço e cria handoff comercial |
| Outro `4xx`, erro de rede ou resposta `2xx` malformada | Não repete; cria handoff |
| Falhas esgotadas | Informa que não houve cotação, não estima preço e cria handoff |

O timeout padrão é de 3 segundos, abaixo dos 8 segundos da lentidão simulada. O intervalo entre tentativas usa backoff exponencial de 200 ms e jitter de até 99 ms. `QUOTE_TIMEOUT_MS` precisa ser menor que 8.000 e `QUOTE_MAX_ATTEMPTS` aceita de uma a três tentativas.

Cada tentativa usa o mesmo `quote_request_id`, enviado também em `X-Request-ID`. A API fornecida não declara idempotência; o identificador garante correlação, não uma garantia transacional no servidor. A cotação é uma leitura sem efeito comercial. O agente nunca reutiliza uma cotação anterior como preço atual.

## Como executar

### Requisitos

- Node.js 22.18 ou mais recente
- npm
- Docker, ou Python 3.10+ com `uv`
- um endpoint compatível com `POST /chat/completions` da OpenAI

### 1. Suba a API oficial

O serviço não foi copiado para este repositório. Isso evita manter uma segunda versão da regra de preços. Ele está no repositório oficial do desafio:

<https://github.com/namastexlabs/namastex-fde-challenge>

Com Docker:

```bash
git clone https://github.com/namastexlabs/namastex-fde-challenge.git
cd namastex-fde-challenge
docker compose up --build
```

Sem Docker:

```bash
cd namastex-fde-challenge/quote-service
QUOTE_FAILURE_RATE=0.20 \
QUOTE_SLOW_RATE=0.10 \
QUOTE_SLOW_SECONDS=8 \
QUOTE_SEED=42 \
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Confirme o serviço:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/planos
```

A instabilidade deve ficar ligada para a execução real. `QUOTE_SEED=42` torna a sequência reproduzível.

### 2. Configure o agente

```bash
npm install
cp .env.example .env
```

Preencha sem commitar o arquivo `.env`:

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sua-chave
LLM_MODEL=seu-modelo
QUOTE_API_URL=http://127.0.0.1:8000
```

`LLM_BASE_URL`, `LLM_API_KEY` e `LLM_MODEL` permitem usar qualquer provedor com o contrato OpenAI Chat Completions.

### 3. Converse pela CLI

```bash
npm run chat -- --conversation avaliacao
```

Digite `sair` para encerrar. O mesmo `conversation_id` retoma os dados salvos.

Para repetir o roteiro sem dados pessoais:

```bash
npm run chat -- \
  --conversation demo-real \
  --replay examples/conversation-input.jsonl \
  --reset
```

O replay aceita JSONL com `message_id`, `message_type` e `text`. Também aceita as colunas `conversation_id`, `message_index`, `sender_role` e `message_body` do dataset oficial; linhas do vendedor são ignoradas.

Estado e auditoria ficam, por padrão, em:

```text
.runtime/conversations/<conversation_id>.json
.runtime/audit.jsonl
```

Os dois caminhos podem ser alterados por `STATE_DIR` e `AUDIT_LOG_PATH`.

## Testes e validação

Os testes usam uma API HTTP local controlada. Não exigem chave de LLM nem o serviço oficial.

```bash
npm test
npm run typecheck
npm run lint
npm run check
```

`npm run check` executa TypeScript estrito, oxlint com limite de complexidade e os testes. A suíte cobre:

- cotação feliz;
- CEP de alto risco encaminhado sem alteração;
- idade acima de 75 anos;
- veículo com mais de 20 anos;
- início no meio do mês e pró-rata retornado pela API;
- timeout seguido de sucesso;
- `500`, `502` e `503` até handoff;
- `400` sem retry;
- mensagem duplicada concorrente e persistida;
- retomada em um novo processo lógico;
- mídia sem transcrição;
- validação antes da API;
- ausência de CPF, telefone, e-mail e CEP completo na auditoria.

## Arquitetura

A aplicação é uma única fatia vertical, sem servidor web e sem monorepo.

```text
src/cli.ts            canal interativo e replay JSONL
src/agent.ts          máquina de estados, coleta, decisão e handoff
src/validation.ts     validação dos candidatos antes da API
src/quote-client.ts   timeout, retry, classificação e contrato da cotação
src/llm.ts            cliente OpenAI-compatible para extração e redação
src/persistence.ts    estado atômico em JSON e auditoria JSONL
src/privacy.ts        remoção de CPF, telefone e e-mail; máscara de CEP
```

### Limites de responsabilidade

**LLM:** extrai candidatos do texto e reescreve perguntas curtas. O texto enviado ao provedor tem CPF, telefone e e-mail removidos. A saída estruturada passa por validação em runtime. Falha do modelo cria handoff.

**Núcleo determinístico:** controla os campos obrigatórios, origem de cada campo, estado, validação, deduplicação, retry, resultado e handoff. Mensagens com ambiguidade pedem uma confirmação; a segunda ambiguidade cria handoff.

**API oficial:** decide aceitação e devolve todos os valores monetários. Idade acima de 75 anos e veículo com mais de 20 anos chegam à API; uma resposta `422` vira recusa e handoff comercial sem preço.

**Pessoa do time:** recebe indisponibilidade persistente, recusa comercial, mídia sem transcrição, pedido explícito, pedido fora do escopo ou ambiguidade repetida.

### Estado e idempotência

Cada conversa persiste:

- etapa `collecting`, `quoting`, `resolved` ou `handoff`;
- valor e `message_id` de origem de cada campo;
- IDs de mensagens já processadas e suas respostas;
- `quote_request_id`;
- cotação confirmada ou motivo de handoff.

A escrita usa arquivo temporário e `rename`. Uma repetição do mesmo `message_id` devolve a resposta persistida e não chama a API de novo. Chamadas concorrentes com o mesmo ID compartilham a mesma promessa no processo atual.

O limite deliberado é uma única instância da CLI. Várias instâncias exigiriam banco com chave única para `message_id` e transação entre estado, outbox e chamada. A API também precisaria honrar uma chave de idempotência para fechar a janela de falha após timeout.

## Auditoria e privacidade

Há um evento JSON por mensagem processada e um por tentativa HTTP. Todo evento possui:

- `conversation_id`, `message_id` e `timestamp`;
- `stage`;
- `collected_fields`, com valor e origem;
- `quote_request_id`;
- `attempt`, `latency_ms`, `http_status` e `failure_kind`;
- `outcome`: `resolved`, `awaiting_data`, `refused` ou `handoff`;
- `handoff_reason`.

O corpo bruto da mensagem não entra no estado nem na auditoria. CPF, telefone e e-mail passam por remoção defensiva antes de qualquer linha ser gravada. O CEP é necessário para cotar, mas aparece mascarado na auditoria, como `01***-***`. O estado local contém apenas os cinco campos necessários, usa permissão `0600` e fica fora do Git.

O dataset sintético oficial foi usado apenas para conferir formatos de PII e o caso de mídia sem transcrição. Não há cópia do dataset nem dados de conversa neste repositório.

## Decisões e trade-offs

- Node fornece `fetch`, timeout, UUID, JSONL, testes e readline. Não há dependência de runtime.
- O sistema valida formato e contrato. Ele não replica os multiplicadores nem calcula preços.
- Os três IDs de plano conhecidos pelo contrato são validados antes da chamada. Mudança no catálogo exigirá trocar essa lista ou consultar `GET /planos` em runtime.
- Arquivos locais tornam retomada e inspeção simples para o take-home. Banco, fila e painel operacional só fariam sentido com concorrência real.
- Respostas de cotação, recusa e handoff usam texto determinístico. Isso impede que o LLM altere preço ou decisão. O LLM só dá linguagem natural às perguntas de coleta.
- Erro de rede genérico não recebe retry porque a política permite retry apenas para timeout, `500`, `502` e `503`.

A conversa real e seu recorte de auditoria ficam em `examples/`. A pasta `ai-logs/` contém apenas a nota de entrega até o responsável adicionar os históricos reais das ferramentas de IA.
