import { NextResponse } from "next/server";
import { executeKw, loginWithFallback, type RpcTransport } from "@/lib/odooRpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SearchPayload = {
  baseUrl?: string;
  db?: string;
  username?: string;
  password?: string;
  searchType?: "EAN" | "Article" | "Nom";
  terms?: string[];
  // optionnel si tu veux des prix dépendants du client
  partnerId?: number;
  quantity?: number;
};

const MODEL = "product.product";
const FIELD_ARTICLE = "default_code";
const FIELD_NAME = "name";
const FIELD_EAN = "barcode";
const FIELD_CATEGORY = "categ_id";
const PRICELIST_NAME = "prix_variante";

function extractDigits(value: unknown) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
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
  if (!digits) return null;
  if (digits.length === 12) return `${digits}${computeEan13CheckDigit(digits)}`;
  if (digits.length === 13) return digits;
  return null;
}

function readField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (Array.isArray(value)) return value[1] ?? value[0] ?? "";
  return value;
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = Number(value.replace(",", "."));
    if (Number.isFinite(normalized)) return normalized;
  }
  return null;
}

function pickPrice(value: unknown) {
  const direct = toNumber(value);
  if (direct != null) return direct;

  if (Array.isArray(value) && value.length) {
    const first = toNumber(value[0]);
    if (first != null) return first;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("price" in obj) {
      const price = toNumber(obj.price);
      if (price != null) return price;
    }
  }
  return null;
}

function extractPriceFromResult(result: unknown, pricelistId: number, productId: number) {
  const direct = pickPrice(result);
  if (direct != null) return direct;

  if (Array.isArray(result)) {
    for (const entry of result) {
      const picked = pickPrice(entry);
      if (picked != null) return picked;

      if (Array.isArray(entry) && entry.length >= 2) {
        const key = entry[0];
        const value = entry[1];
        const price = pickPrice(value);
        if (price != null) {
          if (key === productId || key === pricelistId || typeof key !== "number") return price;
        }
      }

      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const prodKey = String(productId);
        const price = pickPrice(obj[prodKey]);
        if (price != null) return price;
      }
    }
  }

  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const plKey = String(pricelistId);
    const prodKey = String(productId);

    const byPl = pickPrice(obj[plKey]);
    if (byPl != null) return byPl;

    const byProd = pickPrice(obj[prodKey]);
    if (byProd != null) return byProd;

    for (const value of Object.values(obj)) {
      const price = pickPrice(value);
      if (price != null) return price;
    }
  }

  return null;
}

function categoryDiscount(categoryName: string) {
  const name = categoryName.toLowerCase();
  if (name.includes("habillement") || name.includes("vetement")) return 0.5;
  if (name.includes("accessoire")) return 0.5;
  if (name.includes("chaussure")) return 0.3;
  if (name.includes("puericulture") || name.includes("parfum")) return 0.1;
  return 0;
}

