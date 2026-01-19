import { NextResponse } from "next/server";
import { loginWithFallback } from "@/lib/odooRpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TestPayload = {
  baseUrl?: string;
  db?: string;
  username?: string;
  password?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TestPayload;
    const baseUrl = (body.baseUrl || "").trim();
    const db = (body.db || "").trim();
    const username = (body.username || "").trim();
    const password = body.password || "";

    if (!baseUrl || !db || !username || !password) {
      return NextResponse.json(
        { ok: false, message: "Champs Odoo incomplets" },
        { status: 400 },
      );
    }

    const { uid } = await loginWithFallback(baseUrl, db, username, password);

    if (!uid) {
      return NextResponse.json(
        { ok: false, message: "Connexion Odoo refusee" },
        { status: 401 },
      );
    }

    return NextResponse.json({ ok: true, uid });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erreur Odoo";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
