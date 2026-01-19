"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type RecordItem = {
  row: number;
  article: string;
  ean: string;
  prixClub: unknown;
  prixPublic: unknown;
};

type SheetSummary = {
  name: string;
  count: number;
};

type OdooConfig = {
  baseUrl: string;
  db: string;
  username: string;
  password: string;
};

type JsBarcodeFn = (
  element: SVGSVGElement,
  value: string,
  options: Record<string, unknown>
) => void;

type PrinterStatus = {
  available: boolean;
  status:
    | "ready"
    | "offline"
    | "error"
    | "unknown"
    | "unavailable"
    | "unsupported";
  name?: string;
};

const COLUMN_LETTERS = {
  article: "R",
  ean: "T",
  prixClub: "AM",
  prixPublic: "AN",
} as const;

const PX_PER_MM = 3.78;

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

function formatPrice(value: unknown) {
  if (value == null || value === "") {
    return "-";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return value.toFixed(2);
  }
  const text = String(value).trim();
  return text || "-";
}

function splitInput(text: string) {
  if (!text) {
    return [];
  }
  return text
    .split(/[;,]/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      message: `Reponse non JSON (${response.status})`,
      raw: text.slice(0, 200),
    };
  }
}

function buildMap(records: RecordItem[], key: "ean" | "article") {
  const map = new Map<string, RecordItem[]>();
  records.forEach((record) => {
    const value = record[key];
    if (!value) {
      return;
    }
    if (!map.has(value)) {
      map.set(value, []);
    }
    map.get(value)?.push(record);
  });
  return map;
}

function parseRecordsFromRows(rows: unknown[][]) {
  const headerRow = findHeaderRow(rows);
  const colIndex = {
    article: columnLetterToIndex(COLUMN_LETTERS.article),
    ean: columnLetterToIndex(COLUMN_LETTERS.ean),
    prixClub: columnLetterToIndex(COLUMN_LETTERS.prixClub),
    prixPublic: columnLetterToIndex(COLUMN_LETTERS.prixPublic),
  };

  const parsed: RecordItem[] = [];
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
      row: i + 1,
      article: article || "",
      ean: ean || "",
      prixClub,
      prixPublic,
    });
  }
  return parsed;
}

function barcodeOptions(
  heightMm: number,
  scale: number,
  displayValue: boolean,
) {
  const ratio = displayValue ? 0.35 : 0.28;
  const heightPx = Math.max(
    6,
    Math.round(heightMm * PX_PER_MM * ratio * scale),
  );
  const moduleMm = 0.33;
  const widthPx = Math.max(
    1,
    Math.round(moduleMm * PX_PER_MM * scale),
  );
  const fontSize = Math.max(10, Math.round(10 * scale));
  return { heightPx, widthPx, fontSize, displayValue };
}

function Barcode({
  value,
  heightPx,
  widthPx,
  fontSize,
  displayValue,
  onRendered,
}: {
  value: string;
  heightPx: number;
  widthPx: number;
  fontSize: number;
  displayValue: boolean;
  onRendered?: () => void;
}) {
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let active = true;
    let rendered = false;
    const render = async () => {
      if (!ref.current) {
        return;
      }
      const mod = await import("jsbarcode");
      const JsBarcode =
        (mod as unknown as { default?: JsBarcodeFn }).default ??
        (mod as unknown as JsBarcodeFn);
      if (!active) {
        return;
      }
      const normalized = toEan13(value) || "";
      if (!normalized) {
        ref.current.innerHTML = "";
        if (!rendered) {
          rendered = true;
          onRendered?.();
        }
        return;
      }
      const options = {
        height: heightPx,
        width: widthPx,
        displayValue,
        fontSize,
        margin: 0,
      };
      try {
        JsBarcode(ref.current, normalized, {
          ...options,
          format: "EAN13",
        });
        if (!rendered) {
          rendered = true;
          onRendered?.();
        }
      } catch {
        ref.current.innerHTML = "";
        if (!rendered) {
          rendered = true;
          onRendered?.();
        }
      }
    };
    render();
    return () => {
      active = false;
    };
  }, [value, heightPx, widthPx, fontSize, displayValue, onRendered]);

  return <svg ref={ref} className="barcode" />;
}

