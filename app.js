"use strict";

const COLUMN_LETTERS = {
  article: "R",
  ean: "T",
  prixClub: "AM",
  prixPublic: "AN",
};

const state = {
  records: [],
  filtered: [],
  eanMap: new Map(),
  articleMap: new Map(),
  selectedIndex: null,
  labelWmm: 50,
  labelHmm: 25,
  scale: 2,
};

const elements = {};

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
    if (Number.isInteger(value)) {
      return String(value);
    }
    return String(value);
  }
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeEAN(value) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  return text.replace(/\s+/g, "");
}

function formatPrice(value) {
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

function splitInput(text) {
  if (!text) {
    return [];
  }
  return text
    .split(/[;,]/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function setStatus(message) {
  elements.status.textContent = message;
}

function setFilePill(name) {
  elements.filePill.textContent = name || "Aucun fichier";
}

function setResultsCount(count) {
  elements.resultsCount.textContent = String(count);
}

function clearResults() {
  state.filtered = [];
  state.selectedIndex = null;
  elements.resultsBody.innerHTML = "";
  setResultsCount(0);
  updatePreview(null);
}

function buildIndex(records) {
  state.eanMap = new Map();
  state.articleMap = new Map();
  records.forEach((record) => {
    if (record.ean) {
      if (!state.eanMap.has(record.ean)) {
        state.eanMap.set(record.ean, []);
      }
      state.eanMap.get(record.ean).push(record);
    }
    if (record.article) {
      if (!state.articleMap.has(record.article)) {
        state.articleMap.set(record.article, []);
      }
      state.articleMap.get(record.article).push(record);
    }
  });
}

async function loadFile(file, nameOverride) {
  if (!window.XLSX) {
    setStatus("Erreur: XLSX non charge");
    return;
  }
  setStatus("Lecture du fichier...");
  try {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    const headerRow = findHeaderRow(rows);

    const colIndex = {
      article: columnLetterToIndex(COLUMN_LETTERS.article),
      ean: columnLetterToIndex(COLUMN_LETTERS.ean),
      prixClub: columnLetterToIndex(COLUMN_LETTERS.prixClub),
      prixPublic: columnLetterToIndex(COLUMN_LETTERS.prixPublic),
    };

    const records = [];
    for (let i = headerRow + 1; i < rows.length; i += 1) {
      const row = rows[i] || [];
      const article = normalizeText(row[colIndex.article]);
      const ean = normalizeEAN(row[colIndex.ean]);
      const prixClub = row[colIndex.prixClub];
      const prixPublic = row[colIndex.prixPublic];

      if (!article && !ean && prixClub == null && prixPublic == null) {
        continue;
      }

      records.push({
        row: i + 1,
        article: article || "",
        ean: ean || "",
        prixClub,
        prixPublic,
      });
    }

    state.records = records;
    buildIndex(records);
    clearResults();
    setFilePill(nameOverride || file.name || "Fichier charge");
    setStatus(`Charge: ${records.length} lignes`);
  } catch (error) {
    setStatus("Erreur de lecture");
    alert(`Impossible de lire le fichier: ${error.message}`);
  }
}

function renderResults(records) {
  elements.resultsBody.innerHTML = "";
  records.forEach((record, index) => {
    const row = document.createElement("tr");
    row.dataset.index = String(index);

    const articleCell = document.createElement("td");
    articleCell.textContent = record.article || "-";
    const eanCell = document.createElement("td");
    eanCell.textContent = record.ean || "-";
    const clubCell = document.createElement("td");
    clubCell.textContent = formatPrice(record.prixClub);
    clubCell.className = "price";
    const publicCell = document.createElement("td");
    publicCell.textContent = formatPrice(record.prixPublic);

    row.append(articleCell, eanCell, clubCell, publicCell);
    elements.resultsBody.appendChild(row);
  });

  setResultsCount(records.length);
}

function runSearch() {
  if (!state.records.length) {
    setStatus("Chargez un fichier d abord");
    return;
  }
  const raw = elements.searchInput.value.trim();
  if (!raw) {
    setStatus("Entrez une valeur de recherche");
    return;
  }
  const parts = splitInput(raw);
  const results = [];
  if (elements.searchType.value === "EAN") {
    parts.forEach((part) => {
      const key = normalizeEAN(part);
      if (key && state.eanMap.has(key)) {
        results.push(...state.eanMap.get(key));
      }
    });
  } else {
    parts.forEach((part) => {
      const key = normalizeText(part);
      if (key && state.articleMap.has(key)) {
        results.push(...state.articleMap.get(key));
      }
    });
  }

  const unique = [];
  const seen = new Set();
  results.forEach((record) => {
    const key = `${record.row}-${record.article}-${record.ean}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(record);
  });

  state.filtered = unique;
  renderResults(unique);

  if (!unique.length) {
    setStatus("Aucun resultat");
    updatePreview(null);
    return;
  }

  setStatus(`Resultats: ${unique.length}`);
  selectIndex(0);
}

function clearSearch() {
  elements.searchInput.value = "";
  clearResults();
  setStatus("Recherche effacee");
}

function selectIndex(index) {
  state.selectedIndex = index;
  const rows = Array.from(elements.resultsBody.querySelectorAll("tr"));
  rows.forEach((row) => row.classList.remove("selected"));
  const row = rows[index];
  if (row) {
    row.classList.add("selected");
  }
  const record = state.filtered[index];
  updatePreview(record || null);
}

function updatePreview(record) {
  if (!record) {
    elements.labelArticle.textContent = "-";
    elements.labelPrice.textContent = "-";
    elements.labelPublic.textContent = "-";
    elements.labelBarcode.innerHTML = "";
    return;
  }
  elements.labelArticle.textContent = record.article || "-";
  elements.labelPrice.textContent = formatPrice(record.prixClub);
  elements.labelPublic.textContent = formatPrice(record.prixPublic);
  renderBarcode(elements.labelBarcode, record.ean, false);
}

function updatePreviewSize() {
  const width = parseFloat(elements.labelWidth.value);
  const height = parseFloat(elements.labelHeight.value);
  const scale = parseFloat(elements.previewScale.value);

  if (Number.isFinite(width) && width > 0) {
    state.labelWmm = width;
  }
  if (Number.isFinite(height) && height > 0) {
    state.labelHmm = height;
  }
  if (Number.isFinite(scale) && scale > 0) {
    state.scale = scale;
  }

  const widthPx = state.labelWmm * 3.78 * state.scale;
  const heightPx = state.labelHmm * 3.78 * state.scale;
  elements.labelPreview.style.width = `${widthPx}px`;
  elements.labelPreview.style.height = `${heightPx}px`;

  updatePrintStyle();
  const record = state.filtered[state.selectedIndex];
  if (record) {
    renderBarcode(elements.labelBarcode, record.ean, false);
  }
}

function barcodeOptions(forPrint) {
  const baseScale = forPrint ? 1 : state.scale;
  const heightPx = Math.round(state.labelHmm * 3.78 * 0.35 * baseScale);
  const widthPx = Math.max(1, Math.round(1.2 * baseScale));
  const fontSize = Math.max(10, Math.round(10 * baseScale));
  return {
    height: heightPx,
    width: widthPx,
    displayValue: true,
    fontSize,
    margin: 0,
  };
}

function renderBarcode(target, value, forPrint) {
  if (!window.JsBarcode) {
    return;
  }
  const normalized = normalizeEAN(value) || "";
  if (!normalized) {
    target.innerHTML = "";
    return;
  }
  const isEan = /^\d{12,13}$/.test(normalized);
  const format = isEan ? "EAN13" : "CODE128";
  const options = barcodeOptions(forPrint);
  try {
    JsBarcode(target, normalized, { ...options, format });
  } catch (error) {
    try {
      JsBarcode(target, normalized, { ...options, format: "CODE128" });
    } catch (err) {
      target.innerHTML = "";
    }
  }
}

function updatePrintStyle() {
  elements.printStyle.textContent = `@page { size: ${state.labelWmm}mm ${state.labelHmm}mm; margin: 0; }`;
}

function buildLabelElement(record) {
  const label = document.createElement("div");
  label.className = "label print-label";
  label.style.width = `${state.labelWmm}mm`;
  label.style.height = `${state.labelHmm}mm`;

  const article = document.createElement("div");
  article.className = "label__article";
  article.textContent = record.article || "-";

  const price = document.createElement("div");
  price.className = "label__price";
  price.textContent = formatPrice(record.prixClub);

  const publicPrice = document.createElement("div");
  publicPrice.className = "label__public";
  publicPrice.textContent = formatPrice(record.prixPublic);

  const barcode = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  barcode.classList.add("barcode");

  label.append(article, price, publicPrice, barcode);
  renderBarcode(barcode, record.ean, true);
  return label;
}

function printRecords(records) {
  if (!records.length) {
    setStatus("Aucun resultat a imprimer");
    return;
  }
  elements.printArea.innerHTML = "";
  records.forEach((record) => {
    elements.printArea.appendChild(buildLabelElement(record));
  });
  updatePrintStyle();
  window.print();
}

function onResultsClick(event) {
  const row = event.target.closest("tr");
  if (!row) {
    return;
  }
  const index = Number(row.dataset.index);
  if (Number.isInteger(index)) {
    selectIndex(index);
  }
}

function setupEvents() {
  elements.fileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) {
      loadFile(file);
    }
  });

  elements.loadDemo.addEventListener("click", async () => {
    try {
      const response = await fetch("ORCHESTRA_MARGE.xlsx");
      if (!response.ok) {
        throw new Error("Fichier non disponible");
      }
      const blob = await response.blob();
      const file = new File([blob], "ORCHESTRA_MARGE.xlsx", {
        type: blob.type,
      });
      loadFile(file, "ORCHESTRA_MARGE.xlsx");
    } catch (error) {
      alert("Impossible de charger ORCHESTRA_MARGE.xlsx. Utilisez le bouton fichier.");
    }
  });

  elements.searchBtn.addEventListener("click", runSearch);
  elements.clearBtn.addEventListener("click", clearSearch);
  elements.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      runSearch();
    }
  });
  elements.resultsBody.addEventListener("click", onResultsClick);

  elements.labelWidth.addEventListener("input", updatePreviewSize);
  elements.labelHeight.addEventListener("input", updatePreviewSize);
  elements.previewScale.addEventListener("input", updatePreviewSize);

  elements.printSelected.addEventListener("click", () => {
    if (state.selectedIndex == null) {
      setStatus("Selectionnez une ligne");
      return;
    }
    const record = state.filtered[state.selectedIndex];
    if (record) {
      printRecords([record]);
    }
  });
  elements.printAll.addEventListener("click", () => {
    if (!state.filtered.length) {
      setStatus("Aucun resultat");
      return;
    }
    printRecords(state.filtered);
  });
}

function init() {
  elements.fileInput = document.getElementById("file-input");
  elements.loadDemo = document.getElementById("load-demo");
  elements.filePill = document.getElementById("file-pill");
  elements.status = document.getElementById("status");
  elements.searchType = document.getElementById("search-type");
  elements.searchInput = document.getElementById("search-input");
  elements.searchBtn = document.getElementById("search-btn");
  elements.clearBtn = document.getElementById("clear-btn");
  elements.resultsBody = document.getElementById("results-body");
  elements.resultsCount = document.getElementById("results-count");
  elements.labelWidth = document.getElementById("label-width");
  elements.labelHeight = document.getElementById("label-height");
  elements.previewScale = document.getElementById("preview-scale");
  elements.labelPreview = document.getElementById("label-preview");
  elements.labelArticle = document.getElementById("label-article");
  elements.labelPrice = document.getElementById("label-price");
  elements.labelPublic = document.getElementById("label-public");
  elements.labelBarcode = document.getElementById("label-barcode");
  elements.printSelected = document.getElementById("print-selected");
  elements.printAll = document.getElementById("print-all");
  elements.printArea = document.getElementById("print-area");
  elements.printStyle = document.getElementById("print-style");

  updatePreviewSize();
  setupEvents();
}

document.addEventListener("DOMContentLoaded", init);
