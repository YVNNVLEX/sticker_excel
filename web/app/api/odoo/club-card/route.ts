import { NextResponse } from "next/server";
import { executeKw, loginWithFallback, type RpcTransport } from "@/lib/odooRpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Payload = {
  baseUrl?: string;
  db?: string;
  username?: string;
  password?: string;
  model?: string;
  menuName?: string;
  limit?: number;
  offset?: number;
  q?: string;
};

type DiscoveredModel = {
  model: string;
  name: string;
  fields: Set<string>;
};

type CardRow = {
  id: number;
  barcode: string;
  code: string;
  client: string;
  telephone: string;
  email: string;
  date_fin: string;
  statut: string;
};

type ScoredCardRow = CardRow & { score: number };

function toText(value: unknown): string {
  if (value == null || value === false) return "";
  const s = String(value).trim();
  if (!s || s.toLowerCase() === "false") return "";
  return s;
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readMany2One(value: unknown): { id: number | null; name: string } | null {
  if (Array.isArray(value) && value.length) {
    return { id: toNumber(value[0]) ?? null, name: toText(value[1]) };
  }
  return null;
}

function pickText(record: Record<string, unknown>, fields: string[]) {
  for (const f of fields) {
    const v = toText(record[f]);
    if (v) return v;
  }
  return "";
}

function pickStatus(record: Record<string, unknown>) {
  const s = pickText(record, ["status", "state"]);
  if (s) return s;
  if (record.active === true) return "active";
  if (record.active === false) return "inactive";
  return "";
}

function pickBarcodeField(fieldSet: Set<string>) {
  for (const name of BARCODE_PRIORITY) {
    if (fieldSet.has(name)) return name;
  }
  for (const name of fieldSet) {
    const lower = name.toLowerCase();
    if (lower.includes("barcode") || lower.includes("ean")) return name;
  }
  return CODE_FIELDS.find((c) => fieldSet.has(c)) ?? null;
}

function pickOrderField(fieldSet: Set<string>) {
  if (fieldSet.has("partner_id")) return "partner_id";
  const candidates = ["client", "customer_name", "holder_name", "name"];
  const found = candidates.find((f) => fieldSet.has(f));
  if (found) return found;
  if (fieldSet.has("code")) return "code";
  return "id";
}

function normalizeForScore(value: unknown) {
  const text = toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase();
  return text;
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j += 1) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i += 1) {
      const temp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i - 1], dp[i]);
      prev = temp;
    }
  }
  return dp[a.length];
}

function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function scoreCard(query: string, card: CardRow) {
  const q = normalizeForScore(query);
  if (!q) return 0;
  const fields = [
    card.code,
    card.client,
    card.email,
    card.telephone,
    card.statut,
  ].map((v) => normalizeForScore(v));

  let best = 0;
  for (const f of fields) {
    const sim = similarity(q, f);
    if (sim > best) best = sim;
  }
  return best;
}

function buildOrDomain(conditions: unknown[][]): unknown[] {
  const conds = conditions.filter(
    (c) => Array.isArray(c) && c.length === 3 && typeof c[0] === "string",
  );
  if (!conds.length) return [];
  if (conds.length === 1) return [conds[0]];
  const ops = Array(conds.length - 1).fill("|");
  return [...ops, ...conds];
}

const MODEL_HINTS = [
  "club.card",
  "club_card.card",
  "club.card.card",
  "pos.club.card",
  "pos.clubcard",
  "pos.club.card.line",
  "membership.card",
  "club.membership.card",
  "loyalty.card",
];

const PARTNER_FIELDS = ["partner_id", "customer_id", "client_id", "member_id", "customer"];
const CODE_FIELDS = ["code", "barcode", "card_number", "number", "name"];
const BARCODE_PRIORITY = ["barcode", "ean", "ean13", "barcode_number", "code_barre"];
const EMAIL_FIELDS = ["email", "partner_email", "email_from", "customer_email"];
const PHONE_FIELDS = ["phone", "mobile", "partner_phone", "telephone", "tel", "customer_phone"];
const END_DATE_FIELDS = [
  "date_end",
  "date_stop",
  "date_to",
  "end_date",
  "expiry_date",
  "expiration_date",
  "validity_date_end",
  "validity_date",
];

