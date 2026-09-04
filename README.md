# AutoSeguro

Agente de vendas de seguro auto com canais CLI e WhatsApp Cloud API. Ele coleta os cinco campos obrigatórios, inicia a cotação em segundo plano e mantém a conversa disponível enquanto a API instável trabalha.

A API oficial é a única autoridade de preço e aceitação. O agente não calcula prêmio, franquia, carência ou pró-rata.

## Resultado medido

A avaliação registrada usou 100 conversas válidas, concorrência 10 e a API oficial com `QUOTE_FAILURE_RATE=0.20`, `QUOTE_SLOW_RATE=0.10`, `QUOTE_SLOW_SECONDS=8` e `QUOTE_SEED=42`.

| Métrica | Resultado |
|---|---:|
| Conversas | 100 |
| Chamadas `POST /quote` | 148 |
| Respostas `2xx` | 95 |
| Respostas `500` / `502` / `503` | 14 / 11 / 6 |
| Timeouts | 22 |
| Sucesso na 1ª / 2ª / 3ª tentativa | 63 / 26 / 6 |
| Handoffs após esgotamento | 5 |
| Acknowledgement p50 / p95 / máximo | 1 / 8 / 12 ms |
| Respostas de status enquanto pending | 100 de 100 |
| Operações duplicadas | 0 |
| Preços antes da confirmação da API | 0 |
| Handoffs sem contexto | 0 |
| Transições inválidas | 0 |
| Extrações com Ollama Cloud | 20 de 20 |

O relatório completo, o resultado máquina-legível das 100 conversas e três transcrições representativas estão em [`examples/evaluation/`](examples/evaluation/). A conversa real com LLM e uma chamada lenta da API está em [`examples/conversation-real.md`](examples/conversation-real.md).

## Fluxo assíncrono

```mermaid
sequenceDiagram
    participant Lead
    participant Agent as AutoSeguro
    participant Store as Estado e outbox
    participant API as Quote API
    Lead->>Agent: dados completos
    Agent->>Store: persiste job pending e request_id
    Agent-->>Lead: confirmação imediata
    Agent->>API: POST /quote em segundo plano
    Lead->>Agent: já conseguiu?
    Agent-->>Lead: status pending, sem nova cotação
    API-->>Agent: timeout, 5xx, 422 ou cotação
    Agent->>Store: persiste tentativa e resultado terminal
    Store-->>Lead: entrega cotação ou handoff pela outbox
```

Uma mensagem com todos os dados retorna antes de `POST /quote`. O resultado chega depois como uma nova mensagem. A outbox fica no mesmo arquivo durável da conversa e só recebe `delivered_at` depois que o canal aceita a entrega.

Enquanto a cotação está pendente:

- pedido de status recebe o protocolo atual;
- pergunta sobre plano, cobertura ou espera recebe uma resposta honesta, sem antecipar preço;
- mensagem duplicada devolve a resposta original e não abre outro job;
- correção de dado cancela o cliente antigo, marca o job como `failed` por supersessão e cria outro `quote_request_id`;
- pedido de pessoa cancela o cliente, persiste o handoff e prevalece sobre qualquer resposta tardia.

## Experiência do Cliente (CX) e Handoff

Inspirado em padrões de excelência em CX conversacional (como a filosofia de atendimento resolutivo e empático da Khal.ai):

- **Esclarecimento sem perda de fluxo:** Se o cliente tem dúvidas sobre franquias, coberturas ou carências durante a coleta (`intent: information`), o agente consulta e valida `GET /planos` do serviço oficial. Em caso de indisponibilidade ou schema incompleto, o agente informa que os detalhes oficiais estão indisponíveis no momento e continua apenas com os nomes e opções limpas de planos ("Essencial", "Completo", "Premium"), sem expor valores locais nem carência presumida nos botões ou fallbacks.
- **Transparência humanizada em recusas (422):** Quando a seguradora recusa o risco (ex.: idade superior a 75 anos ou veículo com mais de 20 anos), o motivo oficial é informado com clareza e respeito antes de encaminhar para o consultor humano, evitando frustração e jargão técnico.
- **Condução à contratação com correlação segura:** Após a cotação pronta, o agente disponibiliza a opção "Contratar plano" na lista interativa com ID correlacionado à cotação ativa (`quote_hire:${reference}`) e reconhece intenções afirmativas de fechamento. Ações com referências divergentes de cotações antigas e a ação legada pura `quote_hire` são rejeitadas informativamente indicando a opção desatualizada e preservando a cotação ativa em `stage: resolved` sem handoff. O pedido válido (via botão correlacionado ou texto afirmativo) fica persistido como handoff de emissão (`issuance_requested`) com a referência e o contexto da cotação para continuidade do atendimento.
- **Linguagem acolhedora:** O diálogo confirma os dados informados de forma natural, eliminando repetições robóticas e blindando o cliente contra termos internos (`api`, `http`, `retry`, `processamento`).

