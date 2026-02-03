"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { LoadingIndicator } from "@/components/application/loading-indicator/loading-indicator";
import { printClubLabel } from "@/lib/club-card/print";
import type { ClubCard, ClubSuggestion, ColumnDef, ColumnStat } from "@/lib/club-card/types";
import { ODOO_SESSION_KEY, DEFAULT_ODOO_CONFIG, CLUB_PAGE_SIZE } from "@/lib/odoo/constants";
import type { OdooConfig } from "@/lib/odoo/types";
import type { PrinterStatus } from "@/lib/printer/types";
import {
  normalizeText,
  formatPrice,
  formatPriceWithSeparator,
  formatDate,
  formatStatus,
  escapeHtml,
  splitInput,
  readJsonResponse,
} from "@/lib/utils/format";

type RecordItem = {
  row: number;
  article: string;
  name?: string;
  ean: string;
  prixClub: unknown;
  prixPublic: unknown;
};

type LocalMeta = {
  source?: string;
  sheet?: string;
  defaultFile?: string;
};

const DEFAULT_ODOO_CONFIG_STATE: OdooConfig = {
  ...DEFAULT_ODOO_CONFIG,
};

const COLUMN_VISIBILITY_THRESHOLD = 0.05; // 5% de valeurs non vides minimum

function extractDigits(value: unknown) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
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
  if (!digits) return null;
  if (digits.length === 12) return `${digits}${computeEan13CheckDigit(digits)}`;
  if (digits.length === 13) return digits;
  return null;
}

function computeColumnStats(cards: ClubCard[], columns: ColumnDef[]): ColumnStat[] {
  const total = cards.length || 1;
  return columns.map((col) => {
    const nonEmpty = cards.reduce((count, card) => {
      const value = col.accessor(card);
      const normalized = normalizeText(value);
      return normalized ? count + 1 : count;
    }, 0);
    return { key: col.key, nonEmpty, ratio: nonEmpty / total };
  });
}

function isColumnVisible(col: ColumnDef, stats: ColumnStat[], cards: ClubCard[]) {
  if (col.mandatory) return true;
  const stat = stats.find((s) => s.key === col.key);
  if (!stat) return false;
  // si aucune donnÃ©e mais pas de cards, on garde au moins code/client
  if (!cards.length && (col.key === "code" || col.key === "client")) return true;
  return stat.ratio >= COLUMN_VISIBILITY_THRESHOLD;
}

const LineSpinnerDemo = () => {
  return <LoadingIndicator type="line-spinner" size="md" />;
};

