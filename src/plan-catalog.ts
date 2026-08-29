export const planCatalog = {
  essencial: {
    nome: "Essencial",
    franquia: 4500,
    coberturas: ["Colisão", "Roubo", "Furto"],
  },
  completo: {
    nome: "Completo",
    franquia: 3000,
    coberturas: ["Colisão", "Roubo", "Furto", "Terceiros", "Vidros"],
  },
  premium: {
    nome: "Premium",
    franquia: 1500,
    coberturas: ["Colisão", "Roubo", "Furto", "Terceiros", "Vidros", "Carro reserva", "Assistência 24h"],
  },
} as const;

export type PlanId = keyof typeof planCatalog;
