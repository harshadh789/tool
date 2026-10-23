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

// 6. QR Code canvas-to-image conversion and asset preloading in script.js
test('script.js prepares QR code assets and waits for image loading before html2pdf export', () => {
  assert(scriptJs.includes('preparePdfAssets'), 'script.js must define preparePdfAssets function');
  assert(scriptJs.includes('toDataURL'), 'script.js must convert canvas to dataURL');
  assert(scriptJs.includes('img.style.width'), 'script.js must set explicit width on QR image');
  assert(scriptJs.includes('img.complete'), 'script.js must verify image completion before export');
  assert(scriptJs.includes('html2pdf().set(opt).from(element).save()'), 'script.js must trigger html2pdf save');
});

// 7. QR Code canvas-to-image conversion and asset preloading in customer view.html
test('view.html prepares QR code assets and awaits image completion before html2pdf export', () => {
  assert(viewHtml.includes('c_upi_qr'), 'view.html must target customer UPI QR code element');
  assert(viewHtml.includes('toDataURL'), 'view.html must convert QR canvas to dataURL');
  assert(viewHtml.includes('img.complete'), 'view.html must wait for images to complete');
  assert(viewHtml.includes('html2pdf().set(opt).from(element).save()'), 'view.html must trigger html2pdf save');
});

// 8. html2pdf options standardize A4 margins and multi-page break avoidance
test('PDF export configuration standardizes A4 portrait format and uniform margins [8, 8, 8, 8]', () => {
  assert(scriptJs.includes("format: 'a4'") && scriptJs.includes("orientation: 'portrait'"));
  assert(scriptJs.includes("margin: [8, 8, 8, 8]"));
  assert(viewHtml.includes("format: 'a4'") && viewHtml.includes("orientation: 'portrait'"));
  assert(viewHtml.includes("margin: [8, 8, 8, 8]"));
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
