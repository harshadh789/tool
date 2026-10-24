// ==============================================================================
// Campfly Phase 3B.1 - PDF Layout, Quotation Summary & QR Code Regression Tests
// ==============================================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== PHASE 3B.1: PDF LAYOUT & QR CODE REGRESSION TESTS ===');

let passCount = 0;
let totalCount = 0;

function test(name, fn) {
  totalCount++;
  try {
    fn();
    console.log(`✅ [PASS] ${totalCount}. ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ [FAIL] ${totalCount}. ${name}: ${err.message}`);
    throw err;
  }
}

const styleCssPath = path.join(__dirname, '../style.css');
const scriptJsPath = path.join(__dirname, '../script.js');
const viewHtmlPath = path.join(__dirname, '../view.html');

const styleCss = fs.readFileSync(styleCssPath, 'utf8');
const scriptJs = fs.readFileSync(scriptJsPath, 'utf8');
const viewHtml = fs.readFileSync(viewHtmlPath, 'utf8');

// 1. Page alignment & break prevention on core itinerary elements in style.css
test('style.css enforces page-break-inside: avoid !important on day sections, hotels and finance cards', () => {
  const criticalSelectors = [
    '.itinerary-day',
    '.hotel-card',
    '.quote-box',
    '.pricing-box',
    '.finance-card',
    '.inc-exc-grid',
    '.terms-box',
    '.cancel-table',
    '.bank-card',
    '.bank-qr-section'
  ];

  criticalSelectors.forEach(sel => {
    const regex = new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*page-break-inside:\\s*avoid\\s*!important`, 'i');
    assert.strictEqual(regex.test(styleCss), true, `Missing page-break-inside: avoid on ${sel}`);
  });
});

// 2. Heading orphan prevention in style.css
test('style.css enforces page-break-after: avoid !important on section titles and headers', () => {
  const headingSelectors = [
    '.section-title-main',
    '.finance-header',
    '.policy-title'
  ];

  headingSelectors.forEach(sel => {
    const regex = new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*page-break-after:\\s*avoid\\s*!important`, 'i');
    assert.strictEqual(regex.test(styleCss), true, `Missing page-break-after: avoid on ${sel}`);
  });
});

// 3. Customer view.html enforces pagination rules on customer-facing cards
test('view.html enforces page-break-inside avoid on day items, hotel items, and specs grid', () => {
  const customerBreakSelectors = [
    '.specs-grid',
    '.content-card',
    '.hotel-item',
    '.day-item',
    '.price-box',
    '.bank-box'
  ];

  customerBreakSelectors.forEach(sel => {
    const regex = new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*page-break-inside:\\s*avoid\\s*!important`, 'i');
    assert.strictEqual(regex.test(viewHtml), true, `Missing page-break-inside: avoid in view.html on ${sel}`);
  });
});

// 4. Quotation summary card widths & long quotation ID overflow handling
test('style.css handles long quotation IDs and fixed card table layouts without clipping', () => {
  assert(styleCss.includes('table-layout: fixed'), 'quote-table must have table-layout: fixed');
  assert(styleCss.includes('word-break: break-word'), 'quote-table must break long text');
  assert(styleCss.includes('overflow-wrap: anywhere') || styleCss.includes('overflow-wrap: break-word'), 'quote-table or box must wrap anywhere');
});

// 5. Customer view.html specs-grid handles flexible card widths
test('view.html specs-grid uses minmax(0, 1fr) and overflow-wrap anywhere to prevent overlap', () => {
  assert(viewHtml.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'), 'specs-grid must use minmax(0, 1fr)');
  assert(viewHtml.includes('overflow-wrap: anywhere'), 'spec-val must wrap long quotation numbers');
});

// 6. QR Code canvas-to-image conversion and single PDF generation in script.js
test('script.js prepares QR code assets, waits for image loading, and generates PDF via html2pdf', () => {
  assert(scriptJs.includes('preparePdfAssets'), 'script.js must define preparePdfAssets function');
  assert(scriptJs.includes('toDataURL'), 'script.js must convert canvas to dataURL');
  assert(scriptJs.includes('img.style.width'), 'script.js must set explicit width on QR image');
  assert(scriptJs.includes('img.complete'), 'script.js must verify image completion before export');
  assert(scriptJs.includes('html2pdf().set(opt).from(element)'), 'script.js must generate PDF from element with options');
  assert(scriptJs.includes('output(\'blob\')'), 'script.js must extract PDF Blob for reuse');
  assert(scriptJs.includes('/api/itineraries/'), 'script.js must upload generated PDF to backend');
});

// 7. Customer view.html downloads official team-generated PDF via secure share endpoint
test('view.html downloads official team-generated PDF via secure token endpoint without duplicate client generation', () => {
  assert(viewHtml.includes('/api/public/itinerary/'), 'view.html must call secure public itinerary PDF endpoint');
  assert(viewHtml.includes('/pdf'), 'view.html must request PDF stream');
  assert(!viewHtml.includes('html2pdf().set(opt).from(element).save()'), 'view.html must NOT contain duplicate client-side PDF generation');
  assert(viewHtml.includes('downloadOfficialPDF'), 'view.html must define downloadOfficialPDF handler');
});

// 8. Editor html2pdf options standardize A4 margins and multi-page break avoidance
test('PDF export configuration standardizes A4 portrait format and uniform margins [8, 8, 8, 8]', () => {
  assert(scriptJs.includes("format: 'a4'") && scriptJs.includes("orientation: 'portrait'"), 'script.js must specify A4 portrait format');
  assert(scriptJs.includes("margin: [8, 8, 8, 8]"), 'script.js must standardize uniform [8, 8, 8, 8] margins');
});

// 9. Preserves official Campfly bank and UPI details
test('Preserves Campfly Tours LLP bank and UPI details in customer and editor views', () => {
  assert(viewHtml.includes('CAMPFLY TOURS LLP'), 'Must preserve account name');
  assert(viewHtml.includes('10292311723'), 'Must preserve account number');
  assert(viewHtml.includes('IDFB0080511'), 'Must preserve IFSC code');
  assert(viewHtml.includes('Campfly@idfcbank'), 'Must preserve UPI handle');

  assert(scriptJs.includes('CAMPFLY TOURS LLP'), 'script.js must preserve account name');
  assert(scriptJs.includes('10292311723'), 'script.js must preserve account number');
  assert(scriptJs.includes('IDFB0080511'), 'script.js must preserve IFSC code');
  assert(scriptJs.includes('Campfly@idfcbank'), 'script.js must preserve UPI handle');
});

// 10. Customer view NEVER renders internal supplier costs, profit or processing surcharges
test('view.html contains NO internal cost, supplier commission, profit or surcharge fields', () => {
  const sensitivePatterns = [
    'supplier_cost',
    'supplierCost',
    'commission',
    'profit',
    'margin',
    'surcharge',
    'processing_fee_surcharge'
  ];

  sensitivePatterns.forEach(pattern => {
    // Check that there is no DOM element with these IDs or classes in the template
    const idRegex = new RegExp(`id=["'][^"']*${pattern}[^"']*["']`, 'i');
    assert.strictEqual(idRegex.test(viewHtml), false, `view.html must not contain element with id matching ${pattern}`);
  });
});

console.log('\n========================================');
console.log(`SUMMARY: ${passCount} / ${totalCount} PDF layout tests passed.`);
console.log('========================================\n');
