import assert from "node:assert/strict";
import { test } from "node:test";
import { QuoteClient } from "../src/quote-client.ts";
import type { QuotePayload, QuoteResult } from "../src/types.ts";

const payload: QuotePayload = {
  plano_id: "completo",
  idade: 35,
  veiculo_ano: 2022,
  cep: "01310-100",
  data_inicio: "2026-09-01",
};

async function refusal(response: Response): Promise<QuoteResult> {
  const client = new QuoteClient({
    baseUrl: "http://quote.test",
    maxAttempts: 1,
    fetcher: async () => response,
  });
  return client.request(payload, "request-1", async () => undefined);
}

test("sanitiza e limita o motivo de uma recusa 422", async () => {
  const normalized = await refusal(new Response(JSON.stringify({ motivo: `  ${"a".repeat(95)}\n cinco  ` }), { status: 422 }));
  assert.equal(normalized.kind, "refused");
  if (normalized.kind === "refused") {
    assert.equal(normalized.reason, `${"a".repeat(95)} cinc`);
    assert.equal(normalized.reason.length, 100);
  }
});

test("usa fallback seguro para motivo inválido, técnico ou com PII", async () => {
  const responses = [
    new Response("{", { status: 422 }),
    new Response(JSON.stringify({ detail: [] }), { status: 422 }),
    new Response(JSON.stringify({ motivo: "   " }), { status: 422 }),
    new Response(JSON.stringify({ motivo: "Falha HTTP durante retry" }), { status: 422 }),
    new Response(JSON.stringify({ motivo: "Tentativa em background" }), { status: 422 }),
    new Response(JSON.stringify({ motivo: "CPF 123.456.789-00" }), { status: 422 }),
    new Response(JSON.stringify({ motivo: "CEP 01310-100" }), { status: 422 }),
    new Response(JSON.stringify({ motivo: "Valor R$ 209,90" }), { status: 422 }),
    new Response(JSON.stringify({ motivo: "ID 9e6ab6f3-a24e-4dd9-bf69-5d3d08a5fdc5" }), { status: 422 }),
  ];
  for (const response of responses) {
    const result = await refusal(response);
    assert.equal(result.kind, "refused");
    if (result.kind === "refused") {
      assert.equal(result.reason, "Cotação recusada pela seguradora");
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0]?.will_retry, false);
    }
  }
});

test("fetchPlans faz um único GET e retorna objeto ou null", async () => {
  const catalog = { moeda: "BRL", planos: [] };
  let calls = 0;
  const client = new QuoteClient({
    baseUrl: "http://quote.test/",
    fetcher: async (input, init) => {
      calls += 1;
      assert.equal(String(input), "http://quote.test/planos");
      assert.equal(init?.method, "GET");
      assert.ok(init?.signal);
      return new Response(JSON.stringify(catalog));
    },
  });
  assert.deepEqual(await client.fetchPlans(), catalog);
  assert.equal(calls, 1);

  const unavailable = new QuoteClient({
    baseUrl: "http://quote.test",
    fetcher: async () => new Response("indisponível", { status: 503 }),
  });
  assert.equal(await unavailable.fetchPlans(), null);
});
