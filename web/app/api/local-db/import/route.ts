import { NextResponse } from "next/server";
import XLSX from "xlsx";
import db from "@/lib/sqlite";
import { parseRecordsFromRows } from "@/lib/excelParser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


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
    const sheetName = String(formData.get("sheet") || "").trim();

    const allRecords: {
      article: string;
      ean: string;
      prixClub: unknown;
      prixPublic: unknown;
    }[] = [];

    const targetSheets = sheetName
      ? workbook.SheetNames.filter((name) => name === sheetName)
      : workbook.SheetNames;

    targetSheets.forEach((name) => {
      const sheet = workbook.Sheets[name];
      if (!sheet) {
        return;
      }
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: null,
      }) as unknown[][];
      allRecords.push(...parseRecordsFromRows(rows));
    });

    const now = Date.now();
    const sourceName = file.name ? file.name.trim() : "Fichier Excel";
    const insert = db.prepare(
      `INSERT INTO products (article, ean, prix_club, prix_public, source, category, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const clearMeta = db.prepare("DELETE FROM meta");
    const insertMeta = db.prepare(
      `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
    );
    const clear = db.prepare("DELETE FROM products");
    const transaction = db.transaction((records) => {
      clear.run();
      clearMeta.run();
      records.forEach((record: typeof allRecords[number]) => {
        insert.run(
          record.article,
          record.ean,
          record.prixClub,
          record.prixPublic,
          sourceName,
          "",
          now,
        );
      });
      insertMeta.run("file_name", sourceName);
      if (sheetName) {
        insertMeta.run("sheet_name", sheetName);
      }
      insertMeta.run("updated_at", String(now));
    });

    transaction(allRecords);

    return NextResponse.json({ count: allRecords.length });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur import";
    return NextResponse.json({ message }, { status: 500 });
  }
}