export default function Home() {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [filtered, setFiltered] = useState<RecordItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [status, setStatus] = useState("En attente de fichier");
  const [fileName, setFileName] = useState("Aucun fichier");
  const [sheetOptions, setSheetOptions] = useState<SheetSummary[]>([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [printerStatus, setPrinterStatus] = useState<PrinterStatus>({
    available: false,
    status: "unknown",
  });
  const [searchType, setSearchType] = useState<"EAN" | "Article">("EAN");
  const [searchInput, setSearchInput] = useState("");
  const [labelWidth, setLabelWidth] = useState(50);
  const [labelHeight, setLabelHeight] = useState(25);
  const [previewScale, setPreviewScale] = useState(2);
  const [printOffsetX, setPrintOffsetX] = useState(0);
  const [printOffsetY, setPrintOffsetY] = useState(0);
  const [printQueue, setPrintQueue] = useState<RecordItem[]>([]);
  const [printRenderCount, setPrintRenderCount] = useState(0);
  const [dataSource, setDataSource] = useState<"excel" | "odoo">("excel");
  const [odooModalOpen, setOdooModalOpen] = useState(false);
  const [odooConnected, setOdooConnected] = useState(false);
  const [odooLoading, setOdooLoading] = useState(false);
  const [odooError, setOdooError] = useState("");
  const [odooConfig, setOdooConfig] = useState<OdooConfig>({
    baseUrl: "",
    db: "",
    username: "",
    password: "",
  });
  const sheetRecordsRef = useRef<Record<string, RecordItem[]>>({});
  const printRenderedRef = useRef<Set<string>>(new Set());

  const eanMap = useMemo(() => buildMap(records, "ean"), [records]);
  const articleMap = useMemo(() => buildMap(records, "article"), [records]);

  const selectedRecord =
    selectedIndex != null ? filtered[selectedIndex] : null;

  const previewStyle = {
    width: `${labelWidth * PX_PER_MM * previewScale}px`,
    height: `${labelHeight * PX_PER_MM * previewScale}px`,
  };

  const previewBarcode = barcodeOptions(labelHeight, previewScale, true);
  const printBarcode = barcodeOptions(labelHeight, 1, false);

  const printerLabel = useMemo(() => {
    switch (printerStatus.status) {
      case "ready":
        return "Imprimante connectee";
      case "offline":
        return "Imprimante hors ligne";
      case "error":
        return "Erreur imprimante";
      case "unsupported":
        return "Detection non supportee";
      case "unavailable":
        return "Imprimante non detectee";
      default:
        return "Statut inconnu";
    }
  }, [printerStatus.status]);

  useEffect(() => {
    if (!printQueue.length) {
      return;
    }
    if (printRenderCount < printQueue.length) {
      return;
    }
    const timer = window.setTimeout(() => window.print(), 100);
    return () => window.clearTimeout(timer);
  }, [printQueue, printRenderCount]);

  useEffect(() => {
    const handler = () => setPrintQueue([]);
    window.addEventListener("afterprint", handler);
    return () => window.removeEventListener("afterprint", handler);
  }, []);

  useEffect(() => {
    let active = true;
    const fetchStatus = async () => {
      try {
        const response = await fetch("/api/printer-status", {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error("Printer status error");
        }
        const data = (await response.json()) as PrinterStatus;
        if (active) {
          setPrinterStatus(data);
        }
      } catch {
        if (active) {
          setPrinterStatus({ available: false, status: "unavailable" });
        }
      }
    };
    fetchStatus();
    const timer = window.setInterval(fetchStatus, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const loadLocal = async () => {
      try {
        const response = await fetch("/api/local-db/records", {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { records?: RecordItem[] };
        if (data.records && data.records.length) {
          setRecords(data.records);
          setFiltered([]);
          setSelectedIndex(null);
          setFileName("Base locale (sqlite)");
          setSheetOptions([]);
          setSelectedSheet("");
          setDataSource("excel");
          setStatus(`Base locale chargee: ${data.records.length} lignes`);
        }
      } catch {
        // ignore local db errors
      }
    };
    loadLocal();
  }, []);

  useEffect(() => {
    if (!printQueue.length) {
      printRenderedRef.current = new Set();
      setPrintRenderCount(0);
    }
  }, [printQueue]);

  const handleFile = async (file: File) => {
    setStatus("Lecture du fichier...");
    try {
      const data = await file.arrayBuffer();
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(data, { type: "array" });
      const sheetRecords: Record<string, RecordItem[]> = {};
      const summaries: SheetSummary[] = [];

      workbook.SheetNames.forEach((name) => {
        const sheet = workbook.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: null,
        }) as unknown[][];
        const parsed = parseRecordsFromRows(rows);
        sheetRecords[name] = parsed;
        summaries.push({ name, count: parsed.length });
      });

      const defaultSheet =
        summaries.reduce((best, current) =>
          current.count > best.count ? current : best,
        { name: workbook.SheetNames[0], count: -1 }).name ||
        workbook.SheetNames[0];

      sheetRecordsRef.current = sheetRecords;
      setSheetOptions(summaries);
      setSelectedSheet(defaultSheet);
      setRecords(sheetRecords[defaultSheet] || []);
      setFiltered([]);
      setSelectedIndex(null);
      setFileName(file.name);
      setDataSource((prev) => (prev === "odoo" ? "odoo" : "excel"));
      setStatus(
        `Charge: ${(sheetRecords[defaultSheet] || []).length} lignes (${defaultSheet})`,
      );
      const formData = new FormData();
      formData.append("file", file);
      fetch("/api/local-db/import", { method: "POST", body: formData }).catch(
        () => undefined,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erreur de lecture";
      setStatus("Erreur de lecture");
      alert(`Impossible de lire le fichier: ${message}`);
    }
  };

  const runSearch = () => {
    if (dataSource === "odoo") {
      searchOdoo();
      return;
    }
    if (!records.length) {
      setStatus("Chargez un fichier d abord");
      return;
    }
    const parts = splitInput(searchInput);
    if (!parts.length) {
      setStatus("Entrez une valeur de recherche");
      return;
    }

    const results: RecordItem[] = [];
    if (searchType === "EAN") {
      parts.forEach((part) => {
        const key = toEan13(part);
        if (key && eanMap.has(key)) {
          results.push(...(eanMap.get(key) || []));
        }
      });
    } else {
      parts.forEach((part) => {
        const key = normalizeText(part);
        if (key && articleMap.has(key)) {
          results.push(...(articleMap.get(key) || []));
        }
      });
    }

    const unique: RecordItem[] = [];
    const seen = new Set<string>();
    results.forEach((record) => {
      const key = `${record.row}-${record.article}-${record.ean}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      unique.push(record);
    });

    setFiltered(unique);
    setSelectedIndex(unique.length ? 0 : null);
    setStatus(unique.length ? `Resultats: ${unique.length}` : "Aucun resultat");
  };

  const clearSearch = () => {
    setSearchInput("");
    setFiltered([]);
    setSelectedIndex(null);
    setStatus("Recherche effacee");
  };

  const testOdoo = async () => {
    setOdooLoading(true);
    setOdooError("");
    try {
      const response = await fetch("/api/odoo/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(odooConfig),
      });
      const data = await readJsonResponse(response);
      if (!response.ok || !data.ok) {
        const message =
          typeof data.message === "string"
            ? data.message
            : "Connexion impossible";
        throw new Error(message);
      }
      setOdooConnected(true);
      setDataSource("odoo");
      setStatus("Connexion Odoo reussie");
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Connexion impossible";
      setOdooConnected(false);
      setOdooError(message);
      setStatus("Connexion Odoo echouee");
      return false;
    } finally {
      setOdooLoading(false);
    }
  };

  const connectOdoo = async () => {
    const ok = await testOdoo();
    if (ok) {
      setOdooModalOpen(false);
    }
  };

  const searchOdoo = async () => {
    const parts = splitInput(searchInput);
    if (!parts.length) {
      setStatus("Entrez une valeur de recherche");
      return;
    }
    if (!odooConnected) {
      setStatus("Odoo non connecte");
      return;
    }
    setOdooLoading(true);
    setStatus("Recherche Odoo...");
    try {
      const response = await fetch("/api/odoo/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: odooConfig.baseUrl,
          db: odooConfig.db,
          username: odooConfig.username,
          password: odooConfig.password,
          searchType,
          terms: parts,
        }),
      });
      const data = await readJsonResponse(response);
      if (!response.ok) {
        const message =
          typeof data.message === "string" ? data.message : "Erreur Odoo";
        throw new Error(message);
      }
      const results = (data.records || []) as RecordItem[];
      setFiltered(results);
      setSelectedIndex(results.length ? 0 : null);
      setStatus(results.length ? `Resultats: ${results.length}` : "Aucun resultat");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur Odoo";
      setStatus(message);
      setFiltered([]);
      setSelectedIndex(null);
    } finally {
      setOdooLoading(false);
    }
  };

  const handleSheetChange = (name: string) => {
    const nextRecords = sheetRecordsRef.current[name] || [];
    setSelectedSheet(name);
    setRecords(nextRecords);
    setFiltered([]);
    setSelectedIndex(null);
    setStatus(`Charge: ${nextRecords.length} lignes (${name})`);
  };

  const handlePrintSelected = () => {
    if (selectedIndex == null || !filtered[selectedIndex]) {
      setStatus("Selectionnez une ligne");
      return;
    }
    printRenderedRef.current = new Set();
    setPrintRenderCount(0);
    setPrintQueue([filtered[selectedIndex]]);
  };

  const handlePrintAll = () => {
    if (!filtered.length) {
      setStatus("Aucun resultat");
      return;
    }
    printRenderedRef.current = new Set();
    setPrintRenderCount(0);
    setPrintQueue(filtered);
  };

  return (
    <>
      <div className="backdrop" aria-hidden="true" />
      <header className="hero">
        <div className="hero__content">
          <div className="hero__kicker-row">
            <div className="kicker">Etiquettes UI</div>
            <div
              className="printer-status printer-status--hero"
              data-status={printerStatus.status}
            >
              <span className="printer-dot" aria-hidden="true" />
              <span>{printerLabel}</span>
              {printerStatus.name ? (
                <span className="printer-name">{printerStatus.name}</span>
              ) : null}
            </div>
          </div>
          <h1>Recherche rapide, etiquette claire, impression directe.</h1>
          <p>
            Chargez un fichier Excel, recherchez par EAN ou Article, puis
            imprimez.
          </p>
        </div>
        <div className="hero__status">
          <div className="status-text">{status}</div>
        </div>
      </header>

      <main className="layout">
        <section className="panel">
          <div className="card">
            <div className="card__header">
              <h2>1. Charger le fichier</h2>
              <span className="pill">{fileName || "Aucun fichier"}</span>
            </div>
            <div className="file-row">
              <input
                type="file"
                accept=".xlsx"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    handleFile(file);
                  }
                }}
              />
              <button
                type="button"
                className="ghost"
                onClick={() => setOdooModalOpen(true)}
              >
                Se connecter a Odoo
              </button>
            </div>
            {sheetOptions.length > 1 ? (
              <div className="sheet-row">
                <label htmlFor="sheet-select">Feuille</label>
                <select
                  id="sheet-select"
                  value={selectedSheet}
                  onChange={(event) => handleSheetChange(event.target.value)}
                >
                  {sheetOptions.map((sheet) => (
                    <option key={sheet.name} value={sheet.name}>
                      {sheet.name} ({sheet.count})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="odoo-status">
              <span className="odoo-label">Odoo</span>
              <span className={`pill ${odooConnected ? "pill--ok" : "pill--ghost"}`}>
                {odooConnected ? "Connecte" : "Non connecte"}
              </span>
            </div>
            <p className="hint">
              Colonnes attendues: R (Article), T (EAN), AM (Prix Club), AN (Prix
              Public).
            </p>
          </div>

          <div className="card">
            <div className="card__header">
              <h2>2. Recherche</h2>
              <span className="pill pill--ghost">EAN ou Article</span>
            </div>
            <div className="search-row">
              <label className="sr-only" htmlFor="source-select">
                Source
              </label>
              <select
                id="source-select"
                value={dataSource}
                onChange={(event) =>
                  setDataSource(event.target.value as "excel" | "odoo")
                }
              >
                <option value="excel" disabled={!records.length}>
                  Excel
                </option>
                <option value="odoo" disabled={!odooConnected}>
                  Odoo
                </option>
              </select>
              <label className="sr-only" htmlFor="search-type">
                Type
              </label>
              <select
                id="search-type"
                value={searchType}
                onChange={(event) =>
                  setSearchType(event.target.value as "EAN" | "Article")
                }
              >
                <option value="EAN">EAN</option>
                <option value="Article">Article</option>
              </select>
              <input
                id="search-input"
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    runSearch();
                  }
                }}
                placeholder="3393456827961, CFIFQ7#ROC01"
              />
              <button type="button" onClick={runSearch}>
                Chercher
              </button>
              <button type="button" className="ghost" onClick={clearSearch}>
                Effacer
              </button>
            </div>
            <p className="hint">
              Plusieurs valeurs possibles, separees par une virgule.
            </p>
          </div>

          <div className="card">
            <div className="card__header">
              <h2>3. Resultats</h2>
              <span className="pill">{filtered.length}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Article</th>
                    <th>EAN</th>
                    <th>Prix Club</th>
                    <th>Prix Public</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((record, index) => (
                    <tr
                      key={`${record.row}-${record.ean}-${index}`}
                      className={index === selectedIndex ? "selected" : ""}
                      onClick={() => setSelectedIndex(index)}
                    >
                      <td>{record.article || "-"}</td>
                      <td>{record.ean || "-"}</td>
                      <td className="price">{formatPrice(record.prixClub)}</td>
                      <td>{formatPrice(record.prixPublic)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card actions">
            <button type="button" onClick={handlePrintSelected}>
              Imprimer selection
            </button>
            <button type="button" className="ghost" onClick={handlePrintAll}>
              Imprimer tout
            </button>
          </div>
        </section>

        <section className="preview">
          <div className="card card--full">
            <div className="card__header">
              <h2>Preview etiquette</h2>
              <span className="pill pill--ghost">Centree sans intitules</span>
            </div>
            <div className="size-row">
              <div className="field">
                <label htmlFor="label-width">Largeur (mm)</label>
                <input
                  id="label-width"
                  type="number"
                  min="10"
                  step="1"
                  value={labelWidth}
                  onChange={(event) =>
                    Number.isFinite(Number(event.target.value)) &&
                    Number(event.target.value) > 0 &&
                    setLabelWidth(Number(event.target.value))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="label-height">Hauteur (mm)</label>
                <input
                  id="label-height"
                  type="number"
                  min="10"
                  step="1"
                  value={labelHeight}
                  onChange={(event) =>
                    Number.isFinite(Number(event.target.value)) &&
                    Number(event.target.value) > 0 &&
                    setLabelHeight(Number(event.target.value))
                  }
                />
              </div>
              <div className="field field--range">
                <label htmlFor="preview-scale">Zoom preview</label>
                <input
                  id="preview-scale"
                  type="range"
                  min="1"
                  max="6"
                  step="1"
                  value={previewScale}
                  onChange={(event) =>
                    setPreviewScale(Number(event.target.value))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="print-offset-x">Decalage X (mm)</label>
                <input
                  id="print-offset-x"
                  type="number"
                  step="0.1"
                  value={printOffsetX}
                  onChange={(event) =>
                    Number.isFinite(Number(event.target.value)) &&
                    setPrintOffsetX(Number(event.target.value))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="print-offset-y">Decalage Y (mm)</label>
                <input
                  id="print-offset-y"
                  type="number"
                  step="0.1"
                  value={printOffsetY}
                  onChange={(event) =>
                    Number.isFinite(Number(event.target.value)) &&
                    setPrintOffsetY(Number(event.target.value))
                  }
                />
              </div>
            </div>

            <div className="preview-frame">
              <div className="label" style={previewStyle}>
                <div className="label__article">
                  {selectedRecord?.article || "-"}
                </div>
                <div className="label__price">
                  {selectedRecord ? formatPrice(selectedRecord.prixClub) : "-"}
                </div>
                <div className="label__public">
                  {selectedRecord ? formatPrice(selectedRecord.prixPublic) : "-"}
                </div>
                <Barcode
                  value={selectedRecord?.ean || ""}
                  heightPx={previewBarcode.heightPx}
                  widthPx={previewBarcode.widthPx}
                  fontSize={previewBarcode.fontSize}
                  displayValue={previewBarcode.displayValue}
                />
              </div>
            </div>

            <div className="note">
              Astuce: cliquez sur une ligne de resultat pour mettre a jour la
              preview.
            </div>
          </div>
        </section>
      </main>

      <div id="print-area" aria-hidden={!printQueue.length}>
        {printQueue.map((record) => {
          const key = `${record.row}-${record.ean}`;
          return (
            <div
              key={key}
              className="print-page"
              style={{ width: `${labelWidth}mm`, height: `${labelHeight}mm` }}
            >
              <div
                className="label print-label"
                style={{
                  width: `${labelWidth}mm`,
                  height: `${labelHeight}mm`,
                  transform: `translate(${printOffsetX}mm, ${printOffsetY}mm)`,
                }}
              >
                <div className="label__article">{record.article || "-"}</div>
                <div className="label__price">{formatPrice(record.prixClub)}</div>
                <div className="label__public">
                  {formatPrice(record.prixPublic)}
                </div>
                <Barcode
                  value={record.ean || ""}
                  heightPx={printBarcode.heightPx}
                  widthPx={printBarcode.widthPx}
                  fontSize={printBarcode.fontSize}
                  displayValue={printBarcode.displayValue}
                  onRendered={() => {
                    if (!printRenderedRef.current.has(key)) {
                      printRenderedRef.current.add(key);
                      setPrintRenderCount((prev) => prev + 1);
                    }
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {odooModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setOdooModalOpen(false)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Connexion Odoo"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal__header">
              <h3>Connexion Odoo</h3>
              <button
                type="button"
                className="ghost"
                onClick={() => setOdooModalOpen(false)}
              >
                Fermer
              </button>
            </div>
            <div className="modal__body">
              <div className="field">
                <label htmlFor="odoo-url">URL Odoo</label>
                <input
                  id="odoo-url"
                  type="text"
                  value={odooConfig.baseUrl}
                  onChange={(event) =>
                    setOdooConfig((prev) => ({
                      ...prev,
                      baseUrl: event.target.value,
                    }))
                  }
                  placeholder="https://odoo.mondomaine.com"
                />
              </div>
              <div className="field">
                <label htmlFor="odoo-db">Base de donnees</label>
                <input
                  id="odoo-db"
                  type="text"
                  value={odooConfig.db}
                  onChange={(event) =>
                    setOdooConfig((prev) => ({
                      ...prev,
                      db: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="odoo-user">Utilisateur</label>
                <input
                  id="odoo-user"
                  type="text"
                  value={odooConfig.username}
                  onChange={(event) =>
                    setOdooConfig((prev) => ({
                      ...prev,
                      username: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="odoo-pass">Mot de passe</label>
                <input
                  id="odoo-pass"
                  type="password"
                  value={odooConfig.password}
                  onChange={(event) =>
                    setOdooConfig((prev) => ({
                      ...prev,
                      password: event.target.value,
                    }))
                  }
                />
              </div>
              {odooError ? <div className="modal__error">{odooError}</div> : null}
            </div>
            <div className="modal__actions">
              <button type="button" className="ghost" onClick={testOdoo}>
                Tester
              </button>
              <button type="button" onClick={connectOdoo} disabled={odooLoading}>
                {odooLoading ? "Connexion..." : "Connecter"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <style>{`@page { size: ${labelWidth}mm ${labelHeight}mm; margin: 0; }
@media print { html, body { width: ${labelWidth}mm; height: ${labelHeight}mm; margin: 0; } }`}</style>
    </>
  );
}
