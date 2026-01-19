import { NextResponse } from "next/server";
import XLSX from "xlsx";
import db from "@/lib/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLUMN_LETTERS = {
  article: "R",
  ean: "T",
  prixClub: "AM",
  prixPublic: "AN",
} as const;

function columnLetterToIndex(letter: string) {
  let index = 0;
  const letters = String(letter || "").toUpperCase();
  for (let i = 0; i < letters.length; i += 1) {
    const code = letters.charCodeAt(i);
    if (code < 65 || code > 90) {
      return 0;
    }
    index = index * 26 + (code - 64);
  }
  return Math.max(0, index - 1);
}

function normalizeHeader(text: unknown) {
  if (text == null) {
    return "";
  }
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findHeaderRow(rows: unknown[][]) {
  const target = normalizeHeader("EAN Composant UVC");
  const max = Math.min(rows.length, 50);
  for (let i = 0; i < max; i += 1) {
    const row = rows[i] || [];
    for (let j = 0; j < row.length; j += 1) {
      if (normalizeHeader(row[j]) === target) {
        return i;
      }
    }
  }
  return 6;
}

function normalizeText(value: unknown) {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Number.isInteger(value) ? Math.trunc(value) : value);
  }
  const text = String(value).trim();
  return text ? text : null;
}

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

function parseRecordsFromRows(rows: unknown[][]) {
  const headerRow = findHeaderRow(rows);
  const colIndex = {
    article: columnLetterToIndex(COLUMN_LETTERS.article),
    ean: columnLetterToIndex(COLUMN_LETTERS.ean),
    prixClub: columnLetterToIndex(COLUMN_LETTERS.prixClub),
    prixPublic: columnLetterToIndex(COLUMN_LETTERS.prixPublic),
  };

  const parsed: {
    article: string;
    ean: string;
    prixClub: unknown;
    prixPublic: unknown;
  }[] = [];

  for (let i = headerRow + 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const article = normalizeText(row[colIndex.article]);
    const ean = toEan13(row[colIndex.ean]);
    const prixClub = row[colIndex.prixClub];
    const prixPublic = row[colIndex.prixPublic];

    if (!article && !ean && prixClub == null && prixPublic == null) {
      continue;
    }

    parsed.push({
      article: article || "",
      ean: ean || "",
      prixClub,
      prixPublic,
    });
  }
  return parsed;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { message: "Fichier manquant" },
        { status: 400 },
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });

    const allRecords: {
      article: string;
      ean: string;
      prixClub: unknown;
      prixPublic: unknown;
    }[] = [];

    workbook.SheetNames.forEach((name) => {
      const sheet = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: null,
      }) as unknown[][];
      allRecords.push(...parseRecordsFromRows(rows));
    });

    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO products (article, ean, prix_club, prix_public, source, category, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const clear = db.prepare("DELETE FROM products");
    const transaction = db.transaction((records) => {
      clear.run();
      records.forEach((record: typeof allRecords[number]) => {
        insert.run(
          record.article,
          record.ean,
          record.prixClub,
          record.prixPublic,
          "excel",
          "",
          now,
        );
      });
    });

    transaction(allRecords);

    return NextResponse.json({ count: allRecords.length });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur import";
    return NextResponse.json({ message }, { status: 500 });
  }
}
