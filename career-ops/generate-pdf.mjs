#!/usr/bin/env node

/**
 * generate-pdf.mjs — HTML → PDF via Playwright
 *
 * Usage:
 *   node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4] [--skip-validate] [--no-trim-fallback] [--save-final-html] [--scale=<n>] [--tune-scale]
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
import { execSync, spawnSync } from 'child_process';
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

function countPdfPages(pdfBuffer) {
  const pdfString = pdfBuffer.toString('latin1');
  return (pdfString.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

function removeLegacyOptionalSections(html) {
  const sectionPatterns = [
    /<div class="section[^\"]*">\s*<div class="section-title">[^<]*(?:Core\s*Competencies|Competencias(?:\s+Clave)?|Competencies?)\b[^<]*<\/div>[\s\S]*?(?=<div class="section[^\"]*">|<\/main>|<\/body>)/gi,
    /<div class="section[^\"]*">\s*<div class="section-title">[^<]*(?:Certifications?|Certificaciones)\b[^<]*<\/div>[\s\S]*?(?=<div class="section[^\"]*">|<\/main>|<\/body>)/gi,
    /<!--\s*CORE\s+COMPETENCIES\s*-->[\s\S]*?(?=<!--\s*[A-Z ]+\s*-->|<\/main>|<\/body>)/gi,
    /<!--\s*CERTIFICATIONS\s*-->[\s\S]*?(?=<!--\s*[A-Z ]+\s*-->|<\/main>|<\/body>)/gi,
  ];

  let out = html;
  let removedCount = 0;

  for (const pattern of sectionPatterns) {
    const matches = out.match(pattern);
    if (matches && matches.length > 0) {
      removedCount += matches.length;
      out = out.replace(pattern, '');
    }
  }

  return {
    html: out,
    removed: removedCount > 0,
    removedCount,
  };
}

function applyCompactLayoutFallback(html) {
  const compactCss = `
<style id="pdf-compact-fallback">
  body { font-size: 10px !important; line-height: 1.4 !important; }
  .header { margin-bottom: 4px !important; padding-top: 0 !important; }
  .header h1 { font-size: 24px !important; margin-bottom: 4px !important; }
  .header-gradient { margin-bottom: 4px !important; }
  .contact-row { font-size: 9.8px !important; gap: 6px 10px !important; }
  .section { margin-bottom: 6px !important; }
  .section-title { font-size: 11px !important; margin-bottom: 4px !important; padding-bottom: 2px !important; }
  .summary-text, .skill-item, .edu-desc, .job-role, .job-location, .project-tech { font-size: 10px !important; line-height: 1.4 !important; }
  .job { margin-bottom: 6px !important; }
  .project { margin-bottom: 4px !important; }
  .job-header, .edu-header, .project-header { margin-bottom: 3px !important; }
  .job ul, .project ul { margin-top: 3px !important; padding-left: 18px !important; }
  .job li, .project li { font-size: 9.8px !important; line-height: 1.42 !important; margin-bottom: 2px !important; }
</style>`;

  if (html.includes('id="pdf-compact-fallback"')) {
    return { html, applied: false };
  }

  if (/<\/head>/i.test(html)) {
    return {
      html: html.replace(/<\/head>/i, `${compactCss}\n</head>`),
      applied: true,
    };
  }

  return {
    html: `${compactCss}\n${html}`,
    applied: true,
  };
}

function buildScaleTunerHtml(html, { inputPath, outputPath, format }) {
  const usableHeight = format === 'letter' ? Math.floor(1056 - 2 * (0.2 * 96)) : Math.floor(1122.52 - 2 * (0.2 * 96));
  const quotedInput = JSON.stringify(inputPath);
  const quotedOutput = JSON.stringify(outputPath);
  const quotedFormat = JSON.stringify(format);
  const panel = `
<div id="pdf-scale-tuner" style="position:fixed;right:12px;top:12px;z-index:2147483647;background:#111;color:#fff;padding:10px 12px;border-radius:8px;font:12px/1.4 Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,0.35);max-width:360px">
  <div style="font-weight:700;margin-bottom:6px">PDF Scale Tuner</div>
  <div style="margin-bottom:6px">Scale: <span id="scale-value">1.00</span></div>
  <input id="scale-slider" type="range" min="0.70" max="1.20" step="0.01" value="1.00" style="width:100%" />
  <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
    <button id="scale-dec">-0.01</button>
    <button id="scale-inc">+0.01</button>
    <button id="scale-auto">Auto Fit</button>
    <button id="scale-copy">Copy CLI</button>
  </div>
  <div style="margin-top:8px">Estimated pages: <span id="page-est">?</span></div>
  <textarea id="scale-cli" readonly style="margin-top:8px;width:100%;height:54px;font:11px/1.3 Consolas,monospace"></textarea>
</div>`;

  const script = `
<script>
(() => {
  const usableHeight = ${usableHeight};
  const inputPath = ${quotedInput};
  const outputPath = ${quotedOutput};
  const format = ${quotedFormat};
  const panel = document.getElementById('pdf-scale-tuner');
  if (!panel) return;

  const root = document.createElement('div');
  root.id = 'resume-root';
  const moved = [];
  Array.from(document.body.childNodes).forEach((n) => { if (n !== panel) moved.push(n); });
  moved.forEach((n) => root.appendChild(n));
  document.body.appendChild(root);
  root.style.transformOrigin = 'top left';

  const slider = document.getElementById('scale-slider');
  const value = document.getElementById('scale-value');
  const pageEst = document.getElementById('page-est');
  const cli = document.getElementById('scale-cli');

  function updateCLI(scale) {
    cli.value = 'node generate-pdf.mjs "' + inputPath + '" "' + outputPath + '" --format=' + format + ' --scale=' + scale.toFixed(2) + ' --no-trim-fallback';
  }

  function applyScale(scale) {
    const s = Math.max(0.70, Math.min(1.20, Number(scale) || 1));
    slider.value = s.toFixed(2);
    value.textContent = s.toFixed(2);
    root.style.transform = 'scale(' + s.toFixed(2) + ')';
    root.style.width = (100 / s).toFixed(4) + '%';
    const est = Math.ceil((root.offsetHeight * s) / usableHeight);
    pageEst.textContent = String(Math.max(1, est));
    updateCLI(s);
    try { localStorage.setItem('pdf-scale-tuner:lastScale', s.toFixed(2)); } catch {}
  }

  document.getElementById('scale-dec').addEventListener('click', () => applyScale((Number(slider.value) || 1) - 0.01));
  document.getElementById('scale-inc').addEventListener('click', () => applyScale((Number(slider.value) || 1) + 0.01));
  document.getElementById('scale-auto').addEventListener('click', () => {
    const fit = Math.max(0.70, Math.min(1.20, usableHeight / Math.max(1, root.offsetHeight)));
    applyScale(fit);
  });
  document.getElementById('scale-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cli.value); } catch {}
  });
  slider.addEventListener('input', () => applyScale(Number(slider.value) || 1));

  let initial = 1;
  try {
    const stored = Number(localStorage.getItem('pdf-scale-tuner:lastScale') || '1');
    if (Number.isFinite(stored) && stored >= 0.70 && stored <= 1.20) initial = stored;
  } catch {}
  applyScale(initial);
})();
</script>`;

  let out = html;
  if (/<body[^>]*>/i.test(out)) {
    out = out.replace(/<body([^>]*)>/i, `<body$1>${panel}`);
  } else {
    out = `${panel}${out}`;
  }
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${script}\n</body>`);
  } else {
    out = `${out}\n${script}`;
  }
  return out;
}

function openFileInDefaultApp(filePath) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('cmd', ['/c', 'start', '', filePath], { stdio: 'ignore' });
      return (result.status ?? 0) === 0;
    }

    if (process.platform === 'darwin') {
      const result = spawnSync('open', [filePath], { stdio: 'ignore' });
      return (result.status ?? 0) === 0;
    }

    const result = spawnSync('xdg-open', [filePath], { stdio: 'ignore' });
    return (result.status ?? 0) === 0;
  } catch {
    return false;
  }
}

async function renderPdfPass(browser, html, format, passLabel = 'pass', forcedScale = null) {
  const page = await browser.newPage();
  try {
    await page.setContent(html, {
      waitUntil: 'networkidle',
    });

    await page.evaluate(() => document.fonts.ready);

    const scaleInfo = await page.evaluate(async ({ pageFormat, forcedScale }) => {
      const body = document.body;

      // Page dimensions at 96 CSS px/in — must match PDF margin option below
      const PAGE_HEIGHT_PX = pageFormat === 'letter' ? 1056 : 1122.52; // a4 = 297mm/25.4*96
      const MARGIN_PX = 0.2 * 96; // 0.2in — same as margin option passed to page.pdf()
      const USABLE_HEIGHT = Math.floor(PAGE_HEIGHT_PX - 2 * MARGIN_PX);
      const MAX_SCALE = 1.15; // allow up to 15% scale-up; no extra safety margin (cap handles it)
      const WHITESPACE_THRESHOLD = 30; // px — ignore trivial gaps

      const initialHeight = body.offsetHeight;

      if (forcedScale !== null && Number.isFinite(forcedScale)) {
        const s = Math.max(0.6, Math.min(1.2, Number(forcedScale)));
        body.style.transform = `scale(${s})`;
        body.style.transformOrigin = 'top left';
        body.style.width = `${100 / s}%`;
        const finalHeight = body.offsetHeight * s;
        return {
          scale: s,
          overflow: finalHeight > USABLE_HEIGHT,
          scaled: Math.abs(s - 1.0) > 0.01,
          originalHeight: initialHeight,
          finalHeight,
          method: 'manual scale',
          usableHeight: USABLE_HEIGHT,
        };
      }

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
          method: 'binary search -> fit 1 page',
          usableHeight: USABLE_HEIGHT,
        };
      }

      const remainingSpace = USABLE_HEIGHT - initialHeight;
      let bestScale = 1.0;

      if (remainingSpace > WHITESPACE_THRESHOLD) {
        const scaleToFill = USABLE_HEIGHT / initialHeight;
        bestScale = Math.min(scaleToFill, MAX_SCALE);
      }

      body.style.transform = `scale(${bestScale})`;
      body.style.transformOrigin = 'top left';
      body.style.width = `${100 / bestScale}%`;

      const finalHeight = bestScale > 1 ? initialHeight * bestScale : initialHeight / bestScale;
      const scaled = Math.abs(bestScale - 1.0) > 0.01;

      return {
        scale: bestScale,
        overflow: false,
        scaled: scaled,
        originalHeight: initialHeight,
        finalHeight: finalHeight,
        remainingSpace: remainingSpace,
        method: 'dynamic fill -> eliminate whitespace',
        usableHeight: USABLE_HEIGHT,
      };
    }, { pageFormat: format, forcedScale });

    if (scaleInfo.scaled) {
      const method = scaleInfo.overflow ? 'fit 1 page' : 'fill whitespace';
      console.log(`📏 Autoscale (${passLabel}, ${method}): ${(scaleInfo.scale * 100).toFixed(0)}% (${scaleInfo.originalHeight}px -> ${Math.round(scaleInfo.finalHeight)}px)`);
    } else {
      console.log(`✅ Single page fit (${passLabel}): no scaling needed`);
    }

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

    return {
      pdfBuffer,
      pageCount: countPdfPages(pdfBuffer),
      scaleInfo,
    };
  } finally {
    await page.close();
  }
}

async function generatePDF() {
  const startTime = Date.now();
  const args = process.argv.slice(2);

  // Parse arguments
  let inputPath, outputPath, format = 'a4';

  let skipValidate = false;
  let trimFallback = true;
  let saveFinalHtml = false;
  let manualScale = null;
  let tuneScale = false;
  let openTuner = false;

  for (const arg of args) {
    if (arg.startsWith('--format=')) {
      format = arg.split('=')[1].toLowerCase();
    } else if (arg === '--skip-validate') {
      skipValidate = true;
    } else if (arg === '--no-trim-fallback') {
      trimFallback = false;
    } else if (arg === '--save-final-html') {
      saveFinalHtml = true;
    } else if (arg.startsWith('--scale=')) {
      const v = Number(arg.split('=')[1]);
      if (!Number.isFinite(v)) {
        console.error('Invalid --scale value. Expected numeric scale like --scale=0.96');
        process.exit(1);
      }
      manualScale = v;
    } else if (arg === '--tune-scale') {
      tuneScale = true;
    } else if (arg === '--open-tuner') {
      openTuner = true;
    } else if (!inputPath) {
      inputPath = arg;
    } else if (!outputPath) {
      outputPath = arg;
    }
  }

  if (!inputPath || !outputPath) {
    console.error('Usage: node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4] [--skip-validate] [--no-trim-fallback] [--save-final-html] [--scale=<n>] [--tune-scale] [--open-tuner]');
    process.exit(1);
  }

  if (manualScale !== null) {
    manualScale = Math.max(0.6, Math.min(1.2, manualScale));
    trimFallback = false;
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

  if (tuneScale) {
    const tunerHtml = buildScaleTunerHtml(html, { inputPath, outputPath, format });
    const { writeFile } = await import('fs/promises');
    const tunerPath = outputPath.replace(/\.pdf$/i, '.scale-tuner.html');
    await writeFile(tunerPath, tunerHtml, 'utf8');
    console.log(`🎛️  Scale tuner saved: ${tunerPath}`);
    if (openTuner) {
      const opened = openFileInDefaultApp(tunerPath);
      if (opened) {
        console.log('🌐 Opened scale tuner in default browser');
      } else {
        console.log('⚠️  Could not auto-open tuner. Open the file manually.');
      }
    }
    console.log('Use the slider in your browser, then run the printed CLI with --scale=<value> to finalize PDF.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const htmlWithBase = html;
    let finalHtml = htmlWithBase;
    let render = await renderPdfPass(browser, finalHtml, format, 'pass 1', manualScale);
    let fallbackApplied = false;
    let fallbackMode = 'none';

    if (trimFallback && render.pageCount > 1) {
      const trimmed = removeLegacyOptionalSections(finalHtml);
      if (trimmed.removed) {
        console.log(`↩️  Fallback: output has ${render.pageCount} pages. Removing ${trimmed.removedCount} legacy optional section(s) and regenerating...`);
        const fallbackRender = await renderPdfPass(browser, trimmed.html, format, 'fallback pass');

        if (fallbackRender.pageCount <= render.pageCount) {
          finalHtml = trimmed.html;
          render = fallbackRender;
          fallbackApplied = true;
          fallbackMode = 'legacy-section-trim';
          console.log(`✅ Fallback result accepted: ${render.pageCount} page(s)`);
        } else {
          console.log(`⚠️  Fallback result rejected (worse page count: ${fallbackRender.pageCount}). Keeping original render.`);
        }
      } else {
        console.log('ℹ️  Fallback skipped: no removable legacy optional sections found.');
      }

      if (render.pageCount > 1) {
        const compact = applyCompactLayoutFallback(finalHtml);
        if (compact.applied) {
          console.log(`↩️  Compact fallback: still ${render.pageCount} pages. Tightening layout and regenerating...`);
          const compactRender = await renderPdfPass(browser, compact.html, format, 'compact fallback pass');
          if (compactRender.pageCount <= render.pageCount) {
            finalHtml = compact.html;
            render = compactRender;
            fallbackApplied = true;
            fallbackMode = fallbackMode === 'none' ? 'compact-layout' : `${fallbackMode}+compact-layout`;
            console.log(`✅ Compact fallback accepted: ${render.pageCount} page(s)`);
          } else {
            console.log(`⚠️  Compact fallback rejected (worse page count: ${compactRender.pageCount}).`);
          }
        }
      }

    }

    const pdfBuffer = render.pdfBuffer;

    // Write PDF
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, pdfBuffer);

    const pageCount = render.pageCount;

    console.log(`✅ PDF generated: ${outputPath}`);
    console.log(`📊 Pages: ${pageCount}`);
    if (fallbackApplied) {
      console.log(`🩹 Fallback applied: ${fallbackMode}`);
    }
    console.log(`📦 Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    if (saveFinalHtml) {
      const { writeFile } = await import('fs/promises');
      const finalHtmlPath = outputPath.replace(/\.pdf$/i, '.final.html');
      await writeFile(finalHtmlPath, finalHtml, 'utf8');
      console.log(`🧩 Final render HTML: ${finalHtmlPath}`);
    }

    const receiptPath = writeRunReceipt(__dirname, 'pdf', {
      inputPath,
      outputPath,
      format,
      pageCount,
      trimFallbackEnabled: trimFallback,
      trimFallbackApplied: fallbackApplied,
      trimFallbackMode: fallbackMode,
      saveFinalHtml,
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
