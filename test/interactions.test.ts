import assert from "node:assert/strict";
import { test } from "node:test";
import { actionFromChoice, renderPlainText } from "../src/interactions.ts";
import type { AgentReply } from "../src/types.ts";

const reply: AgentReply = {
  text: "Escolha como seguir.",
  outcome: "awaiting_data",
  quote_request_id: null,
  interaction: {
    kind: "buttons",
    actions: [
      { id: "quote_start", title: "Continuar" },
      { id: "plans_view", title: "Comparar planos" },
      { id: "human_help", title: "Falar com uma pessoa" },
    ],
  },
};

test("renderização em texto preserva as ações ricas e o mapeamento determinístico", () => {
  assert.equal(
    renderPlainText(reply),
    "Escolha como seguir.\n\n1. Continuar\n2. Comparar planos\n3. Falar com uma pessoa",
  );
  assert.equal(actionFromChoice(reply, "2"), reply.interaction?.actions[1]?.id);
  assert.equal(actionFromChoice(reply, "comparar planos"), reply.interaction?.actions[1]?.id);
  assert.equal(actionFromChoice(reply, "FALAR COM UMA PESSOA"), reply.interaction?.actions[2]?.id);
  assert.equal(actionFromChoice(reply, "4"), null);
});
