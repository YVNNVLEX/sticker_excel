import { NextResponse } from "next/server";
import { executeKw, loginWithFallback, type RpcTransport } from "@/lib/odooRpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchPayload = {
  baseUrl?: string;
  db?: string;
  username?: string;
  password?: string;
  searchType?: "EAN" | "Article";
  terms?: string[];
};

const MODEL = "product.product";
const FIELD_ARTICLE = "default_code";
const FIELD_EAN = "barcode";
const FIELD_CATEGORY = "categ_id";
const PRICELIST_NAME = "prix_variante";

function extractDigits(value: unknown) {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  const digits = String(value).replace(/\D+/g, "");
  return digits ? digits : null;
}

function computeEan13CheckDigit(digits12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = Number(digits12[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const mod = sum % 10;
  return String(mod === 0 ? 0 : 10 - mod);
}

function toEan13(value: unknown) {
  const digits = extractDigits(value);
  if (!digits) {
    return null;
  }
  if (digits.length === 12) {
    return `${digits}${computeEan13CheckDigit(digits)}`;
  }
  if (digits.length === 13) {
    return digits;
  }
  return null;
}

function readField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (Array.isArray(value)) {
    return value[1] ?? value[0] ?? "";
  }
  return value;
}

function categoryDiscount(categoryName: string) {
  const name = categoryName.toLowerCase();
  if (name.includes("habillement") || name.includes("vetement")) {
    return 0.5;
  }
  if (name.includes("accessoire")) {
    return 0.5;
  }
  if (name.includes("chaussure")) {
    return 0.3;
  }
  if (name.includes("puericulture") || name.includes("parfum")) {
    return 0.1;
  }
  return 0;
}

function applyClubPrice(price: unknown, categoryName: string) {
  if (typeof price === "number" && Number.isFinite(price)) {
    const discount = categoryDiscount(categoryName);
    return Math.round(price * (1 - discount));
  }
  if (typeof price === "string") {
    const normalized = Number(price.replace(",", "."));
    if (Number.isFinite(normalized)) {
      const discount = categoryDiscount(categoryName);
      return Math.round(normalized * (1 - discount));
    }
  }
  return price;
}

function extractPriceFromResult(
  result: unknown,
  pricelistId: number,
  productId: number,
) {
  if (typeof result === "number" && Number.isFinite(result)) {
    return result;
  }
  if (Array.isArray(result)) {
    if (result.length >= 1 && typeof result[0] === "number" && Number.isFinite(result[0])) {
      return result[0];
    }
    for (const entry of result) {
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return entry;
      }
      if (Array.isArray(entry) && entry.length >= 2) {
        const key = entry[0];
        const value = entry[1];
        if (typeof value === "number" && Number.isFinite(value)) {
          if (key === productId || key === pricelistId || typeof key !== "number") {
            return value;
          }
        }
      }
      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        if (typeof obj.price === "number" && Number.isFinite(obj.price)) {
          return obj.price;
        }
      }
    }
  }
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.price === "number" && Number.isFinite(obj.price)) {
      return obj.price;
    }
    const plKey = String(pricelistId);
    const prodKey = String(productId);
    if (plKey in obj) {
      const val = obj[plKey];
      if (typeof val === "number") {
        return val;
      }
      if (val && typeof val === "object") {
        const nested = val as Record<string, unknown>;
        if (prodKey in nested && typeof nested[prodKey] === "number") {
          return nested[prodKey] as number;
        }
      }
    }
    if (prodKey in obj) {
      const val = obj[prodKey];
      if (typeof val === "number") {
        return val;
      }
      if (val && typeof val === "object") {
        const nested = val as Record<string, unknown>;
        if (plKey in nested && typeof nested[plKey] === "number") {
          return nested[plKey] as number;
        }
      }
    }
  }
  return null;
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = Number(value.replace(",", "."));
    if (Number.isFinite(normalized)) {
      return normalized;
    }
  }
  return null;
}

async function getPricelistId(
  transport: RpcTransport,
  baseUrl: string,
  db: string,
  uid: number,
  password: string,
) {
  const result = await executeKw(
    transport,
    baseUrl,
    db,
    uid,
    password,
    "product.pricelist",
    "search_read",
    [[["name", "ilike", PRICELIST_NAME]]],
    { fields: ["id", "name"], limit: 1 },
  );
  const list = Array.isArray(result) ? result : [];
  const item = list[0] as { id?: number; name?: string } | undefined;
  return item?.id ?? null;
}

