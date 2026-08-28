const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const cpfPattern = /(?<!\d)\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}(?!\d)/gu;
const phonePattern = /(?<!\d)(?:\+?55[\s.-]*)?(?:\(\d{2}\)|\d{2})[\s.-]*9?\d{4}[\s.-]*\d{4}(?!\d)/gu;

export function redactSensitiveText(value: string): string {
  return value
    .replace(emailPattern, "<email_redacted>")
    .replace(cpfPattern, "<cpf_redacted>")
    .replace(phonePattern, "<phone_redacted>");
}

export function maskCep(value: string): string {
  const digits = value.replace(/\D/gu, "");
  return digits.length === 8 ? `${digits.slice(0, 2)}***-***` : "<cep_invalid>";
}