## Política de falha

| Situação em `POST /quote` | Ação |
|---|---|
| Sucesso `2xx` com contrato válido | Grava `delivered` e enfileira a resposta com os valores da API |
| Timeout | Repete, até três tentativas no total |
| `500`, `502` ou `503` | Repete, até três tentativas no total |
| `400` | Não repete; grava `failed` e cria handoff por payload rejeitado |
| `422` | Não repete; informa a recusa sem preço e cria handoff comercial |
| Outro `4xx`, erro de rede ou `2xx` malformado | Não repete; grava `failed` e cria handoff |
| Falhas esgotadas | Informa que não houve cotação, não estima preço e cria handoff |

O timeout padrão é 3 segundos, abaixo dos 8 segundos da lentidão simulada. O intervalo usa backoff exponencial de 200 ms e jitter de até 99 ms. `QUOTE_TIMEOUT_MS` deve ser menor que 8.000 e `QUOTE_MAX_ATTEMPTS` aceita de uma a três tentativas.

A API faz um único sorteio por chamada. `roll < 0.20` produz `500`, `502` ou `503`; `0.20 <= roll < 0.30` dorme 8 segundos. Os ramos são mutuamente exclusivos e as taxas valem por chamada, não por conversa. Para 100 conversas e até três tentativas, a expectativa é 139 chamadas, 27,8 respostas 5xx, 13,9 timeouts, 97,3 resoluções e 2,7 handoffs esgotados. Os números observados acima vieram da execução com seed 42; não foram ajustados à expectativa.

Cada retry preserva o `quote_request_id`, também enviado como `X-Request-ID`. O serviço oficial não declara idempotência. Após reinício, um job `pending` ou `retrying` retoma com a mesma correlação e com o orçamento de tentativas persistido. Se o processo morrer depois de enviar a requisição e antes de gravar sua tentativa, a API pode receber uma chamada adicional. Como cotar é uma leitura, esse risco é aceito aqui; não há promessa de execução exatamente uma vez.

## Como executar

### Requisitos

- Node.js 22.18 ou mais recente
- npm
- Docker, ou Python 3.10+ com `uv`
- chave do Ollama Cloud, ou outro endpoint OpenAI-compatible
- para o canal real, um domínio HTTPS isolado e credenciais do app Meta

### 1. Suba a API oficial

O serviço não foi copiado para este repositório. Assim não existe uma segunda implementação das regras de preço. Use o repositório oficial:

<https://github.com/namastexlabs/namastex-fde-challenge>

Com Docker:

```bash
git clone https://github.com/namastexlabs/namastex-fde-challenge.git
cd namastex-fde-challenge
docker compose up --build
```

Sem Docker, com a instabilidade e a seed da avaliação:

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

### 2. Configure o agente

```bash
npm install
cp .env.example .env
```

Preencha `.env` sem commitá-lo:

```dotenv
LLM_BASE_URL=https://ollama.com/v1
LLM_API_KEY=sua-chave-do-Ollama-Cloud
LLM_MODEL=deepseek-v4-flash:0731
LLM_TIMEOUT_MS=30000
QUOTE_API_URL=http://127.0.0.1:8000
META_APP_ID=
META_WABA_ID=917767274033519
META_PHONE_NUMBER_ID=946560951879475
META_ACCESS_TOKEN=
META_APP_SECRET=
META_VERIFY_TOKEN=
META_ALLOWED_RECIPIENT=
PUBLIC_BASE_URL=https://autoseguro.example.com
```