function applyClubPrice(price: unknown, categoryName: string) {
  const numeric = toNumber(price);
  if (numeric == null) return price;
  const discount = categoryDiscount(categoryName);
  const discounted = numeric * (1 - discount);
  return Math.round(discounted / 100) * 100;
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

/**
 * ✅ Odoo 18 : stratégie la plus fiable = lire un champ avec context pricelist.
 * - On tente "price" (selon modules), puis "lst_price"/"list_price" en fallback.
 */
async function getPriceFromPricelist(
  transport: RpcTransport,
  baseUrl: string,
  db: string,
  uid: number,
  password: string,
  pricelistId: number,
  productId: number,
  quantity: number,
  partnerId?: number,
) {
  // 1) ✅ READ + CONTEXT (souvent la meilleure option en Odoo récent)
  try {
    const res = await executeKw(
      transport,
      baseUrl,
      db,
      uid,
      password,
      "product.product",
      "read",
      [[productId]],
      {
        fields: ["price", "lst_price", "list_price"],
        context: {
          pricelist: pricelistId,
          pricelist_id: pricelistId, // parfois utilisé selon modules
          quantity,
          ...(partnerId ? { partner_id: partnerId } : {}),
        },
      },
    );

    const arr = Array.isArray(res) ? res : [];
    const rec = (arr[0] ?? {}) as Record<string, unknown>;

    // Selon config, "price" peut ne pas exister => on tente plusieurs champs
    const candidate =
      pickPrice(rec.price) ??
      pickPrice(rec.lst_price) ??
      pickPrice(rec.list_price);

    if (candidate != null) return candidate;
  } catch (e) {
    console.error("[Odoo price/read+context] failed explain:", e);
  }

  // 2) Fallback : certaines instances exposent encore ces méthodes
  const attempts: Array<{
    model: string;
    method: string;
    args: unknown[];
    kwargs?: Record<string, unknown>;
    label: string;
  }> = [
    {
      label: "product.pricelist._compute_price_rule",
      model: "product.pricelist",
      method: "_compute_price_rule",
      args: [[pricelistId], [[productId, quantity, partnerId || false]]],
    },
    {
      label: "product.pricelist.compute_price_rule",
      model: "product.pricelist",
      method: "compute_price_rule",
      args: [[pricelistId], [[productId, quantity, partnerId || false]]],
    },
    {
      label: "product.pricelist.get_products_price",
      model: "product.pricelist",
      method: "get_products_price",
      args: [[pricelistId], [productId], [quantity]],
    },
    {
      label: "product.pricelist.get_product_price",
      model: "product.pricelist",
      method: "get_product_price",
      args: [[pricelistId], productId, quantity, partnerId || false],
    },
  ];

  for (const attempt of attempts) {
    try {
      const result = await executeKw(
        transport,
        baseUrl,
        db,
        uid,
        password,
        attempt.model,
        attempt.method,
        attempt.args,
        attempt.kwargs,
      );

      const price = extractPriceFromResult(result, pricelistId, productId);
      if (price != null) return price;
    } catch (e) {
      console.error(`[Odoo ${attempt.label}] failed:`, e);
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

    const quantity = typeof body.quantity === "number" && body.quantity > 0 ? body.quantity : 1.0;
    const partnerId = typeof body.partnerId === "number" && body.partnerId > 0 ? body.partnerId : undefined;

    if (!baseUrl || !db || !username || !password || !terms.length) {
      return NextResponse.json({ message: "Parametres Odoo incomplets" }, { status: 400 });
    }

    const { uid, transport, baseUrl: normalizedBaseUrl } =
      await loginWithFallback(baseUrl, db, username, password);

    if (!uid) {
      return NextResponse.json({ message: "Connexion Odoo refusee" }, { status: 401 });
    }

    const pricelistId = await getPricelistId(transport, normalizedBaseUrl, db, uid, password);
    if (!pricelistId) {
      return NextResponse.json(
        { message: `Liste de prix introuvable: ${PRICELIST_NAME}` },
        { status: 404 },
      );
    }

    const normalizedTerms =
      searchType === "EAN"
        ? terms.map((term) => toEan13(term)).filter((term): term is string => Boolean(term))
        : terms;

    if (!normalizedTerms.length) {
      return NextResponse.json({ records: [] });
    }

    let domain: unknown[] | unknown[][] = [];
    if (searchType === "Nom") {
      if (normalizedTerms.length === 1) {
        domain = [[FIELD_NAME, "ilike", normalizedTerms[0]]];
      } else {
        domain = normalizedTerms.reduce<unknown[]>((acc, term, index) => {
          const cond = [FIELD_NAME, "ilike", term];
          if (index === 0) return cond as unknown[];
          return ["|", cond, acc];
        }, []);
      }
    } else {
      const field = searchType === "EAN" ? FIELD_EAN : FIELD_ARTICLE;
      domain = [[field, "in", normalizedTerms]];
    }

    const result = await executeKw(
      transport,
      normalizedBaseUrl,
      db,
      uid,
      password,
      MODEL,
      "search_read",
      [domain],
      { fields: ["id", FIELD_ARTICLE, FIELD_NAME, FIELD_EAN, FIELD_CATEGORY] },
    );

    const records = Array.isArray(result)
      ? await Promise.all(
          result.map(async (item: Record<string, unknown>, index: number) => {
            const productId = Number(item.id);
            const categoryName = String(readField(item, FIELD_CATEGORY) || "");

            let prixPublic: number | null = null;

            if (Number.isFinite(productId) && productId > 0) {
              prixPublic = await getPriceFromPricelist(
                transport,
                normalizedBaseUrl,
                db,
                uid,
                password,
                pricelistId,
                productId,
                quantity,
                partnerId,
              );

              // dernier secours si pricelist ne renvoie rien
              if (prixPublic == null) {
                try {
                  const readRes = await executeKw(
                    transport,
                    normalizedBaseUrl,
                    db,
                    uid,
                    password,
                    "product.product",
                    "read",
                    [[productId]],
                    { fields: ["lst_price", "list_price"] },
                  );
                  const arr = Array.isArray(readRes) ? readRes : [];
                  const rec = (arr[0] ?? {}) as Record<string, unknown>;
                  prixPublic = pickPrice(rec.lst_price) ?? pickPrice(rec.list_price) ?? null;
                } catch (e) {
                  console.error("[Odoo fallback read lst_price] failed:", e);
                }
              }
            }

            return {
              row: index + 1,
              article: String(readField(item, FIELD_ARTICLE) || ""),
              name: String(readField(item, FIELD_NAME) || ""),
              ean: toEan13(readField(item, FIELD_EAN)) || "",
              prixPublic,
              prixClub: applyClubPrice(prixPublic, categoryName),
            };
          }),
        )
      : [];

    return NextResponse.json({ records });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur Odoo";
    return NextResponse.json({ message }, { status: 500 });
  }
}
