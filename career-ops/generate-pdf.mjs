#!/usr/bin/env node

/**
 * generate-pdf.mjs — HTML → PDF via Playwright
 *
 * Usage:
 *   node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4] [--skip-validate]
 *
 * Requires: @playwright/test (or playwright) installed.
 * Uses Chromium headless to render the HTML and produce a clean, ATS-parseable PDF.
 *
 * Validation: By default, validates HTML against pdf.md specs before PDF generation.
 * Use --skip-validate to skip validation.
 */

import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { readFile } from 'fs/promises';
import { mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeRunReceipt } from './scripts/run-receipt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure output directory exists (fresh setup)
mkdirSync(resolve(__dirname, 'output'), { recursive: true });

/**
 * Normalize text for ATS compatibility by converting problematic Unicode.
 *
 * ATS parsers and legacy systems often fail on em-dashes, smart quotes,
 * zero-width characters, and non-breaking spaces. These cause mojibake,
 * parsing errors, or display issues. See issue #1.
 *
 * Only touches body text — preserves CSS, JS, tag attributes, and URLs.
 * Returns { html, replacements } so the caller can log what was changed.
 */
function normalizeTextForATS(html) {
  const replacements = {};
  const bump = (key, n) => { replacements[key] = (replacements[key] || 0) + n; };

  const masks = [];
  const masked = html.replace(
    /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (match) => {
      const token = `\u0000MASK${masks.length}\u0000`;
      masks.push(match);
      return token;
    }
  );

  let out = '';
  let i = 0;
  while (i < masked.length) {
    const lt = masked.indexOf('<', i);
    if (lt === -1) { out += sanitizeText(masked.slice(i)); break; }
    out += sanitizeText(masked.slice(i, lt));
    const gt = masked.indexOf('>', lt);
    if (gt === -1) { out += masked.slice(lt); break; }
    out += masked.slice(lt, gt + 1);
    i = gt + 1;
  }

  const restored = out.replace(/\u0000MASK(\d+)\u0000/g, (_, n) => masks[Number(n)]);
  return { html: restored, replacements };

  function sanitizeText(text) {
    if (!text) return text;
    let t = text;
    t = t.replace(/\u2014/g, () => { bump('em-dash', 1); return '-'; });
    t = t.replace(/\u2013/g, () => { bump('en-dash', 1); return '-'; });
    t = t.replace(/[\u201C\u201D\u201E\u201F]/g, () => { bump('smart-double-quote', 1); return '"'; });
    t = t.replace(/[\u2018\u2019\u201A\u201B]/g, () => { bump('smart-single-quote', 1); return "'"; });
    t = t.replace(/\u2026/g, () => { bump('ellipsis', 1); return '...'; });
    t = t.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, () => { bump('zero-width', 1); return ''; });
    t = t.replace(/\u00A0/g, () => { bump('nbsp', 1); return ' '; });
    return t;
  }
}

