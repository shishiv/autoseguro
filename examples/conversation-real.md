# Conversa real de ponta a ponta

Execução feita em 28/08/2026 com:

- Ollama Cloud em `https://ollama.com/v1`;
- modelo `deepseek-v4-flash:0731`;
- API oficial de cotação no commit `b617ef83b736b90b94bf145b554b5cb3128f518b`;
- instabilidade ativa: 20% de falha, 10% de lentidão de 8 segundos e seed 3;
- nenhum dado pessoal no roteiro.

A seed 3 produz uma chamada lenta primeiro. O agente respondeu ao lead enquanto essa chamada seguia em segundo plano, encerrou a tentativa aos 3 segundos e obteve a cotação na segunda chamada.

Comando:

```bash
STATE_DIR=.runtime/demo-state \
AUDIT_LOG_PATH=.runtime/demo-audit.jsonl \
npm run chat -- \
  --conversation demo-real-20260828 \
  --replay examples/conversation-input.jsonl \
  --reset
```

Transcrição registrada pela CLI:

```text
Lead: Olá, quero fazer uma cotação para meu carro.
AutoSeguro: Beleza, vamos seguir com a cotação. Preciso de: plano (Essencial, Completo ou Premium), idade, ano do veículo, CEP onde o veículo dorme, data de início (AAAA-MM-DD).
Lead: Quero o plano Completo. Tenho 35 anos, o carro é de 2022, o CEP é 01310-100 e quero começar em 15/09/2026.
AutoSeguro: Dados recebidos. A cotação começou em segundo plano e eu aviso aqui quando terminar. Protocolo 49195518-a82b-4d3b-80fc-469f0a71d698.
Lead: Já conseguiu?
AutoSeguro: A cotação segue em processamento com tentativas limitadas. Não abri outra solicitação. Protocolo 49195518-a82b-4d3b-80fc-469f0a71d698.
AutoSeguro [assíncrono]: Cotação confirmada pela API. Plano Completo: R$ 209,90 por mês, franquia de R$ 3.000,00. Coberturas: colisao, roubo, furto, terceiros, vidros. O primeiro pagamento proporcional é R$ 111,95. Protocolo 49195518-a82b-4d3b-80fc-469f0a71d698.
```

A API respondeu com timeout na primeira tentativa e `200` na segunda. O preço mensal, a franquia e o primeiro pagamento vieram da resposta real da API. O arquivo `conversation-real.audit.jsonl` é o recorte de auditoria produzido na mesma execução.