async function detectModelFromMenu(
  transport: RpcTransport,
  baseUrl: string,
  db: string,
  uid: number,
  password: string,
  menuName: string,
): Promise<string | null> {
  const menus = await executeKw(
    transport,
    baseUrl,
    db,
    uid,
    password,
    "ir.ui.menu",
    "search_read",
    [[["name", "ilike", menuName]]],
    { fields: ["name", "action"], limit: 10 },
  );
  if (!Array.isArray(menus) || !menus.length) return null;
  const menu = (menus as any[]).find((m) => m?.action) as any;
  if (!menu?.action) return null;

  const actionStr = toText(menu.action);
  const [actionModel, actionIdStr] = actionStr.split(",").map((x) => (x || "").trim());
  const actionId = Number(actionIdStr);
  if (actionModel !== "ir.actions.act_window" || !Number.isFinite(actionId) || !actionId) {
    return null;
  }

  const actions = await executeKw(
    transport,
    baseUrl,
    db,
    uid,
    password,
    "ir.actions.act_window",
    "read",
    [[actionId]],
    { fields: ["name", "res_model"] },
  );

  const action = Array.isArray(actions) ? (actions as any[])[0] : null;
  const resModel = toText(action?.res_model);
  return resModel || null;
}

async function fieldsForModel(
  transport: RpcTransport,
  baseUrl: string,
  db: string,
  uid: number,
  password: string,
  model: string,
): Promise<Set<string> | null> {
  try {
    const fg = await executeKw(
      transport,
      baseUrl,
      db,
      uid,
      password,
      model,
      "fields_get",
      [],
      { attributes: ["string", "type"] },
    );
    if (fg && typeof fg === "object") {
      return new Set(Object.keys(fg as Record<string, unknown>));
    }
    return null;
  } catch {
    return null;
  }
}

async function discoverModels(
  transport: RpcTransport,
  baseUrl: string,
  db: string,
  uid: number,
  password: string,
): Promise<DiscoveredModel[]> {
  try {
    const domain: unknown[] = [
      "|",
      "|",
      "|",
      "|",
      "|",
      ["model", "ilike", "club"],
      ["name", "ilike", "club"],
      ["model", "ilike", "card"],
      ["name", "ilike", "card"],
      ["name", "ilike", "carte"],
      ["model", "ilike", "membership"],
    ];

    const res = await executeKw(
      transport,
      baseUrl,
      db,
      uid,
      password,
      "ir.model",
      "search_read",
      [domain],
      { fields: ["model", "name"], limit: 30 },
    );

    const rows = Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
    const unique = new Map<string, { model: string; name: string }>();
    for (const hint of MODEL_HINTS) unique.set(hint, { model: hint, name: hint });
    for (const row of rows) {
      const model = toText((row as any).model);
      const name = toText((row as any).name);
      if (model) unique.set(model, { model, name: name || model });
    }

    const discovered: DiscoveredModel[] = [];
    for (const cand of unique.values()) {
      const fields = await fieldsForModel(transport, baseUrl, db, uid, password, cand.model);
      if (fields && fields.size) discovered.push({ model: cand.model, name: cand.name, fields });
    }
    return discovered;
  } catch {
    return [];
  }
}

function pickBestModel(models: DiscoveredModel[]): DiscoveredModel | null {
  const scored = models
    .map((m) => {
      const hasCode = CODE_FIELDS.some((f) => m.fields.has(f));
      const hasPartner = PARTNER_FIELDS.some((f) => m.fields.has(f));
      const hintIndex = MODEL_HINTS.indexOf(m.model);
      const hintScore = hintIndex >= 0 ? 20 - hintIndex : 0;
      const score = hintScore + (hasCode ? 5 : 0) + (hasPartner ? 5 : 0);
      return { m, score, hasCode, hasPartner };
    })
    .filter((x) => x.hasCode && x.hasPartner);
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].m;
}

