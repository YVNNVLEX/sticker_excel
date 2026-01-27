export function normalizeText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value === false) return "";
  if (value === true) return "Oui";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = String(value).trim();
  if (!text || text.toLowerCase() === "false") return "";
  return text;
}

export function formatPrice(value: unknown) {
  if (value == null || value === "") return "-";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(Math.trunc(value)) : String(value);
  }
  const text = String(value).trim();
  return text || "-";
}

export function formatPriceWithSeparator(value: unknown) {
  const price = formatPrice(value);
  if (price === "-") return price;
  return price.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatNumber(value: unknown) {
  if (value == null || value === "") return "-";
  const num = Number(value);
  if (Number.isFinite(num)) return num.toLocaleString("fr-FR");
  const text = String(value).trim();
  return text || "-";
}

export function formatDate(value: unknown) {
  if (!value) return "-";
  const date =
    typeof value === "string"
      ? new Date(value)
      : value instanceof Date
        ? value
        : typeof value === "number"
          ? new Date(value)
          : null;
  if (!date || Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleDateString("fr-FR");
}

export function formatStatus(value: unknown) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return "";
  if (["active", "actif", "en cours"].some((k) => text.includes(k))) return "Active";
  if (["inactive", "inactif", "désactiv", "desactiv"].some((k) => text.includes(k)))
    return "Inactive";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function splitInput(text: string) {
  if (!text) return [];
  return text
    .split(/[;,]/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return {} as Record<string, unknown>;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      message: `Reponse non JSON (${response.status})`,
      raw: text.slice(0, 200),
    } as Record<string, unknown>;
  }
}
