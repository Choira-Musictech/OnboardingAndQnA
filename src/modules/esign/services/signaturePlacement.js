// ==================================================================
// Where the member signs, read from the rendered application PDF.
//
// The declaration's signature box is at a fixed spot on page 3 (SIGNATURE_BOX). The Work
// Notification page's slot is not: the works table decides which page it lands on and how far down.
// DocuSign finds it by its anchor text on its own; eMudhra needs coordinates, so the anchor is looked
// up in the PDF here and turned into a box.
// ==================================================================
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { SIGNATURE_BOX, WORK_PAGE_SIGNATURE } from '../templates/applicationForm.js';

/** The declaration's fixed box on page 3, in the shape emsigner.client.js takes. */
export const DECLARATION_BOX = Object.freeze({ page: SIGNATURE_BOX.page, ...SIGNATURE_BOX.pt, pageHeight: SIGNATURE_BOX.pageHeightPt });

/**
 * Every occurrence of the anchor text in the PDF.
 * @param {Buffer|Uint8Array} pdf
 * @param {string} [anchorText]
 * @returns {Promise<Array<{ page: number, x: number, y: number, pageHeight: number }>>}
 *   page is 1-based; x/y is the text's baseline start in PDF points from the page's BOTTOM-left.
 */
export async function findAnchors(pdf, anchorText = SIGNATURE_BOX.anchorText) {
  // pdfjs takes ownership of (and detaches) the bytes it is given, so it gets a copy.
  const doc = await getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const found = [];
    for (let page = 1; page <= doc.numPages; page += 1) {
      const pdfPage = await doc.getPage(page);
      const [, , , pageHeight] = pdfPage.view;
      const { items } = await pdfPage.getTextContent();
      for (const item of items) {
        if (item.str?.trim() === anchorText) found.push({ page, x: item.transform[4], y: item.transform[5], pageHeight });
      }
    }
    return found;
  } finally {
    await doc.destroy();
  }
}

/**
 * The declaration box (always) plus the Work Notification page's box when its anchor is found, in
 * the shape emsigner.client.js takes: PDF points from the page's TOP-left.
 * @param {Buffer|Uint8Array} pdf
 * @returns {Promise<Array<{ page: number, left: number, top: number, width: number, height: number, pageHeight: number }>>}
 */
export async function signatureBoxesFor(pdf) {
  const workAnchor = (await findAnchors(pdf)).find((anchor) => anchor.page > SIGNATURE_BOX.page);
  if (!workAnchor) return [DECLARATION_BOX];

  const { width, height, bottomAboveAnchor } = WORK_PAGE_SIGNATURE;
  const bottom = workAnchor.y + bottomAboveAnchor; // from the page's bottom
  return [
    DECLARATION_BOX,
    {
      page: workAnchor.page,
      left: Math.round(workAnchor.x),
      top: Math.round(workAnchor.pageHeight - bottom - height),
      width,
      height,
      pageHeight: Math.round(workAnchor.pageHeight),
    },
  ];
}
