import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "labels.db");
const defaultDbPath = path.join(process.cwd(), "default-db", "orchestra_labels.db");

if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {
  if (fs.existsSync(defaultDbPath)) {
    fs.copyFileSync(defaultDbPath, dbPath);
  }
}
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
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

export default db;
