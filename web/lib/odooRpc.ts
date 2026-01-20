import xmlrpc from "xmlrpc";

type JsonRpcPayload = {
  jsonrpc: "2.0";
  method: "call";
  params: {
    service: string;
    method: string;
    args: unknown[];
  };
  id: number;
};

export type RpcTransport = "json" | "xml";

const SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return "";
  }
  const withScheme = SCHEME_REGEX.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    url.hash = "";
    url.search = "";
    const segments = url.pathname.split("/").filter(Boolean);
    const stopIndex = segments.findIndex((segment) =>
      ["web", "jsonrpc", "xmlrpc"].includes(segment.toLowerCase()),
    );
    const kept =
      stopIndex >= 0 ? segments.slice(0, stopIndex) : segments;
    url.pathname = kept.length ? `/${kept.join("/")}` : "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function buildBaseUrlCandidates(baseUrl: string) {
  const trimmed = baseUrl.trim();
  const normalized = normalizeBaseUrl(trimmed);
  const candidates = new Set<string>();
  if (normalized) {
    candidates.add(normalized);
  }
  const hasScheme = SCHEME_REGEX.test(trimmed);
  if (!hasScheme && normalized.startsWith("https://")) {
    candidates.add(normalized.replace(/^https:/, "http:"));
  } else if (normalized.startsWith("http://")) {
    candidates.add(normalized.replace(/^http:/, "https:"));
  }
  return Array.from(candidates);
}

function isJsonFallbackError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("reponse non json") ||
    message.includes("type='json'") ||
    message.includes("bad request") ||
    message.includes("jsonrpc") ||
    message.includes("fetch failed") ||
    message.includes("enotfound") ||
    message.includes("econn")
  );
}

function isXmlFallbackError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("unknown xml-rpc tag") ||
    message.includes("non-whitespace before first tag") ||
    message.includes("bad request") ||
    message.includes("fetch failed") ||
    message.includes("enotfound") ||
    message.includes("econn")
  );
}

async function jsonRpcCall(
  baseUrl: string,
  service: string,
  method: string,
  args: unknown[],
) {
  const payload: JsonRpcPayload = {
    jsonrpc: "2.0",
    method: "call",
    params: { service, method, args },
    id: Date.now(),
  };
  const response = await fetch(`${baseUrl}/jsonrpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const text = await response.text();
  let data: {
    result?: unknown;
    error?: { data?: { message?: string }; message?: string };
  };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Reponse non JSON de Odoo: ${text.slice(0, 200)}`);
  }
  if (!response.ok || data.error) {
    const message =
      data?.error?.data?.message || data?.error?.message || "Odoo error";
    throw new Error(message);
  }
  return data.result;
}

function xmlRpcCall(
  baseUrl: string,
  endpoint: "common" | "object",
  method: string,
  args: unknown[],
) {
  const url = `${baseUrl}/xmlrpc/2/${endpoint}`;
  return new Promise<unknown>((resolve, reject) => {
    const client = url.startsWith("https://")
      ? xmlrpc.createSecureClient({ url })
      : xmlrpc.createClient({ url });
    client.methodCall(method, args, (error: unknown, value: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
  });
}

export async function loginWithFallback(
  baseUrl: string,
  db: string,
  username: string,
  password: string,
) {
  const candidates = buildBaseUrlCandidates(baseUrl);
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const uid = await jsonRpcCall(candidate, "common", "login", [
        db,
        username,
        password,
      ]);
      return {
        uid: Number(uid) || 0,
        transport: "json" as RpcTransport,
        baseUrl: candidate,
      };
    } catch (error) {
      lastError = error;
      if (!isJsonFallbackError(error)) {
        throw error;
      }
    }

    try {
      const uid = await xmlRpcCall(candidate, "common", "login", [
        db,
        username,
        password,
      ]);
      return {
        uid: Number(uid) || 0,
        transport: "xml" as RpcTransport,
        baseUrl: candidate,
      };
    } catch (error) {
      lastError = error;
      if (!isXmlFallbackError(error)) {
        throw error;
      }
    }
  }

  if (lastError instanceof Error) {
    const message = lastError.message.toLowerCase();
    if (message.includes("unknown xml-rpc tag")) {
      throw new Error(
        "URL Odoo invalide ou redirection HTML. Utilisez l'URL racine (sans /web).",
      );
    }
    throw lastError;
  }
  throw new Error("Connexion Odoo impossible");
}

export async function executeKw(
  transport: RpcTransport,
  baseUrl: string,
  db: string,
  uid: number,
  password: string,
  model: string,
  method: string,
  args: unknown[],
  kwargs?: Record<string, unknown>,
) {
  const payloadArgs = kwargs
    ? [db, uid, password, model, method, args, kwargs]
    : [db, uid, password, model, method, args];
  if (transport === "json") {
    return jsonRpcCall(baseUrl, "object", "execute_kw", payloadArgs);
  }
  return xmlRpcCall(baseUrl, "object", "execute_kw", payloadArgs);
}
