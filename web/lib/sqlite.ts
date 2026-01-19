import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "labels.db");
const db = new Database(dbPath);

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
`);

export default db;
