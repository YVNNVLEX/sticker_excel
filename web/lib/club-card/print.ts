"use client";

import JsBarcode from "jsbarcode";
import { escapeHtml, normalizeText } from "@/lib/utils/format";

export type ClubLabelPayload = { code?: string; barcode?: string; client?: string };

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

    // Laisse le CSS gérer l’affichage final, mais on garde des attributs safe
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");

    return new XMLSerializer().serializeToString(svg);
  } catch {
    return "";
  }
}

function buildSingleClubLabelHtml({
  code,
  client,
  barcodeSvg,
}: ClubLabelPayload & { barcodeSvg?: string }) {
  const safeCode = escapeHtml(normalizeText(code) || "-");
  const safeClient = escapeHtml(normalizeText(client) || "Client");

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Etiquette Club Card</title>
    <style>
      @page { size: 80mm 50mm; margin: 0; }

      * {
        box-sizing: border-box;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      /* IMPORTANT: forcer strictement 1 page */
      html, body {
        width: 80mm;
        height: 50mm;
        margin: 0;
        padding: 0;
        overflow: hidden !important;
        background: #fff;
      }

      body {
        font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      }

      /* Neutralise toute règle de saut de page injectée */
      * {
        page-break-before: auto !important;
        page-break-after: auto !important;
        page-break-inside: avoid !important;
        break-before: auto !important;
        break-after: auto !important;
        break-inside: avoid !important;
      }

      .page {
        width: 80mm;
        height: 50mm;
        padding: 3mm 4mm; /* compact */
        overflow: hidden !important;

        page-break-after: auto !important;
        break-after: auto !important;
        page-break-before: auto !important;
        break-before: auto !important;
      }

      .label {
        width: 100%;
        height: 100%;
        text-align: center;
      }

      /* SUPPRIME l’espace au-dessus: pas de justify-content:center, on contrôle via marges */
      .client {
        margin: 0;
        padding: 0;

        font-size: 20px;
        font-weight: 900;
        color: #111;
        line-height: 1.05;

        /* espace au-dessus (réduit) */
        margin-top: 2mm;

        /* espace entre nom et barcode (réduit) */
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

        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

      .barcode svg {
        display: block;
        width: 100%;
        max-width: 260px;
        height: 18mm;      /* fixe => stable */
        margin: 0 auto;

        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }

      .barcodeText {
        margin: 0;
        padding: 0;

        /* espace sous barcode */
        margin-top: 1mm;

        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.12em;
        color: #444;
        line-height: 1;

        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="label">
        <div class="client">${safeClient}</div>
        ${barcodeSvg ? `<div class="barcode">${barcodeSvg}</div>` : ""}
        <div class="barcodeText">${safeCode}</div>
      </div>
    </div>

    <script>
      // Anti "2e page blanche" : si overflow de 1px, on réduit très légèrement
      window.onload = () => {
        try {
          const root = document.documentElement;
          const body = document.body;

          // Fix police/SVG: laisse le rendu se stabiliser
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (body.scrollHeight > root.clientHeight) {
                body.style.zoom = "0.99";
              }
            });
          });
        } catch (e) {}
      };
    </script>
  </body>
</html>`;
}

export function printClubLabel(
  card: ClubLabelPayload,
  setStatus?: (message: string) => void,
) {
  const client = normalizeText(card.client) || "Client";
  const code = normalizeText(card.code);
  const barcodeValue = normalizeText(card.barcode) || code;

  if (!barcodeValue) {
    setStatus?.("Code manquant");
    return;
  }

  const barcodeSvg = renderBarcodeSvg(barcodeValue);
  const html = buildSingleClubLabelHtml({
    code: barcodeValue,
    client,
    barcodeSvg,
  });

  const schedulePrintPopup = (win: Window) => {
    // Double RAF: laisse Chrome terminer le layout avant print
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
