import { NextResponse } from "next/server";
import db from "@/lib/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = db
      .prepare(
        `SELECT article, ean, prix_club as prixClub, prix_public as prixPublic
         FROM products
         ORDER BY id ASC`,
      )
      .all();
    return NextResponse.json({ records: rows });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur base locale";
    return NextResponse.json({ message }, { status: 500 });
  }
}
