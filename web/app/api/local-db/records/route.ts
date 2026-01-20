import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import db from "@/lib/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_FILE_NAME = "ORCHESTRA_MARGE.xlsx";
const DEFAULT_DB_PATH = path.resolve(
  process.cwd(),
  "default-db",
  "orchestra_labels.db",
);

function seedDefaultIfEmpty() {
  const countRow = db
    .prepare("SELECT COUNT(1) as count FROM products")
    .get() as { count?: number };
  if ((countRow?.count || 0) > 0) {
    return false;
  }
  if (!fs.existsSync(DEFAULT_DB_PATH)) {
    return false;
  }
  const defaultDb = new Database(DEFAULT_DB_PATH, { readonly: true });
  const allRecords = defaultDb
    .prepare(
      `SELECT article, ean, prix_club as prixClub, prix_public as prixPublic
       FROM products
       ORDER BY id ASC`,
    )
    .all() as {
    article: string;
    ean: string;
    prixClub: unknown;
    prixPublic: unknown;
  }[];
  const metaRows = defaultDb
    .prepare(`SELECT key, value FROM meta`)
    .all() as { key: string; value: string }[];
  defaultDb.close();

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO products (article, ean, prix_club, prix_public, source, category, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const clear = db.prepare("DELETE FROM products");
  const clearMeta = db.prepare("DELETE FROM meta");
  const insertMeta = db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
  );
  const transaction = db.transaction((records) => {
    clear.run();
    clearMeta.run();
    records.forEach((record: typeof allRecords[number]) => {
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
    if (metaRows.length) {
      metaRows.forEach((row) => insertMeta.run(row.key, row.value));
    } else {
      insertMeta.run("file_name", DEFAULT_FILE_NAME);
      insertMeta.run("sheet_name", "");
      insertMeta.run("updated_at", String(now));
    }
  });

  transaction(allRecords);
  return true;
}

export async function GET() {
  try {
    seedDefaultIfEmpty();
    const rows = db
      .prepare(
        `SELECT article, ean, prix_club as prixClub, prix_public as prixPublic
         FROM products
         ORDER BY id ASC`,
      )
      .all();
    const metaRows = db
      .prepare(`SELECT key, value FROM meta`)
      .all() as { key: string; value: string }[];
    const meta = metaRows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    const sourceRow = db
      .prepare(
        `SELECT source FROM products
         WHERE source IS NOT NULL AND source != ''
         LIMIT 1`,
      )
      .get() as { source?: string } | undefined;
    return NextResponse.json({
      records: rows,
      meta: {
        source: meta.file_name || sourceRow?.source || "",
        sheet: meta.sheet_name || "",
        defaultFile: DEFAULT_FILE_NAME,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur base locale";
    return NextResponse.json({ message }, { status: 500 });
  }
}
