/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const Database = require("better-sqlite3");

const DEFAULT_FILE_NAME = "ORCHESTRA_MARGE.xlsx";
const EXCEL_PATH = path.resolve(__dirname, "..", "..", DEFAULT_FILE_NAME);
const OUTPUT_DIR = path.resolve(__dirname, "..", "default-db");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "orchestra_labels.db");

const COLUMN_LETTERS = {
  article: "R",
  ean: "T",
  prixClub: "AM",
  prixPublic: "AN",
};

function columnLetterToIndex(letter) {
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

function normalizeHeader(text) {
  if (text == null) {
    return "";
  }
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findHeaderRow(rows) {
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

function normalizeText(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Number.isInteger(value) ? Math.trunc(value) : value);
  }
  const text = String(value).trim();
  return text ? text : null;
}

function extractDigits(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  const digits = String(value).replace(/\D+/g, "");
  return digits ? digits : null;
}

function computeEan13CheckDigit(digits12) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = Number(digits12[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const mod = sum % 10;
  return String(mod === 0 ? 0 : 10 - mod);
}

function toEan13(value) {
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

function parseRecordsFromRows(rows) {
  const headerRow = findHeaderRow(rows);
  const colIndex = {
    article: columnLetterToIndex(COLUMN_LETTERS.article),
    ean: columnLetterToIndex(COLUMN_LETTERS.ean),
    prixClub: columnLetterToIndex(COLUMN_LETTERS.prixClub),
    prixPublic: columnLetterToIndex(COLUMN_LETTERS.prixPublic),
  };

  const parsed = [];
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

function buildDatabase(records, bestSheetName) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (fs.existsSync(OUTPUT_PATH)) {
    fs.unlinkSync(OUTPUT_PATH);
  }

  const db = new Database(OUTPUT_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article TEXT,
      ean TEXT,
      prix_club REAL,
      prix_public REAL,
      source TEXT,
      category TEXT,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_products_ean ON products (ean);
    CREATE INDEX IF NOT EXISTS idx_products_article ON products (article);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO products (article, ean, prix_club, prix_public, source, category, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMeta = db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
  );
  const transaction = db.transaction((rows) => {
    rows.forEach((record) => {
      insert.run(
        record.article,
        record.ean,
        record.prixClub,
        record.prixPublic,
        DEFAULT_FILE_NAME,
        "",
        now,
      );
    });
    insertMeta.run("file_name", DEFAULT_FILE_NAME);
    insertMeta.run("sheet_name", bestSheetName);
    insertMeta.run("updated_at", String(now));
  });

  transaction(records);
  db.close();
}

function main() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`Fichier introuvable: ${EXCEL_PATH}`);
    process.exit(1);
  }

  const workbook = XLSX.readFile(EXCEL_PATH, { cellText: false, cellDates: false });
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
    });
    return { name, records: parseRecordsFromRows(rows) };
  });

  const best = sheets.reduce((current, next) =>
    next.records.length > current.records.length ? next : current,
  );

  buildDatabase(best.records, best.name);
  console.log(
    `DB cree: ${OUTPUT_PATH} (${best.records.length} lignes, feuille ${best.name})`,
  );
}

main();
