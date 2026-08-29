import type { ActionId, AgentReply, ReplyInteraction } from "./types.ts";

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
}

export function renderInteraction(interaction: ReplyInteraction | undefined): string {
  return interaction
    ? `\n\n${interaction.actions.map((action, index) => `${index + 1}. ${action.title}`).join("\n")}`
    : "";
}

export function renderPlainText(reply: AgentReply): string {
  return `${reply.text}${renderInteraction(reply.interaction)}`;
}

export function actionFromChoice(reply: AgentReply | null, value: string): ActionId | null {
  if (!reply?.interaction) {
    return null;
  }
  const choice = normalize(value);
  const index = Number(choice);
  if (Number.isInteger(index) && index >= 1 && index <= reply.interaction.actions.length) {
    return reply.interaction.actions[index - 1]?.id ?? null;
  }
  return reply.interaction.actions.find((action) => normalize(action.title) === choice)?.id ?? null;
}
