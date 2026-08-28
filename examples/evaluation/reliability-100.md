# Relatório de confiabilidade

- Execução: 2026-08-28T16:54:39.531Z
- API: `http://127.0.0.1:8000`
- Seed: `42`
- Concorrência: `10`

A API sorteia uma vez por chamada. Um valor abaixo de 0,20 gera 500, 502 ou 503; de 0,20 até abaixo de 0,30 gera uma espera de 8 segundos; os ramos são mutuamente exclusivos. As taxas valem por chamada, não por conversa.

## Teoria e resultado observado

| Métrica | Expectativa teórica | Observado |
|---|---:|---:|
| Chamadas POST | 139 | 148 |
| Respostas 5xx | 27.8 | 31 |
| Chamadas lentas que viraram timeout | 13.9 | 22 |
| Conversas resolvidas em até 3 tentativas | 97.3 | 95 |
| Handoffs após esgotamento | 2.7 | 5 |

Contagem HTTP observada: `2xx=95`, `500=14`, `502=11`, `503=6`, `timeout=22`, `other=0`.

## Conversa durante a cotação

- sucesso na primeira tentativa: 63
- recuperação na tentativa 2: 26
- recuperação na tentativa 3: 6
- respostas de status servidas enquanto pending: 100
- acknowledgement p50/p95/máximo: {"p50":1,"p95":8,"max":12} ms
- conclusão p50/p95/máximo: {"p50":5,"p95":3610,"max":6616} ms

## Passe de linguagem

- conversas: 20
- extrações corretas: 20
- falhas do LLM: 0
- falhas de extração: 0
- endpoint: `https://ollama.com/v1`
- modelo: `deepseek-v4-flash:0731`

## Gates

- PASS: `every_conversation_terminal`
- PASS: `acknowledgement_under_one_second`
- PASS: `status_while_pending`
- PASS: `no_duplicate_quote_operations`
- PASS: `no_price_before_confirmation`
- PASS: `every_failed_quote_has_handoff_context`
- PASS: `every_terminal_reply_delivered`
- PASS: `no_invalid_state_transitions`
- PASS: `no_pii_in_public_artifacts`
- PASS: `language_sample_complete`
- PASS: `language_failures_classified`

## Conversas representativas

### Timeout seguido de sucesso

Conversa `reliability-007`. Tentativas: 1: timeout em 3000 ms; 2: HTTP 200 em 2 ms.

```text
Lead: Plano essencial, tenho 36 anos, veículo 2022, CEP 01***-***, início 07/09/2026.
AutoSeguro: Dados recebidos. A cotação começou em segundo plano e eu aviso aqui quando terminar. Protocolo 86ed105a-301b-47d2-8be6-fd8bccf3bb70.
Lead: Já conseguiu?
AutoSeguro: A cotação segue em processamento com tentativas limitadas. Não abri outra solicitação. Protocolo 86ed105a-301b-47d2-8be6-fd8bccf3bb70.
AutoSeguro [assíncrono]: Cotação confirmada pela API. Plano Essencial: R$ 119,90 por mês, franquia de R$ 4.500,00. Coberturas: colisao, roubo, furto. O primeiro pagamento proporcional é R$ 95,92. Protocolo 86ed105a-301b-47d2-8be6-fd8bccf3bb70.
```

### 5xx seguido de recuperação

Conversa `reliability-004`. Tentativas: 1: HTTP 502 em 8 ms; 2: HTTP 200 em 2 ms.

```text
Lead: Plano essencial, tenho 33 anos, veículo 2019, CEP 01***-***, início 04/09/2026.
AutoSeguro: Dados recebidos. A cotação começou em segundo plano e eu aviso aqui quando terminar. Protocolo 73b62ba8-1e54-48c6-95e4-083bb2ba9e4c.
Lead: Já conseguiu?
AutoSeguro: A cotação segue em processamento com tentativas limitadas. Não abri outra solicitação. Protocolo 73b62ba8-1e54-48c6-95e4-083bb2ba9e4c.
AutoSeguro [assíncrono]: Cotação confirmada pela API. Plano Essencial: R$ 137,88 por mês, franquia de R$ 4.500,00. Coberturas: colisao, roubo, furto. O primeiro pagamento proporcional é R$ 124,09. Protocolo 73b62ba8-1e54-48c6-95e4-083bb2ba9e4c.
```

### Tentativas esgotadas e handoff

Conversa `reliability-002`. Tentativas: 1: timeout em 3002 ms; 2: timeout em 3000 ms; 3: HTTP 500 em 1 ms.

```text
Lead: Plano completo, tenho 31 anos, veículo 2017, CEP 01***-***, início 02/09/2026.
AutoSeguro: Dados recebidos. A cotação começou em segundo plano e eu aviso aqui quando terminar. Protocolo 7d7e0167-551c-4703-bd69-8436251e531a.
Lead: Já conseguiu?
AutoSeguro: A cotação segue em processamento com tentativas limitadas. Não abri outra solicitação. Protocolo 7d7e0167-551c-4703-bd69-8436251e531a.
AutoSeguro [assíncrono]: Não consegui concluir a cotação e não vou estimar um preço. Encaminhei os dados já coletados para uma pessoa do time. Protocolo 7d7e0167-551c-4703-bd69-8436251e531a.
```

Os cenários forçados de timeout→sucesso, 5xx→sucesso, falha mista, esgotamento, 422, 400, duplicata/status durante pending, correção, handoff antes de resultado tardio e retomada rodam no preflight de `npm run evaluate`.
