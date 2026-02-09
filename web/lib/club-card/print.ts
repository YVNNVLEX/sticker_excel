"use client";

import JsBarcode from "jsbarcode";
import { escapeHtml, normalizeText } from "@/lib/utils/format";

export type ClubLabelPayload = {
  code?: string;
  barcode?: string;
  client?: string;
  date_fin?: unknown;
  expirationDate?: unknown;
};

type PrintableClubLabel = {
  code: string;
  client: string;
  barcodeSvg: string;
  expiration: string;
};

function renderBarcodeSvg(barcode: string) {
  try {
    const value = normalizeText(barcode);
    if (!value) return "";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

    JsBarcode(svg, value, {
      format: "CODE128",
      displayValue: false,
      height: 52,
      margin: 0,
    });

    // Keep final sizing in CSS, but ensure safe SVG dimensions.
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");

    return new XMLSerializer().serializeToString(svg);
  } catch {
    return "";
  }
}

function toPrintableLabel(card: ClubLabelPayload): PrintableClubLabel | null {
  const client = normalizeText(card.client) || "Client";
  const code = normalizeText(card.code);
  const barcodeValue = normalizeText(card.barcode) || code;
  const expirationRaw = card.date_fin ?? card.expirationDate;
  if (!barcodeValue) {
    return null;
  }

  return {
    code: barcodeValue,
    client,
    barcodeSvg: renderBarcodeSvg(barcodeValue),
    expiration: formatExpirationDate(expirationRaw),
  };
}

function formatExpirationDate(value: unknown) {
  const text = normalizeText(value);
  if (!text) return "-";

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${day}/${month}/${year}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString("fr-FR");
  }

  return text;
}

function buildLabelPageHtml({
  code,
  client,
  barcodeSvg,
  expiration,
}: PrintableClubLabel) {
  const safeCode = escapeHtml(normalizeText(code) || "-");
  const safeClient = escapeHtml(normalizeText(client) || "Client");
  const safeExpiration = escapeHtml(normalizeText(expiration) || "-");

  return `<div class="page-shell">
    <div class="page">
      <div class="label">
        <div class="client">${safeClient}</div>
        ${barcodeSvg ? `<div class="barcode">${barcodeSvg}</div>` : ""}
        <div class="barcodeText">${safeCode}</div>
        <div class="expiry">Expire le : ${safeExpiration}</div>
      </div>
    </div>
  </div>`;
}

function buildClubLabelsHtml(cards: PrintableClubLabel[]) {
  const pages = cards.map((card) => buildLabelPageHtml(card)).join("");

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Etiquettes Club Card</title>
    <style>
      @page { size: 80mm 50mm; margin: 0; }

      * {
        box-sizing: border-box;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      html, body {
        margin: 0;
        padding: 0;
        background: #fff;
      }

      body {
        font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      }

      .page-shell {
        width: 80mm;
        height: 50mm;
        overflow: hidden;
        page-break-after: always;
        break-after: page;
      }

      .page-shell:last-child {
        page-break-after: auto;
        break-after: auto;
      }

      .page {
        width: 80mm;
        height: 50mm;
        padding: 3mm 4mm;
        overflow: hidden;
      }

      .label {
        width: 100%;
        height: 100%;
        text-align: center;
      }

      .client {
        margin: 0;
        padding: 0;
        font-size: 20px;
        font-weight: 900;
        color: #111;
        line-height: 1.05;
        margin-top: 2mm;
        margin-bottom: 1.2mm;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .barcode {
        width: 100%;
        margin: 0;
        padding: 0;
        display: block;
      }

      .barcode svg {
        display: block;
        width: 100%;
        max-width: 260px;
        height: 18mm;
        margin: 0 auto;
      }

      .barcodeText {
        margin: 0;
        padding: 0;
        margin-top: 1mm;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.12em;
        color: #444;
        line-height: 1;
      }

      .expiry {
        margin: 0;
        padding: 0;
        margin-top: 1.2mm;
        font-size: 10px;
        font-weight: 800;
        color: #d62828;
        line-height: 1.1;
      }
    </style>
  </head>
  <body>
    ${pages}
  </body>
</html>`;
}

function printHtml(html: string, setStatus?: (message: string) => void) {
  const schedulePrintPopup = (win: Window) => {
    // Double RAF gives Chromium enough time to finish layout before print.
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(() => {
        win.focus();
        win.print();
        window.setTimeout(() => win.close(), 200);
      });
    });
  };

  const tryPopup = () => {
    const win = window.open("", "_blank", "noopener,noreferrer,width=520,height=420");
    if (!win) return false;

    win.document.open();
    win.document.write(html);
    win.document.close();

    if (win.document.readyState === "complete") {
      window.setTimeout(() => schedulePrintPopup(win), 60);
    } else {
      win.onload = () => window.setTimeout(() => schedulePrintPopup(win), 60);
    }
    return true;
  };

  const tryIframe = () => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const frameDoc = iframe.contentDocument;
    const frameWin = iframe.contentWindow;

    if (!frameDoc || !frameWin) {
      iframe.remove();
      return;
    }

    frameDoc.open();
    frameDoc.write(html);
    frameDoc.close();

    const schedule = () => {
      frameWin.requestAnimationFrame(() => {
        frameWin.requestAnimationFrame(() => {
          frameWin.focus();
          frameWin.print();
          window.setTimeout(() => iframe.remove(), 300);
        });
      });
    };

    if (frameDoc.readyState === "complete") {
      window.setTimeout(schedule, 60);
    } else {
      frameWin.onload = () => window.setTimeout(schedule, 60);
    }
  };

  const ok = tryPopup();
  if (!ok) {
    setStatus?.("Popup bloque, utilisation du mode iframe");
    tryIframe();
  }
}

export function printClubLabels(
  cards: ClubLabelPayload[],
  setStatus?: (message: string) => void,
) {
  const printable = cards
    .map((card) => toPrintableLabel(card))
    .filter((card): card is PrintableClubLabel => Boolean(card));

  if (!printable.length) {
    setStatus?.("Code manquant");
    return;
  }

  const html = buildClubLabelsHtml(printable);
  setStatus?.(`Preparation impression Club Card (${printable.length})...`);
  printHtml(html, setStatus);
  setStatus?.(`Impression Club Card (${printable.length})...`);
}

export function printClubLabel(
  card: ClubLabelPayload,
  setStatus?: (message: string) => void,
) {
  printClubLabels([card], setStatus);
}