async function getModuleInfo(
  transport: RpcTransport,
  baseUrl: string,
  db: string,
  uid: number,
  password: string,
) {
  try {
    const mods = await executeKw(
      transport,
      baseUrl,
      db,
      uid,
      password,
      "ir.module.module",
      "search_read",
      [[["name", "ilike", "club"], ["state", "in", ["installed", "to upgrade"]]]],
      { fields: ["name", "shortdesc", "installed_version", "latest_version", "state"], limit: 20 },
    );
    return Array.isArray(mods) ? mods : [];
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Payload;

    const baseUrl = toText(body.baseUrl);
    const db = toText(body.db);
    const username = toText(body.username);
    const password = body.password || "";

    const explicitModel = toText(body.model);
    const menuName = toText(body.menuName) || "Cartes Club";
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 100) : 10;
    const offset = typeof body.offset === "number" && body.offset > 0 ? body.offset : 0;
    const query = toText(body.q);

    if (!baseUrl || !db || !username || !password) {
      return NextResponse.json({ message: "Parametres Odoo incomplets" }, { status: 400 });
    }

    const { uid, transport, baseUrl: normalizedBaseUrl } =
      await loginWithFallback(baseUrl, db, username, password);

    if (!uid) {
      return NextResponse.json({ message: "Connexion Odoo refusee" }, { status: 401 });
    }

    let model: DiscoveredModel | null = null;

    if (explicitModel) {
      const fields = await fieldsForModel(transport, normalizedBaseUrl, db, uid, password, explicitModel);
      if (fields) model = { model: explicitModel, name: explicitModel, fields };
    }

    if (!model) {
      const resModel = await detectModelFromMenu(
        transport,
        normalizedBaseUrl,
        db,
        uid,
        password,
        menuName,
      );
      if (resModel) {
        const fields = await fieldsForModel(transport, normalizedBaseUrl, db, uid, password, resModel);
        if (fields) model = { model: resModel, name: resModel, fields };
      }
    }

    if (!model) {
      for (const hint of MODEL_HINTS) {
        const fields = await fieldsForModel(transport, normalizedBaseUrl, db, uid, password, hint);
        if (fields) {
          model = { model: hint, name: hint, fields };
          break;
        }
      }
    }

    if (!model) {
      const discovered = await discoverModels(transport, normalizedBaseUrl, db, uid, password);
      model = pickBestModel(discovered);
    }

    if (!model) {
      return NextResponse.json(
        { message: "Club Card: modele introuvable (verifie menuName ou indique model)" },
        { status: 404 },
      );
    }

    const codeField = CODE_FIELDS.find((f) => model.fields.has(f)) ?? null;
    const partnerField = PARTNER_FIELDS.find((f) => model.fields.has(f)) ?? null;
    const emailField = EMAIL_FIELDS.find((f) => model.fields.has(f)) ?? null;
    const phoneField = PHONE_FIELDS.find((f) => model.fields.has(f)) ?? null;
    const endDateField = END_DATE_FIELDS.find((f) => model.fields.has(f)) ?? null;
    const statusField = model.fields.has("state")
      ? "state"
      : model.fields.has("status")
        ? "status"
        : null;
    const includeActiveField = !statusField && model.fields.has("active");

    // Keep search_read minimal: only fields required for Code, Client, Email, Telephone, Statut, Date fin.
    const requestedFields = [
      "id",
      codeField,
      partnerField,
      emailField,
      phoneField,
      endDateField,
      statusField,
      includeActiveField ? "active" : null,
    ].filter((f): f is string => Boolean(f));

    const isDev = process.env.NODE_ENV !== "production";

    let domain: unknown[] = [];
    let partnerIds: number[] = [];

    let searchableFields: string[] = [];

    if (query) {
      searchableFields = [
        ...CODE_FIELDS,
        ...EMAIL_FIELDS,
        ...PHONE_FIELDS,
        "name",
        "client",
        "customer_name",
        "holder_name",
      ].filter((f) => model!.fields.has(f));

      if (model.fields.has("partner_id")) {
        const partnerDomain = buildOrDomain([
          ["name", "ilike", query],
          ["email", "ilike", query],
          ["phone", "ilike", query],
          ["mobile", "ilike", query],
        ]);
        const partnerRes = await executeKw(
          transport,
          normalizedBaseUrl,
          db,
          uid,
          password,
          "res.partner",
          "search",
          [partnerDomain],
          { limit: 200 },
        );
        if (Array.isArray(partnerRes)) {
          partnerIds = (partnerRes as unknown[])
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v)) as number[];
        }
      }

      const fieldClauses = searchableFields.map((field) => [field, "ilike", query]) as unknown[][];
      const combined = partnerIds.length
        ? [...fieldClauses, ["partner_id", "in", partnerIds] as unknown[]]
        : fieldClauses;

      domain = buildOrDomain(combined);
    }

    const barcodeField = pickBarcodeField(model.fields);
    const orderField = pickOrderField(model.fields);
    const order = `${orderField} asc,id asc`;

    if (isDev) {
      console.log("[club-card] model", model.model);
      console.log("[club-card] requestedFields", requestedFields);
      console.log("[club-card] domain", JSON.stringify(domain));
      console.log("[club-card] barcodeField", barcodeField);
      console.log("[club-card] order", order);
    }

    const domainArgs = [domain];

    const mapRowsToCards = async (rows: Record<string, unknown>[], startOffset: number) => {
      const partnerIdsInRows = new Set<number>();
      for (const row of rows) {
        const record = row as Record<string, unknown>;
        const m2o = readMany2One(PARTNER_FIELDS.map((f) => record[f]).find((v) => v !== undefined));
        if (m2o?.id) partnerIdsInRows.add(m2o.id);
      }

      let partners = new Map<number, { name: string; email: string; phone: string; mobile: string }>();
      if (partnerIdsInRows.size) {
        const partnerRes = await executeKw(
          transport,
          normalizedBaseUrl,
          db,
          uid,
          password,
          "res.partner",
          "search_read",
          [[["id", "in", Array.from(partnerIdsInRows)]]],
          { fields: ["name", "email", "phone", "mobile"], limit: partnerIdsInRows.size },
        );
        if (Array.isArray(partnerRes)) {
          partners = new Map(
            (partnerRes as any[]).map((p) => [
              Number(p.id) || 0,
              {
                name: toText(p.name),
                email: toText(p.email),
                phone: toText(p.phone),
                mobile: toText(p.mobile),
              },
            ]),
          );
        }
      }

      return rows.map((row, index) => {
        const record = row as Record<string, unknown>;
        const partnerM2O = readMany2One(
          PARTNER_FIELDS.map((f) => record[f]).find((v) => v !== undefined),
        );
        const partner = partnerM2O?.id ? partners.get(partnerM2O.id) : undefined;

        const code = pickText(record, CODE_FIELDS) || `CARD-${startOffset + index + 1}`;
        const barcodeValue = barcodeField ? toText(record[barcodeField]) : "";
        const barcode = barcodeValue || code;
        const client = partner?.name || partnerM2O?.name || "";
        const email = partner?.email || pickText(record, EMAIL_FIELDS);
        const telephone = partner?.phone || partner?.mobile || pickText(record, PHONE_FIELDS);
        const date_fin = pickText(record, END_DATE_FIELDS);
        const statut = pickStatus(record);

        return {
          id: toNumber(record.id) ?? startOffset + index + 1,
          barcode,
          code,
          client,
          telephone,
          email,
          date_fin,
          statut,
        };
      });
    };

    const cardsRes = await executeKw(
      transport,
      normalizedBaseUrl,
      db,
      uid,
      password,
      model.model,
      "search_read",
      domainArgs,
      {
        fields: requestedFields,
        limit,
        offset,
        order,
      },
    );

    const rows = Array.isArray(cardsRes) ? (cardsRes as Record<string, unknown>[]) : [];

    const total = await executeKw(
      transport,
      normalizedBaseUrl,
      db,
      uid,
      password,
      model.model,
      "search_count",
      domainArgs,
    );

    const cards: CardRow[] = await mapRowsToCards(rows, offset);

    let suggestions: ScoredCardRow[] = [];

    if (query) {
      suggestions = cards
        .map((c) => ({ ...c, score: scoreCard(query, c) }))
        .filter((c) => c.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    }

    // Fallback élargi si aucun résultat strict
    if (!cards.length && query && searchableFields.length) {
      const relaxedQuery = query.replace(/\s+/g, "");
      const relaxedConditions = buildOrDomain(
        searchableFields.map((field) => [field, "ilike", relaxedQuery]) as unknown[][],
      );

      const fallbackRes = await executeKw(
        transport,
        normalizedBaseUrl,
        db,
        uid,
        password,
        model.model,
        "search_read",
        [relaxedConditions],
        {
          fields: requestedFields,
          limit: Math.max(20, Math.min(50, limit * 3)),
          offset: 0,
          order,
        },
      );

      const fallbackRows = Array.isArray(fallbackRes)
        ? (fallbackRes as Record<string, unknown>[])
        : [];

      const fallbackCards = await mapRowsToCards(fallbackRows, 0);

      suggestions = fallbackCards
        .map((c) => ({ ...c, score: scoreCard(query, c) }))
        .filter((c) => c.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    }

    const moduleInfo = await getModuleInfo(transport, normalizedBaseUrl, db, uid, password);

    return NextResponse.json({
      program: { name: model.name, model: model.model },
      moduleInfo,
      total: Number(total) || cards.length,
      offset,
      limit,
      has_more: Number(total) > offset + cards.length,
      cards,
      suggestions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur Club Card";
    return NextResponse.json({ message }, { status: 500 });
  }
}
