"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type RecordItem = {
  row: number;
  article: string;
  name?: string;
  ean: string;
  prixClub: unknown;
  prixPublic: unknown;
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

const PX_PER_MM = 3.78;
const ODOO_SESSION_KEY = "odooSession";
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
      return String(Math.trunc(value));
    }
    return String(value);
  }
  const text = String(value).trim();
  return text || "-";
}

function formatPriceWithSeparator(value: unknown) {
  const price = formatPrice(value);
  if (price === "-") {
    return price;
  }
  // Ajouter des séparateurs d'espace tous les 3 chiffres de droite à gauche
  return price.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function barcodeOptions(
  heightMm: number,
  scale: number,
  displayValue: boolean,
) {
  const ratio = displayValue ? 0.40 : 0.35;
  const heightPx = Math.max(
    8,
    Math.round(heightMm * PX_PER_MM * ratio * scale),
  );
  const moduleMm = 0.30;
  const widthPx = Math.max(
    1,
    Math.round(moduleMm * PX_PER_MM * scale),
  );
  const fontSize = Math.max(10, Math.round(9 * scale));
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
  const [filtered, setFiltered] = useState<RecordItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [status, setStatus] = useState("Connectez-vous a Odoo");
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
  const [odooConnected, setOdooConnected] = useState(false);
  const [odooLoading, setOdooLoading] = useState(false);
  const [odooError, setOdooError] = useState("");
  const [odooConfig, setOdooConfig] = useState<OdooConfig>({
    baseUrl: "",
    db: "",
    username: "",
    password: "",
  });
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
    if (typeof window === "undefined") {
      return;
    }
    const saved = window.sessionStorage.getItem(ODOO_SESSION_KEY);
    if (!saved) {
      return;
    }
    try {
      const parsed = JSON.parse(saved) as OdooConfig;
      setOdooConfig(parsed);
      connectWithConfig(parsed, true);
    } catch {
      window.sessionStorage.removeItem(ODOO_SESSION_KEY);
    }
  }, []);

  const clearSearch = () => {
    setSearchInput("");
    setFiltered([]);
    setSelectedIndex(null);
    setStatus("Recherche effacee");
  };

  const connectWithConfig = async (config: OdooConfig, silent = false) => {
    setOdooLoading(true);
    setOdooError("");
    try {
      if (!silent) {
        setStatus("Connexion Odoo...");
      }
      const response = await fetch("/api/odoo/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
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
      setStatus("Connexion Odoo reussie");
      setOdooConfig(config);
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(ODOO_SESSION_KEY, JSON.stringify(config));
      }
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

  const testOdoo = async () => connectWithConfig(odooConfig, false);
  const connectOdoo = async () => connectWithConfig(odooConfig, false);

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

  const buildPrintHtml = async (selection: RecordItem[]) => {
    const mod = await import("jsbarcode");
    const JsBarcode =
      (mod as unknown as { default?: JsBarcodeFn }).default ??
      (mod as unknown as JsBarcodeFn);
    const cache = new Map<string, string>();
    const barcodeDataUrl = (value: string) => {
      const normalized = toEan13(value);
      if (!normalized) {
        return "";
      }
      const cached = cache.get(normalized);
      if (cached) {
        return cached;
      }
      const canvas = document.createElement("canvas");
      try {
        JsBarcode(canvas, normalized, {
          format: "EAN13",
          height: printBarcode.heightPx,
          width: printBarcode.widthPx,
          displayValue: false,
          margin: 0,
        });
      } catch {
        return "";
      }
      const url = canvas.toDataURL("image/png");
      cache.set(normalized, url);
      return url;
    };

    const pages = selection
      .map((record) => {
        const article = escapeHtml(record.name || record.article || "-");
        const prixClub = escapeHtml(formatPriceWithSeparator(record.prixClub));
        const prixPublic = escapeHtml(formatPriceWithSeparator(record.prixPublic));
        const barcode = barcodeDataUrl(record.ean || "");
        const barcodeHtml = barcode
          ? `<img class="barcode" src="${barcode}" alt="Code-barres ${escapeHtml(
              record.ean || "",
            )}" />`
          : `<div class="barcode empty"></div>`;
        return `
<div class="print-page">
  <div class="label" style="transform: translate(${printOffsetX}mm, ${printOffsetY}mm);">
    <div class="label__article">${article}</div>
    <div class="label__price">${prixClub}</div>
    <div class="label__public">${prixPublic}</div>
    ${barcodeHtml}
  </div>
</div>`;
      })
      .join("");

    return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>Etiquettes</title>
    <style>
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      html, body { margin: 0; padding: 0; width: ${labelWidth}mm; height: ${labelHeight}mm; }
      @page { size: ${labelWidth}mm ${labelHeight}mm; margin: 0 !important; }
      .print-page { width: ${labelWidth}mm; height: ${labelHeight}mm; page-break-after: always; break-after: page; position: relative; overflow: hidden; }
      .label { width: ${labelWidth}mm; height: ${labelHeight}mm; position: absolute; top: 0; left: 0; transform-origin: top left; border: none; border-radius: 0; padding: 3px; display: flex; flex-direction: column; align-items: center; justify-content: space-between; text-align: center; font-family: Arial, sans-serif; }
      .label__article { font-weight: 700; font-size: 20px; letter-spacing: 0.08em; text-transform: uppercase; flex-shrink: 0; }
      .label__price { font-weight: 700; font-size: 18px; color: #d62828; flex-shrink: 0; line-height: 1.1; }
      .label__public { font-size: 16px; font-weight: 600; flex-shrink: 0; }
      .barcode { width: 100%; height: auto; display: block; }
      .barcode.empty { height: 24px; }
    </style>
  </head>
  <body>
    ${pages}
  </body>
</html>`;
  };

  const printLabels = async (selection: RecordItem[]) => {
    if (!selection.length) {
      setStatus("Aucun resultat");
      return;
    }
    setStatus(`Preparation impression (${selection.length})...`);
    try {
      const html = await buildPrintHtml(selection);
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        setStatus("Popup bloque");
        return;
      }
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      const triggerPrint = () => {
        printWindow.focus();
        printWindow.print();
        printWindow.onafterprint = () => printWindow.close();
      };
      if (printWindow.document.readyState === "complete") {
        window.setTimeout(triggerPrint, 200);
      } else {
        printWindow.onload = () => window.setTimeout(triggerPrint, 200);
      }
      setStatus(`Impression (${selection.length})...`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erreur impression";
      setStatus(message);
    }
  };

  const disconnectOdoo = () => {
    setOdooConnected(false);
    setFiltered([]);
    setSelectedIndex(null);
    setStatus("Deconnecte");
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(ODOO_SESSION_KEY);
    }
  };

  const handlePrintSelected = () => {
    if (selectedIndex == null || !filtered[selectedIndex]) {
      setStatus("Selectionnez une ligne");
      return;
    }
    printLabels([filtered[selectedIndex]]);
  };

  const handlePrintAll = () => {
    printLabels(filtered);
  };

  const downloadLabels = async () => {
    const selection =
      selectedIndex != null && filtered[selectedIndex]
        ? [filtered[selectedIndex]]
        : filtered;
    if (!selection.length) {
      setStatus("Aucun resultat");
      return;
    }
    setStatus(`Generation etiquettes (${selection.length})...`);
    try {
      const html = await buildPrintHtml(selection);
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `etiquettes_${Date.now()}.html`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus(`Etiquettes telechargees (${selection.length})`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erreur telechargement";
      setStatus(message);
    }
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
            Connectez-vous a Odoo, recherchez par EAN ou Article, puis imprimez.
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
              <h2>1. Connexion Odoo (prioritaire)</h2>
              <span className={`pill ${odooConnected ? "pill--ok" : "pill--ghost"}`}>
                {odooConnected ? "Connecte" : "Non connecte"}
              </span>
            </div>
            <div className="file-row">
              <input
                type="text"
                placeholder="URL Odoo"
                value={odooConfig.baseUrl}
                onChange={(e) =>
                  setOdooConfig((prev) => ({ ...prev, baseUrl: e.target.value }))
                }
              />
              <input
                type="text"
                placeholder="Base de donnees"
                value={odooConfig.db}
                onChange={(e) =>
                  setOdooConfig((prev) => ({ ...prev, db: e.target.value }))
                }
              />
              <input
                type="text"
                placeholder="Utilisateur"
                value={odooConfig.username}
                onChange={(e) =>
                  setOdooConfig((prev) => ({ ...prev, username: e.target.value }))
                }
              />
              <input
                type="password"
                placeholder="Mot de passe"
                value={odooConfig.password}
                onChange={(e) =>
                  setOdooConfig((prev) => ({ ...prev, password: e.target.value }))
                }
              />
            </div>
            <div className="actions">
              <button type="button" onClick={connectOdoo} disabled={odooLoading}>
                {odooLoading ? "Connexion..." : "Connecter"}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={disconnectOdoo}
              >
                Deconnecter
              </button>
              <button type="button" className="ghost" onClick={testOdoo}>
                Tester
              </button>
            </div>
            {odooError ? <p className="hint">{odooError}</p> : null}
          </div>

          <div className="card">
            <div className="card__header">
              <h2>2. Recherche (Odoo)</h2>
              <span className="pill pill--ghost">EAN ou Article</span>
            </div>
            <div className="search-row">
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
                    searchOdoo();
                  }
                }}
                placeholder="3393456827961, CFIFQ7#ROC01"
              />
              <button type="button" onClick={searchOdoo}>
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
                    <th>Nom</th>
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
                      <td>{record.name || "-"}</td>
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
            <button type="button" className="ghost" onClick={downloadLabels}>
              Telecharger etiquettes
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
                  {selectedRecord?.name || selectedRecord?.article || "-"}
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

      <div id="print-area" aria-hidden={filtered.length === 0}>
        {filtered.map((record) => {
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
                <div className="label__article">{record.name || record.article || "-"}</div>
                <div className="label__price">{formatPriceWithSeparator(record.prixClub)}</div>
                <div className="label__public">
                  {formatPriceWithSeparator(record.prixPublic)}
                </div>
                <Barcode
                  value={record.ean || ""}
                  heightPx={printBarcode.heightPx}
                  widthPx={printBarcode.widthPx}
                  fontSize={printBarcode.fontSize}
                  displayValue={printBarcode.displayValue}
                />
              </div>
            </div>
          );
        })}
      </div>

      <style>{`@page { size: ${labelWidth}mm ${labelHeight}mm; margin: 0; }
@media print { html, body { width: ${labelWidth}mm; height: ${labelHeight}mm; margin: 0; } }`}</style>
    </>
  );
}