export default function Home() {
  const [filtered, setFiltered] = useState<RecordItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [status, setStatus] = useState("Connexion Odoo en cours...");
  const [printerStatus, setPrinterStatus] = useState<PrinterStatus>({
    available: false,
    status: "unknown",
  });
  const [searchType, setSearchType] = useState<"EAN" | "Article" | "Nom">(
    "EAN",
  );
  const [dataSource, setDataSource] = useState<"odoo" | "excel">("odoo");
  const [searchInput, setSearchInput] = useState("");
  const [localRecords, setLocalRecords] = useState<RecordItem[]>([]);
  const [localMeta, setLocalMeta] = useState<LocalMeta | null>(null);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [localLoading, setLocalLoading] = useState(false);
  const [labelWidth, setLabelWidth] = useState(50);
  const [labelHeight, setLabelHeight] = useState(25);
  const [printOffsetX, setPrintOffsetX] = useState(0);
  const [printOffsetY, setPrintOffsetY] = useState(0);
  const [odooConnected, setOdooConnected] = useState(false);
  const [odooLoading, setOdooLoading] = useState(false);
  const [odooConfig, setOdooConfig] = useState<OdooConfig>({
    ...DEFAULT_ODOO_CONFIG_STATE,
  });
  const [clubCards, setClubCards] = useState<ClubCard[]>([]);
  const [clubLoading, setClubLoading] = useState(false);
  const [clubStatus, setClubStatus] = useState("Club Card non chargee");
  const [clubFilter, setClubFilter] = useState("");
  const [clubTotal, setClubTotal] = useState<number | null>(null);
  const [clubModuleInfo, setClubModuleInfo] = useState<unknown[]>([]);
  const [clubOffset, setClubOffset] = useState(0);
  const [clubHasMore, setClubHasMore] = useState(false);
  const [clubSuggestions, setClubSuggestions] = useState<ClubSuggestion[]>([]);

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

  const clubColumns = useMemo<ColumnDef[]>(
    () => [
      { key: "code", label: "Code", accessor: (c) => c.code, mandatory: true },
      { key: "client", label: "Client", accessor: (c) => c.client, mandatory: true },
      { key: "email", label: "Email", accessor: (c) => c.email },
      { key: "telephone", label: "Telephone", accessor: (c) => c.telephone },
      { key: "points", label: "Points/Solde", accessor: (c) => c.points ?? c.balance },
      { key: "statut", label: "Statut", accessor: (c) => c.statut, format: formatStatus },
      { key: "date_fin", label: "Date fin", accessor: (c) => c.date_fin, format: formatDate },
    ],
    [],
  );

  const orderedClubCards = useMemo(() => {
    const list = [...clubCards];
    list.sort((a, b) =>
      (a.client || "").localeCompare(b.client || "", "fr", { sensitivity: "base" }),
    );
    return list;
  }, [clubCards]);

  const filteredClubCards = orderedClubCards;

  const clubStats = useMemo(
    () => computeColumnStats(filteredClubCards, clubColumns),
    [filteredClubCards, clubColumns],
  );

  const visibleColumns = useMemo(
    () =>
      clubColumns.filter((col) => isColumnVisible(col, clubStats, filteredClubCards)),
    [clubColumns, clubStats, filteredClubCards],
  );

  const hiddenColumns = clubColumns.length - visibleColumns.length;
  const partialData = filteredClubCards.length > 0 && hiddenColumns > 0;

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
    let config = DEFAULT_ODOO_CONFIG_STATE;
    if (saved) {
      try {
        config = JSON.parse(saved) as OdooConfig;
      } catch {
        window.sessionStorage.removeItem(ODOO_SESSION_KEY);
      }
    }
    setOdooConfig(config);
    connectWithConfig(config, true);
  }, []);

  const clearSearch = () => {
    setSearchInput("");
    setFiltered([]);
    setSelectedIndex(null);
    setStatus("Recherche effacee");
  };

  const loadLocalRecords = async () => {
    if (localLoading) return null;
    setLocalLoading(true);
    try {
      const response = await fetch("/api/local-db/records", {
        cache: "no-store",
      });
      const data = (await readJsonResponse(response)) as {
        records?: Array<{
          article?: unknown;
          name?: unknown;
          ean?: unknown;
          prixClub?: unknown;
          prixPublic?: unknown;
        }>;
        meta?: LocalMeta;
        message?: string;
      };
      if (!response.ok) {
        const message =
          typeof data.message === "string" ? data.message : "Erreur base locale";
        throw new Error(message);
      }
      const rows = Array.isArray(data.records) ? data.records : [];
      const mapped = rows.map((record, index) => ({
        row: index + 1,
        article: normalizeText(record.article),
        name: normalizeText(record.name),
        ean: normalizeText(record.ean),
        prixClub: record.prixClub,
        prixPublic: record.prixPublic,
      }));
      setLocalRecords(mapped);
      setLocalMeta(
        data.meta && typeof data.meta === "object" ? data.meta : null,
      );
      setLocalLoaded(true);
      return mapped;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erreur base locale";
      setStatus(message);
      setLocalRecords([]);
      setLocalMeta(null);
      setLocalLoaded(false);
      return null;
    } finally {
      setLocalLoading(false);
    }
  };

  const filterLocalRecords = (records: RecordItem[], parts: string[]) => {
    if (!parts.length) return [];

    if (searchType === "EAN") {
      const normalizedTerms = parts
        .map((term) => toEan13(term))
        .filter((term): term is string => Boolean(term));
      if (!normalizedTerms.length) return [];
      const termSet = new Set(normalizedTerms);
      return records.filter((record) => {
        const ean = toEan13(record.ean) || "";
        return termSet.has(ean);
      });
    }

    const normalizedTerms = parts
      .map((term) => normalizeText(term).toLowerCase())
      .filter(Boolean);
    if (!normalizedTerms.length) return [];

    if (searchType === "Nom") {
      return records.filter((record) => {
        const name = normalizeText(record.name).toLowerCase();
        const article = normalizeText(record.article).toLowerCase();
        return normalizedTerms.some(
          (term) => name.includes(term) || article.includes(term),
        );
      });
    }

    const termSet = new Set(normalizedTerms);
    return records.filter((record) => {
      const article = normalizeText(record.article).toLowerCase();
      return termSet.has(article);
    });
  };

  const searchLocal = async () => {
    const parts = splitInput(searchInput);
    if (!parts.length) {
      setStatus("Entrez une valeur de recherche");
      return;
    }
    setStatus("Recherche Excel...");

    let records = localRecords;
    if (!localLoaded) {
      const loaded = await loadLocalRecords();
      if (!loaded) {
        setFiltered([]);
        setSelectedIndex(null);
        return;
      }
      records = loaded;
    }

    if (!records.length) {
      setFiltered([]);
      setSelectedIndex(null);
      setStatus("Base locale vide");
      return;
    }

    const results = filterLocalRecords(records, parts);
    setFiltered(results);
    setSelectedIndex(results.length ? 0 : null);
    setStatus(results.length ? `Resultats: ${results.length}` : "Aucun resultat");
  };

  const connectWithConfig = async (config: OdooConfig, silent = false) => {
    setOdooLoading(true);
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
    } catch {
      setOdooConnected(false);
      setStatus("Connexion Odoo echouee");
      return false;
    } finally {
      setOdooLoading(false);
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
      setStatus(
        results.length ? `Resultats: ${results.length}` : "Aucun resultat",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur Odoo";
      setStatus(message);
      setFiltered([]);
      setSelectedIndex(null);
    } finally {
      setOdooLoading(false);
    }
  };

  const handleSearch = () => {
    if (dataSource === "excel") {
      void searchLocal();
      return;
    }
    void searchOdoo();
  };

  const handleSourceChange = (value: "odoo" | "excel") => {
    setDataSource(value);
    setFiltered([]);
    setSelectedIndex(null);
    if (value === "excel") {
      setStatus("Mode Excel actif");
    } else {
      setStatus(odooConnected ? "Mode Odoo actif" : "Odoo non connecte");
    }
    if (value === "excel" && !localLoaded && !localLoading) {
      void loadLocalRecords();
    }
  };

  const fetchClubCards = async (options: {
    append?: boolean;
    offsetOverride?: number;
    queryOverride?: string;
  } = {}) => {
    if (!odooConnected) {
      setClubStatus("Odoo non connecte");
      return;
    }

    const append = options.append ?? false;
    const query = (options.queryOverride ?? clubFilter).trim();
    const nextOffset =
      options.offsetOverride ?? (append ? clubOffset + CLUB_PAGE_SIZE : 0);

    setClubLoading(true);
    setClubStatus(
      append
        ? "Chargement de clients supplementaires..."
        : "Chargement des clients Club Card...",
    );

    try {
      const response = await fetch("/api/odoo/club-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: odooConfig.baseUrl,
          db: odooConfig.db,
          username: odooConfig.username,
          password: odooConfig.password,
          limit: CLUB_PAGE_SIZE,
          offset: nextOffset,
          q: query || undefined,
        }),
      });

      const data = await readJsonResponse(response);
      if (!response.ok) {
        const message =
          typeof data.message === "string" ? data.message : "Erreur Club Card";
        throw new Error(message);
      }

      const cards = Array.isArray((data as { cards?: unknown[] }).cards)
        ? ((data as { cards?: unknown[] }).cards as ClubCard[])
        : [];

      const total =
        typeof (data as { total?: unknown }).total === "number"
          ? (data as { total?: number }).total
          : cards.length;

      const moduleInfo =
        Array.isArray((data as { moduleInfo?: unknown }).moduleInfo) &&
        (data as { moduleInfo?: unknown[] }).moduleInfo
          ? ((data as { moduleInfo?: unknown[] }).moduleInfo as unknown[])
          : [];

      const suggestions = Array.isArray(
        (data as { suggestions?: unknown[] }).suggestions,
      )
        ? ((data as { suggestions?: unknown[] }).suggestions as ClubSuggestion[])
        : [];

      const hasMore =
        (data as { has_more?: unknown }).has_more === true ||
        (typeof total === "number" && total > nextOffset + cards.length);

      const nextCount = append ? clubCards.length + cards.length : cards.length;

      setClubModuleInfo(moduleInfo);
      setClubTotal(total);
      setClubOffset(nextOffset);
      setClubHasMore(Boolean(hasMore));
      setClubCards((prev) => (append ? [...prev, ...cards] : cards));
      setClubSuggestions(suggestions);
      setClubStatus(
        nextCount
          ? `Clients chargés: ${nextCount}/${total ?? nextCount}`
          : "Aucun client trouve",
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erreur Club Card";
      setClubStatus(message);
      setClubCards([]);
      setClubTotal(null);
      setClubModuleInfo([]);
      setClubHasMore(false);
      setClubOffset(0);
      setClubSuggestions([]);
    } finally {
      setClubLoading(false);
    }
  };

  const loadClubCards = async () => {
    setClubOffset(0);
    await fetchClubCards({ append: false, offsetOverride: 0 });
  };

  const loadNextClubPage = async () => {
    if (clubLoading || !clubHasMore) return;
    await fetchClubCards({
      append: true,
      offsetOverride: clubOffset + CLUB_PAGE_SIZE,
    });
  };

  useEffect(() => {
    if (!odooConnected) return;
    const timer = window.setTimeout(() => {
      fetchClubCards({ append: false, offsetOverride: 0 });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [clubFilter, odooConnected]);

  const buildPrintHtml = async (selection: RecordItem[]) => {
    const pages = selection
      .map((record) => {
        const article = escapeHtml(record.article || "-");
        const prixClub = escapeHtml(formatPriceWithSeparator(record.prixClub));
        const prixPublic = escapeHtml(
          formatPriceWithSeparator(record.prixPublic),
        );
        return `
<div class="print-page">
  <div class="label" style="transform: translate(${printOffsetX}mm, ${printOffsetY}mm);">
    <div class="label__article">${article}</div>
    <div class="label__price">Prix Club: ${prixClub}</div>
    <div class="label__public">Prix Public: ${prixPublic}</div>
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
      .label { width: ${labelWidth}mm; height: ${labelHeight}mm; position: absolute; top: 0; left: 0; transform-origin: top left; border: none; border-radius: 0; padding: 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center; font-family: Arial, sans-serif; }
      .label__article { font-weight: 700; font-size: 18px; letter-spacing: 0.08em; text-transform: uppercase; }
      .label__price { font-weight: 700; font-size: 14px; color: #d62828; line-height: 1.1; }
      .label__public { font-size: 14px; font-weight: 700; line-height: 1.1; }
    </style>
  </head>
  <body>
    ${pages}
      </body>
</html>`;
  };

  // impression deleguÃ©e Ã  lib/club-card/print

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
            <div className="kicker">Etiquettes plus</div>
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
            Recherchez par code barres, Article ou Nom, puis imprimez.
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
              <h2>Recherche</h2>
              <span className="pill pill--ghost">EAN, Article ou Nom</span>
            </div>
            <div className="search-row">
              <label className="sr-only" htmlFor="data-source">
                Source
              </label>
              <select
                id="data-source"
                value={dataSource}
                onChange={(event) =>
                  handleSourceChange(event.target.value as "odoo" | "excel")
                }
              >
                <option value="odoo">Odoo</option>
                <option value="excel">Excel (ORCHESTRA_MARGE.xlsx)</option>
              </select>
              <label className="sr-only" htmlFor="search-type">
                Type
              </label>
              <select
                id="search-type"
                value={searchType}
                onChange={(event) =>
                  setSearchType(event.target.value as "EAN" | "Article" | "Nom")
                }
              >
                <option value="EAN">Code barres</option>
                <option value="Article">Reference</option>
                <option value="Nom">Nom d&apos;article</option>
              </select>
              <input
                id="search-input"
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleSearch();
                  }
                }}
                placeholder="3393456827961, CFIFQ7#ROC01"
              />
              <button type="button" onClick={handleSearch}>
                Chercher
              </button>
              <button type="button" className="ghost" onClick={clearSearch}>
                Effacer
              </button>
            </div>
            {dataSource === "excel" ? (
              <div className="sheet-row">
                <span className="sheet-label">
                  Source: {localMeta?.source || "ORCHESTRA_MARGE.xlsx"}
                </span>
                {localMeta?.sheet ? (
                  <span className="sheet-label">Feuille: {localMeta.sheet}</span>
                ) : null}
                {localLoaded ? (
                  <span className="sheet-label">
                    {localRecords.length} lignes
                  </span>
                ) : null}
              </div>
            ) : null}
            <p className="hint">
              Plusieurs valeurs possibles, separees par une virgule.
            </p>
          </div>

          <div className="card">
            <div className="card__header">
              <h2>Resultats</h2>
              <div className="card__header-right">
                {odooLoading || localLoading ? <LineSpinnerDemo /> : null}
                <span className="pill pill--ghost">
                  {dataSource === "odoo" ? "Odoo" : "Excel"}
                </span>
                <span className="pill">{filtered.length}</span>
              </div>
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

          <div className="card">
            <div className="card__header">
              <h2>Format etiquette</h2>
              <span className="pill pill--ghost">Impression</span>
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
            <p className="hint">
              Ces valeurs sont utilisees pour l&apos;impression et le telechargement.
            </p>
          </div>
        </section>

        <section className="preview">
          <div className="card card--full">
            <div className="card__header">
              <h2>Clients Club Card</h2>
              <div className="card__header-right">
                {clubLoading ? <LineSpinnerDemo /> : null}
                <span className="pill">
                  {clubTotal ?? filteredClubCards.length}
                </span>
                {partialData ? (
                  <span className="pill pill--warn">Donnees partielles</span>
                ) : null}
              </div>
            </div>

            <div className="club-card__actions">
              <div className="club-card__status">
                <span className="club-status-text">{clubStatus}</span>
                <span className="meta-muted">
                  Affiches {clubCards.length} / {clubTotal ?? clubCards.length}
                </span>
                {clubModuleInfo.length ? (
                  <span className="meta-muted">
                    Modules trouves: {clubModuleInfo.length}
                  </span>
                ) : null}
              </div>
              <div className="search-row">
                <input
                  type="text"
                  placeholder="Recherche Odoo (code, client, email, telephone)"
                  value={clubFilter}
                  onChange={(event) => setClubFilter(event.target.value)}
                />
                <button
                  type="button"
                  onClick={loadClubCards}
                  disabled={!odooConnected || clubLoading}
                >
                  {odooConnected ? "Charger depuis Odoo" : "Connexion requise"}
                </button>
              </div>
            </div>

            <div className="table-wrap club-table">
              <table>
                <thead>
                  <tr>
                    {visibleColumns.map((col) => (
                      <th key={col.key}>{col.label}</th>
                    ))}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClubCards.length === 0 ? (
                    <tr>
                      <td colSpan={(visibleColumns.length || 1) + 1} className="empty-row">
                        Aucun client Club Card
                      </td>
                    </tr>
                  ) : (
                    filteredClubCards.map((card) => (
                      <tr key={`${card.id}-${card.code}`}>
                        {visibleColumns.map((col) => {
                          const raw = col.accessor(card);
                          const formatted = col.format
                            ? col.format(raw)
                            : normalizeText(raw);
                          return <td key={col.key}>{formatted}</td>;
                        })}
                        <td>
                          <button
                            type="button"
                            className="ghost"
                            disabled={!normalizeText(card.barcode || card.code)}
                            title={
                              normalizeText(card.barcode || card.code)
                                ? "Imprimer l'etiquette"
                                : "Code manquant"
                            }
                            onClick={() =>
                              printClubLabel(
                                { code: card.code, barcode: card.barcode, client: card.client },
                                setClubStatus,
                              )
                            }
                          >
                            Imprimer
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              {partialData ? (
                <div className="data-partial">
                  Donnees partielles: {hiddenColumns} colonne(s) masquee(s) faute de donnees.
                </div>
              ) : null}
              <div
                className="club-pagination"
                style={{ display: "flex", gap: "12px", alignItems: "center", marginTop: "12px" }}
              >
                <span className="meta-muted">
                  Affiches {filteredClubCards.length} / {clubTotal ?? filteredClubCards.length}
                </span>
                <button
                  type="button"
                  onClick={loadNextClubPage}
                  disabled={!clubHasMore || clubLoading}
                >
                  {clubHasMore
                    ? clubLoading
                      ? "Chargement..."
                      : `Charger +${CLUB_PAGE_SIZE}`
                    : "Fin de liste"}
                </button>
              </div>
              {filteredClubCards.length === 0 && clubSuggestions.length ? (
                <div className="suggestions">
                  <div className="suggestions__title">Resultats les plus proches</div>
                  <table>
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Client</th>
                        <th>Email</th>
                        <th>Telephone</th>
                        <th>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clubSuggestions.map((sugg) => (
                        <tr key={`sugg-${sugg.id}-${sugg.code}`}>
                          <td>{normalizeText(sugg.code) || "-"}</td>
                          <td>{normalizeText(sugg.client) || "-"}</td>
                          <td>{normalizeText(sugg.email) || "-"}</td>
                          <td>{normalizeText(sugg.telephone) || "-"}</td>
                          <td>{sugg.score != null ? (sugg.score * 100).toFixed(0) + "%" : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </main>

      <div
        id="print-area"
        aria-hidden={filtered.length === 0}
        style={
          {
            "--print-width": `${labelWidth}mm`,
            "--print-height": `${labelHeight}mm`,
          } as CSSProperties
        }
      >
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
                <div className="label__article">{record.article || "-"}</div>
                <div className="label__price">
                  Prix Club: {formatPriceWithSeparator(record.prixClub)}
                </div>
                <div className="label__public">
                  Prix Public: {formatPriceWithSeparator(record.prixPublic)}
                </div>
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