O exemplo usa o endpoint OpenAI-compatible do [Ollama Cloud](https://docs.ollama.com/api/openai-compatibility). As variáveis `LLM_*` aceitam outro provedor compatível.

### 3. Converse pela CLI

```bash
npm run chat -- --conversation avaliacao
```

Digite `sair` para encerrar. O mesmo `conversation_id` retoma estado, job pendente e outbox.

Para repetir o roteiro sem dados pessoais:

```bash
npm run chat -- \
  --conversation demo-real \
  --replay examples/conversation-input.jsonl \
  --reset
```

O replay aceita JSONL com `message_id`, `message_type` e `text`. Também aceita `conversation_id`, `message_index`, `sender_role` e `message_body` do dataset oficial; linhas do vendedor são ignoradas.

Estado e auditoria ficam em:

```text
.runtime/conversations/<conversation_id>.json
.runtime/audit.jsonl
```

Use `STATE_DIR` e `AUDIT_LOG_PATH` para trocar os caminhos.

## Canal WhatsApp isolado

O servidor usa somente `node:http` e expõe `GET /health`, `GET /webhook` para o challenge do Meta e `POST /webhook` para eventos. Inicie-o com:

```bash
npm run serve
```

O `POST` calcula `X-Hub-Signature-256` sobre os bytes recebidos e compara o HMAC-SHA256 antes de interpretar JSON. Um evento válido entra em disco antes do HTTP 200. LLM, cotação, retries e envios ao Graph API rodam depois da resposta. O adaptador converte texto para `IncomingMessage` e entrega tudo ao mesmo `AutoSeguroAgent` usado pela CLI. Qualquer mídia sem texto segue para o handoff explícito já existente.

O processo aceita apenas o WABA e o Phone Number ID de teste fixados nesta integração. `META_ALLOWED_RECIPIENT` aceita um único telefone, normalizado para dígitos. Eventos de outro WABA, número ou remetente falham fechados. `PUBLIC_BASE_URL` exige HTTPS e não pode usar `api.triangulotec.com.br`. O adaptador não contém chamada capaz de alterar o callback padrão do app.

O intake persiste o `wamid` original e cifra telefone e texto com AES-256-GCM derivado de `META_APP_SECRET`. Após a entrega, apaga o payload cifrado e conserva só IDs, horários e falhas seguras. O token e corpos de mensagens não entram em logs. O estado, o intake e a auditoria usam arquivos `0600` em `.runtime/` ou no volume privado. A outbox continua pelo menos uma vez: o ID retornado pelo Meta é salvo antes de marcar a mensagem entregue, então um reinício recupera o envio sem perder a cotação ou o handoff.

### Deploy separado

[`compose.meta.yaml`](compose.meta.yaml) sobe dois serviços isolados: este servidor e o quote service oficial, sem alterar seu código. O build do serviço oficial está preso ao commit documentado no Compose. A instabilidade continua em `20%` de falhas, `10%` de chamadas lentas e 8 segundos de atraso. `QUOTE_SEED` torna um smoke reproduzível; `AUTOSEGURO_VOLUME_NAME` permite um volume descartável por cenário.

```bash
docker compose --env-file .env -f compose.meta.yaml up -d --build
```

Roteie somente a porta interna 3000 do serviço `autoseguro` atrás de TLS no domínio de `PUBLIC_BASE_URL`, por exemplo `autoseguro.triangulotec.com.br`. Não publique uma porta do host. Use projeto, serviço, volume e rota separados do processador TEC. O quote service fica apenas na rede interna do Compose.

### Assinatura e override do WABA

O contrato foi conferido nas páginas primárias do Meta, atualizadas em junho de 2026: [Managing webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks) e [Webhook overrides](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/). A ordem exigida é assinar o app com `POST /<WABA_ID>/subscribed_apps`, confirmar a assinatura e só então repetir o `POST` com `override_callback_uri` e `verify_token`. O override de WABA cobre `messages`; eventos de template e conta continuam no callback padrão do app.

O comando é dry-run por padrão. Ele consulta o WABA e o callback do app, mascara IDs e não imprime token ou verify token:

```bash
npm run meta:provision
```

Depois da aprovação explícita do firstmate e do health check público:

```bash
npm run meta:provision -- --apply
npm run meta:smoke
```

`--apply` recusa qualquer ID fora da conta e do número de teste, preserva o callback padrão `https://api.triangulotec.com.br/webhook` e relê ambas as configurações como pós-condição. O smoke verifier é somente leitura: confere health, challenge, assinatura, override e callback padrão.

Rollback exato, também dry-run por padrão:

```bash
npm run meta:provision -- --rollback
npm run meta:provision -- --rollback --apply
```

O rollback primeiro faz `POST /<WABA_ID>/subscribed_apps` sem corpo para remover o override, confirma sua ausência, depois faz `DELETE /<WABA_ID>/subscribed_apps` e confirma que apenas a assinatura do app no WABA de teste sumiu. Ele não consulta nem altera o WABA canônico.

### Prova WhatsApp

O número de teste pode permanecer com `code_verification_status=NOT_VERIFIED` e qualidade `UNKNOWN`, mas seu status de API precisa ser `CONNECTED`. O Meta só aceita o destinatário de teste previamente autorizado. Faça o round trip manualmente pelo WhatsApp desse destinatário; `wacli` é opcional e nunca é necessário para instalar, provisionar ou concluir o teste.

Registre somente horários, IDs truncados ou hashados, contagem de tentativas e resultado. [`docs/meta-live-evidence.example.json`](docs/meta-live-evidence.example.json) define o formato sem telefone, texto ou token. [`docs/meta-provisioning-evidence.json`](docs/meta-provisioning-evidence.json) registra o deploy e as pós-condições atuais. A prova deve mostrar a confirmação imediata e, em execuções isoladas, uma cotação tardia e um handoff após três falhas. Um volume descartável por cenário evita misturar estados sem tocar tráfego de produção.

Esse round trip prova transporte, isolamento e retomada. Ele não substitui a avaliação estatística de 100 conversas em [`examples/evaluation/`](examples/evaluation/), que mede retries, duplicação, latência e ausência de preço inventado sob carga reproduzível.

## Replay híbrido da API

> Evidência: **API-emulated hybrid**. Não é WhatsApp real.

O replay em [`examples/api-replay/`](examples/api-replay/) dirige o webhook HTTP, o núcleo, a outbox, o DeepSeek V4 Flash do Ollama Cloud e o serviço oficial de cotações. Um peer Graph API em `127.0.0.1` captura presença, texto, listas e botões. Ele nunca chama Meta nem envia uma mensagem a um telefone.

Com o `.env` local já configurado e o checkout oficial do challenge disponível:

```bash
QUOTE_SERVICE_DIR=<path-to-challenge>/quote-service npm run api:replay
```

O comando inicia um processo descartável do serviço oficial para cada cenário, usa somente o endpoint Ollama configurado e redes loopback para Meta e cotação, remove o estado temporário e regrava cinco transcrições, resultados estruturados, resumo e proveniência de formatos. O manifesto preserva formas e hashes das fontes aceitas, mas substitui WABA, telefone, `wamid`, callback, timestamp, app, token, PIN e perfil.

Ele prova o caminho webhook/core/outbox e contratos semânticos. Não prova que Meta aceitaria os requests ou como um cliente WhatsApp renderizaria as mensagens.

## Avaliação reproduzível

Reinicie a API oficial com seed 42 antes do comando. A avaliação executa os cenários forçados, 100 conversas contra a API real e 20 exemplos de linguagem no Ollama Cloud:

```bash
npm run evaluate -- --conversations 100
```

Ela usa concorrência 10 para a API e 2 para o LLM. O resultado padrão fica em `.runtime/evaluation-result.json` e `.runtime/evaluation-result.md`. Para atualizar os artefatos versionados:

```bash
npm run evaluate -- \
  --conversations 100 \
  --concurrency 10 \
  --language-conversations 20 \
  --language-concurrency 2 \
  --output examples/evaluation/reliability-100.json
```

O passe primário usa extração determinística para isolar a instabilidade da API. Cada conversa manda os dados, repete a mensagem e pergunta “Já conseguiu?” antes de aguardar o resultado. O passe separado usa 20 formas de expressão em pt-BR, inspiradas no dataset sintético, e classifica falha de transporte do LLM separada de erro de extração.

## Testes e validação

```bash
npm test
npm run typecheck
npm run lint
npm run check
```

`npm test` também executa um fake Meta local de ponta a ponta. O teste mantém a cotação bloqueada, prova que o webhook responde antes dela e depois valida o envio assíncrono.

A suíte determinística cobre:

- cotação imediata em background e outbox durável;
- cotação feliz, CEP de alto risco e pró-rata;
- idade acima de 75 e veículo com mais de 20 anos;
- timeout seguido de sucesso;
- 5xx seguido de sucesso;
- 500 + timeout + sucesso;
- 500/502/503 até handoff;
- 400 e 422 sem retry;
- duplicata, status e informação durante `pending`;
- correção enquanto `pending` e descarte do resultado antigo;
- handoff humano antes de uma resposta tardia;
- retomada de coleta e retomada de job após reinício;
- mídia sem transcrição;
- validação antes da API;
- ausência de CPF, telefone, e-mail e CEP completo na auditoria;
- challenge e health do webhook Meta;
- HMAC ausente ou inválido antes do parse;
- payload malformado e `wamid` duplicado;
- allowlist e mídia não suportada;
- falha outbound persistida sem corpo ou token;
- pending imediato, cotação tardia e handoff tardio;
- replay da outbox após reinício;
- informação sobre planos sem seleção prematura durante a coleta;
- motivo transparente e acolhedor na recusa 422 da seguradora;
- intenção de fechamento e contratação com handoff comercial qualificado;
- tolerância a ano de veículo em linguagem natural no intake.

## Arquitetura

A aplicação segue como uma única fatia vertical. O canal Meta adapta HTTP e Graph API ao núcleo existente; não duplica regras de cotação, Redis ou fila externa.

```text
src/cli.ts             canal interativo, replay e entrega da outbox
src/server.ts          composição e processo HTTP do canal Meta
src/meta.ts            HMAC, payload Meta, intake cifrado e Graph API
src/provision-meta.ts  provisionamento guardado, rollback e smoke read-only
src/agent.ts           estado, jobs em background, deduplicação e handoff
src/validation.ts      validação dos candidatos antes da API
src/quote-client.ts    timeout, retry, cancelamento e contrato da cotação
src/llm.ts             cliente OpenAI-compatible para extração e redação
src/persistence.ts     estado atômico em JSON e auditoria JSONL
src/privacy.ts         remoção de CPF, telefone e e-mail; máscara de CEP
src/evaluate.ts        avaliação real com concorrência limitada
```

**LLM:** extrai candidatos e dá linguagem natural às perguntas de coleta. O núcleo remove CPF, telefone e e-mail antes da chamada. A saída passa por validação em runtime. O LLM classifica intenção; regras determinísticas decidem o efeito.

**Núcleo determinístico:** controla campos, origem, transições, deduplicação, cancelamento, retry, resultado, outbox e handoff.

**API oficial:** decide aceitação e devolve todos os valores monetários. Idade acima de 75 anos e veículo com mais de 20 anos chegam à API; o `422` vira recusa e handoff comercial sem preço.

**Pessoa do time:** recebe indisponibilidade persistente, recusa comercial, mídia sem transcrição, pedido explícito, pedido fora do escopo ou ambiguidade repetida.

## Estado, outbox e auditoria

Cada conversa persiste:

- etapa `collecting`, `quoting`, `resolved` ou `handoff`;
- campos e `message_id` de origem;
- mensagens já processadas e respostas idempotentes;
- jobs com `pending`, `retrying`, `delivered` ou `failed`;
- histórico de transições e tentativas;
- `quote_request_id`, resultado ou motivo do handoff;
- respostas terminais na outbox e `delivered_at`.

A escrita usa arquivo temporário e `rename`. A outbox oferece entrega pelo menos uma vez. No canal Meta, o adaptador grava o ID outbound antes de confirmar a entrega na outbox; um reinício usa o recibo já salvo para não reenviar. Uma queda entre a aceitação pelo Graph API e a gravação desse recibo ainda pode duplicar a mensagem.

Há um evento JSON por mensagem e por chamada HTTP. Todo evento possui `conversation_id`, `message_id`, `timestamp`, `stage`, campos com origem, `quote_request_id`, `quote_status`, tentativa, latência, status HTTP, resultado e motivo de handoff.

O corpo bruto da mensagem não entra no estado nem na auditoria. O intake durável guarda telefone e texto apenas cifrados até concluir a entrega. CPF, telefone e e-mail são removidos antes do LLM e antes de gravar qualquer evento. O CEP aparece mascarado na auditoria. O estado contém só os cinco campos necessários, usa permissão `0600` e fica fora do Git.

O dataset sintético oficial serviu apenas para conferir formas de expressão, formatos sensíveis e mídia sem transcrição. Nenhum registro do dataset foi copiado.

## Trade-offs

- O processo mantém um registro de jobs por conversa e usa arquivos locais. Isso basta para uma réplica piloto. Múltiplas réplicas exigiriam banco, lock distribuído e outbox transacional.
- Os três IDs de plano do contrato são validados localmente. As respostas informativas e educativas consultam exclusivamente `GET /planos`; caso o serviço esteja indisponível ou retorne schema incompleto, o agente esclarece a indisponibilidade dos detalhes oficiais em vez de expor valores locais ou carência presumida, preservando a autoridade exclusiva da API.
- Respostas com preço, recusa e handoff são determinísticas. O LLM não pode alterar valor nem decisão.
- Erro de rede genérico não recebe retry, pois a política permite apenas timeout, `500`, `502` e `503`.
- O histórico real de ferramentas de IA será incluído pelo responsável pela submissão em `ai-logs/`; este repositório não inventa esse material.