async function getPriceFromPricelist(
  transport: RpcTransport,
  baseUrl: string,
  db: string,
  uid: number,
  password: string,
  pricelistId: number,
  productId: number,
) {
  const attempts = [
    { method: "get_product_price_rule", args: [[pricelistId], productId, 1.0, false] },
    { method: "get_product_price_rule", args: [[pricelistId], productId, 1.0, false, false] },
    { method: "get_product_price", args: [[pricelistId], productId, 1.0, false] },
    { method: "get_product_price", args: [[pricelistId], productId, 1.0, false, false] },
    { method: "price_get", args: [[pricelistId], productId, 1.0, false] },
    { method: "price_get", args: [[pricelistId], [productId], 1.0, false] },
    { method: "get_products_price", args: [[pricelistId], [productId], [1.0], false] },
    { method: "get_products_price", args: [[pricelistId], [productId], 1.0, false] },
    { method: "compute_price_rule", args: [[pricelistId], [[productId, 1.0, false]]] },
    { method: "_compute_price_rule", args: [[pricelistId], [[productId, 1.0, false]]] },
  ];

  for (const attempt of attempts) {
    try {
      const result = await executeKw(
        transport,
        baseUrl,
        db,
        uid,
        password,
        "product.pricelist",
        attempt.method,
        attempt.args,
      );
      const price = extractPriceFromResult(result, pricelistId, productId);
      if (price != null) {
        return price;
      }
    } catch {
      // try next method
    }
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SearchPayload;
    const baseUrl = (body.baseUrl || "").trim();
    const db = (body.db || "").trim();
    const username = (body.username || "").trim();
    const password = body.password || "";
    const searchType = body.searchType || "EAN";
    const terms = (body.terms || []).map((term) => String(term).trim()).filter(Boolean);

    if (
      !baseUrl ||
      !db ||
      !username ||
      !password ||
      !terms.length
    ) {
      return NextResponse.json(
        { message: "Parametres Odoo incomplets" },
        { status: 400 },
      );
    }

    const { uid, transport, baseUrl: normalizedBaseUrl } =
      await loginWithFallback(baseUrl, db, username, password);

    if (!uid) {
      return NextResponse.json(
        { message: "Connexion Odoo refusee" },
        { status: 401 },
      );
    }

    const pricelistId = await getPricelistId(
      transport,
      normalizedBaseUrl,
      db,
      uid,
      password,
    );
    if (!pricelistId) {
      return NextResponse.json(
        { message: `Liste de prix introuvable: ${PRICELIST_NAME}` },
        { status: 404 },
      );
    }

    const normalizedTerms =
      searchType === "EAN"
        ? terms
            .map((term) => toEan13(term))
            .filter((term): term is string => Boolean(term))
        : terms;

    if (!normalizedTerms.length) {
      return NextResponse.json({ records: [] });
    }

    const field = searchType === "EAN" ? FIELD_EAN : FIELD_ARTICLE;
    const domain = [[field, "in", normalizedTerms]];
    const fields = [
      FIELD_ARTICLE,
      FIELD_EAN,
      FIELD_CATEGORY,
      "list_price",
      "lst_price",
    ];

    const result = await executeKw(
      transport,
      normalizedBaseUrl,
      db,
      uid,
      password,
      MODEL,
      "search_read",
      [domain],
      { fields: ["id", ...fields] },
    );

    const records = Array.isArray(result)
      ? await Promise.all(
          result.map(async (item: Record<string, unknown>, index: number) => {
            const productId = Number(item.id);
            const categoryName = String(readField(item, FIELD_CATEGORY) || "");
            let prixPublic = null;
            if (Number.isFinite(productId) && productId > 0) {
              prixPublic = await getPriceFromPricelist(
                transport,
                normalizedBaseUrl,
                db,
                uid,
                password,
                pricelistId,
                productId,
              );
            }
            if (prixPublic == null) {
              const basePrice =
                toNumber(readField(item, "lst_price")) ??
                toNumber(readField(item, "list_price"));
              if (basePrice != null) {
                prixPublic = basePrice;
              }
            }

            return {
              row: index + 1,
              article: String(readField(item, FIELD_ARTICLE) || ""),
              ean: toEan13(readField(item, FIELD_EAN)) || "",
              prixClub: applyClubPrice(prixPublic, categoryName),
              prixPublic,
            };
          }),
        )
      : [];

    return NextResponse.json({ records });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur Odoo";
    return NextResponse.json({ message }, { status: 500 });
  }
}