async function generatePDF() {
  const startTime = Date.now();
  const args = process.argv.slice(2);

  // Parse arguments
  let inputPath, outputPath, format = 'a4';

  let skipValidate = false;

  for (const arg of args) {
    if (arg.startsWith('--format=')) {
      format = arg.split('=')[1].toLowerCase();
    } else if (arg === '--skip-validate') {
      skipValidate = true;
    } else if (!inputPath) {
      inputPath = arg;
    } else if (!outputPath) {
      outputPath = arg;
    }
  }

  if (!inputPath || !outputPath) {
    console.error('Usage: node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4]');
    process.exit(1);
  }

  inputPath = resolve(inputPath);
  outputPath = resolve(outputPath);

  // Validate format
  const validFormats = ['a4', 'letter'];
  if (!validFormats.includes(format)) {
    console.error(`Invalid format "${format}". Use: ${validFormats.join(', ')}`);
    process.exit(1);
  }

  console.log(`📄 Input:  ${inputPath}`);
  console.log(`📁 Output: ${outputPath}`);
  console.log(`📏 Format: ${format.toUpperCase()}`);

  // Validate HTML against formatting specs (unless skipped)
  if (!skipValidate) {
    console.log(`\n🔍 Validating HTML...`);
    try {
      execSync(`node validate-resume-html.mjs "${inputPath}"`, {
        cwd: __dirname,
        stdio: 'inherit'
      });
    } catch (err) {
      console.error('\n⚠️  Validation errors detected. Fix them before PDF generation.');
      console.error('Use --skip-validate to bypass validation (not recommended).\n');
      process.exit(1);
    }
  }

  // Read HTML to inject font paths as absolute file:// URLs
  let html = await readFile(inputPath, 'utf-8');

  // Resolve font paths relative to career-ops/fonts/
  const fontsDir = resolve(__dirname, 'fonts');
  html = html.replace(
    /url\(['"]?\.\/fonts\//g,
    `url('file://${fontsDir}/`
  );
  // Close any unclosed quotes from the replacement (handles all font formats)
  html = html.replace(
    /file:\/\/([^'")]+)\.(woff2?|ttf|otf)['"]?\)/g,
    `file://$1.$2')`
  );

  // Normalize text for ATS compatibility (issue #1)
  const normalized = normalizeTextForATS(html);
  html = normalized.html;
  const totalReplacements = Object.values(normalized.replacements).reduce((a, b) => a + b, 0);
  if (totalReplacements > 0) {
    const breakdown = Object.entries(normalized.replacements).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`🧹 ATS normalization: ${totalReplacements} replacements (${breakdown})`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Set content with file base URL for any relative resources
    await page.setContent(html, {
      waitUntil: 'networkidle',
      baseURL: `file://${dirname(inputPath)}/`,
    });

    // Wait for fonts to load
    await page.evaluate(() => document.fonts.ready);

    // Autoscale: dynamic fill to eliminate bottom whitespace
    const scaleInfo = await page.evaluate(async (pageFormat) => {
      const body = document.body;

      // Page dimensions at 96 CSS px/in — must match PDF margin option below
      const PAGE_HEIGHT_PX = pageFormat === 'letter' ? 1056 : 1122.52; // a4 = 297mm/25.4*96
      const MARGIN_PX = 0.2 * 96; // 0.2in — same as margin option passed to page.pdf()
      const USABLE_HEIGHT = Math.floor(PAGE_HEIGHT_PX - 2 * MARGIN_PX);
      const MAX_SCALE = 1.15; // allow up to 15% scale-up; no extra safety margin (cap handles it)
      const WHITESPACE_THRESHOLD = 30; // px — ignore trivial gaps

      const initialHeight = body.offsetHeight;

      // Check if content overflows
      if (initialHeight > USABLE_HEIGHT) {
        // Binary search: scale down to fit on 1 page
        let scaleMin = 0.6;
        let scaleMax = 1.0;
        let bestScale = 1.0;
        let iterations = 0;
        const maxIterations = 10;

        while (iterations < maxIterations && scaleMax - scaleMin > 0.01) {
          iterations++;
          const testScale = (scaleMin + scaleMax) / 2;

          body.style.transform = `scale(${testScale})`;
          body.style.transformOrigin = 'top left';
          body.style.width = `${100 / testScale}%`;

          const testHeight = body.offsetHeight / testScale;

          if (testHeight <= USABLE_HEIGHT) {
            bestScale = testScale;
            scaleMin = testScale;
          } else {
            scaleMax = testScale;
          }
        }

        bestScale = Math.max(0.6, bestScale * 0.99); // 1% safety margin
        body.style.transform = `scale(${bestScale})`;
        body.style.transformOrigin = 'top left';
        body.style.width = `${100 / bestScale}%`;

        const finalHeight = body.offsetHeight / bestScale;
        return {
          scale: bestScale,
          overflow: true,
          scaled: true,
          originalHeight: initialHeight,
          finalHeight: finalHeight,
          iterations: iterations,
          method: 'binary search → fit 1 page',
          usableHeight: USABLE_HEIGHT,
        };
      }

      // Content fits naturally. Check for significant whitespace
      const remainingSpace = USABLE_HEIGHT - initialHeight;
      let bestScale = 1.0;

      if (remainingSpace > WHITESPACE_THRESHOLD) {
        // Scale up to fill remaining whitespace — no extra safety margin, MAX_SCALE is the cap
        const scaleToFill = USABLE_HEIGHT / initialHeight;
        bestScale = Math.min(scaleToFill, MAX_SCALE);
      }

      // Apply final scale
      body.style.transform = `scale(${bestScale})`;
      body.style.transformOrigin = 'top left';
      body.style.width = `${100 / bestScale}%`;

      // Calculate final rendered height: when scaling UP, height increases
      const finalHeight = bestScale > 1 ? initialHeight * bestScale : initialHeight / bestScale;
      const scaled = Math.abs(bestScale - 1.0) > 0.01;

      return {
        scale: bestScale,
        overflow: false,
        scaled: scaled,
        originalHeight: initialHeight,
        finalHeight: finalHeight,
        remainingSpace: remainingSpace,
        method: 'dynamic fill → eliminate whitespace',
        usableHeight: USABLE_HEIGHT,
      };
    }, format);

    if (scaleInfo.scaled) {
      const method = scaleInfo.overflow ? 'fit 1 page' : 'fill whitespace';
      console.log(`📏 Autoscale (${method}): ${(scaleInfo.scale * 100).toFixed(0)}% (${scaleInfo.originalHeight}px → ${Math.round(scaleInfo.finalHeight)}px)`);
    } else {
      console.log(`✅ Single page fit: no scaling needed`);
    }

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: format,
      printBackground: true,
      margin: {
        top: '0.2in',
        right: '0.2in',
        bottom: '0.2in',
        left: '0.2in',
      },
      preferCSSPageSize: false,
    });

    // Write PDF
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, pdfBuffer);

    // Count pages (approximate from PDF structure)
    const pdfString = pdfBuffer.toString('latin1');
    const pageCount = (pdfString.match(/\/Type\s*\/Page[^s]/g) || []).length;

    console.log(`✅ PDF generated: ${outputPath}`);
    console.log(`📊 Pages: ${pageCount}`);
    console.log(`📦 Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    const receiptPath = writeRunReceipt(__dirname, 'pdf', {
      inputPath,
      outputPath,
      format,
      pageCount,
      sizeBytes: pdfBuffer.length,
      durationMs: Date.now() - startTime,
    });
    console.log(`🧾 Receipt: ${receiptPath}`);

    return { outputPath, pageCount, size: pdfBuffer.length };
  } finally {
    await browser.close();
  }
}

generatePDF().catch((err) => {
  console.error('❌ PDF generation failed:', err.message);
  process.exit(1);
});
