// ==================================================================
// Renders a member's application form to an A4 PDF with Puppeteer.
//
// One headless Chrome is started on first use and shared by every render (starting Chrome costs
// about a second); each render opens and closes its own page. closeBrowser() is called from
// server.js's graceful shutdown.
// ==================================================================
import puppeteer from 'puppeteer';
import { logger } from '../../../utils/logger.js';
import { PAGE_MARGIN, renderApplicationForm, renderFooter } from '../templates/applicationForm.js';
import { applicationDataService } from './applicationData.service.js';

const RENDER_TIMEOUT_MS = 30_000;
// Starting Chrome can take a while on a busy or low-memory machine (puppeteer's own default is 30 s).
const LAUNCH_TIMEOUT_MS = 90_000;

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({ headless: true, timeout: LAUNCH_TIMEOUT_MS, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    await (await pending).close();
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not close the PDF browser cleanly');
  }
}

/** @param {object} data what applicationDataService.buildApplicationData() returns */
async function renderPdf(data) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Everything (logo, photo) is inline, so nothing is fetched and the content is ready at once.
    await page.setContent(renderApplicationForm(data), { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: renderFooter(data),
      margin: {
        top: `${PAGE_MARGIN.top}mm`,
        right: `${PAGE_MARGIN.right}mm`,
        bottom: `${PAGE_MARGIN.bottom}mm`,
        left: `${PAGE_MARGIN.left}mm`,
      },
      timeout: RENDER_TIMEOUT_MS,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * The member's application form as a PDF.
 * @param {string|number|bigint} userId
 * @param {{ signedAt?: Date, ip?: string, guid?: string }} [options] see buildApplicationData
 * @returns {Promise<{ pdf: Buffer, data: object }>}
 */
async function generate(userId, options) {
  const data = await applicationDataService.buildApplicationData(userId, options);
  return { pdf: await renderPdf(data), data };
}

export const applicationPdfService = { generate, renderPdf, closeBrowser };
