// ==============================================================================
// Campfly UI Button Layout & Responsive Verification Test
// ==============================================================================
const assert = require('assert');
const puppeteer = require('puppeteer');
const app = require('../api/server.js');

const PORT = 3898;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function run() {
    console.log("=== RUNNING UI BUTTON LAYOUT & RESPONSIVE VERIFICATION ===");

    // Mock auth dependencies for Express
    const mockSupabase = {
        auth: {
            getUser: async (token) => {
                if (token === 'valid-test-token') {
                    return { data: { user: { id: 'usr-1', email: 'admin@campfly.in' } }, error: null };
                }
                return { data: { user: null }, error: new Error('Invalid') };
            }
        }
    };
    const mockSupabaseAdmin = {
        from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { role: 'ADMIN', is_active: true }, error: null }) }) }) })
    };
    app.setDependencies(mockSupabase, mockSupabaseAdmin);

    const server = app.listen(PORT);
    await new Promise(r => setTimeout(r, 500));

    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    // Intercept auth network calls
    await page.setRequestInterception(true);
    page.on('request', req => {
        const url = req.url();
        if (url.includes('/auth/v1/token')) {
            if (req.method() === 'OPTIONS') {
                req.respond({
                    status: 200,
                    headers: {
                        'access-control-allow-origin': '*',
                        'access-control-allow-methods': 'POST, GET, OPTIONS',
                        'access-control-allow-headers': '*'
                    }
                });
                return;
            }
            if (req.method() === 'POST') {
                req.respond({
                    status: 200,
                    contentType: 'application/json',
                    headers: { 'access-control-allow-origin': '*' },
                    body: JSON.stringify({
                        access_token: 'valid-test-token',
                        token_type: 'bearer',
                        expires_in: 3600,
                        expires_at: Math.floor(Date.now() / 1000) + 3600,
                        refresh_token: 'valid-refresh-token',
                        user: { id: 'usr-1', aud: 'authenticated', role: 'authenticated', email: 'admin@campfly.in' }
                    })
                });
                return;
            }
        }
        req.continue();
    });

    try {
        await page.goto(BASE_URL, { waitUntil: 'networkidle0' });

        // Sign in to show editor panel
        await page.type('#login_email', 'admin@campfly.in');
        await page.type('#login_pass', 'Password123!');
        await page.click('.auth-btn');
        await page.waitForFunction(() => {
            const overlay = document.getElementById('auth-overlay');
            return overlay && overlay.style.display === 'none';
        }, { timeout: 5000 });

        console.log("✅ Authenticated into Campfly Editor");

        const viewports = [
            { name: 'Desktop Wide (1440x900)', width: 1440, height: 900 },
            { name: 'Standard Laptop (1200x800)', width: 1200, height: 800 },
            { name: 'Narrow Viewport (900x700)', width: 900, height: 700 },
            { name: 'Mobile / Narrow (480x800)', width: 480, height: 800 }
        ];

        for (const vp of viewports) {
            await page.setViewport({ width: vp.width, height: vp.height });
            await new Promise(r => setTimeout(r, 400));

            // Check bounding boxes of buttons vs editor-panel
            const layoutCheck = await page.evaluate(() => {
                const panel = document.querySelector('.editor-panel');
                const panelRect = panel.getBoundingClientRect();

                const buttons = [
                    { id: 'btn_save_cloud', name: 'Save & Get Link' },
                    { id: 'btn_req_ops', name: 'Send Request to Ops' },
                    { id: 'btn_save_draft', name: 'Save Draft' },
                    { selector: '.btn-header-nav', name: 'Dashboard' },
                    { selector: '.btn-header-logout', name: 'Logout' },
                    { selector: '.mode-toggle-compact', name: 'Voucher Mode Toggle' }
                ];

                const results = [];
                for (const b of buttons) {
                    const el = b.id ? document.getElementById(b.id) : document.querySelector(b.selector);
                    if (!el) {
                        results.push({ name: b.name, found: false });
                        continue;
                    }
                    const rect = el.getBoundingClientRect();
                    // Check if clipped at right or left
                    const rightClipped = rect.right > panelRect.right + 2; // small tolerance
                    const leftClipped = rect.left < panelRect.left - 2;
                    results.push({
                        name: b.name,
                        found: true,
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                        rightClipped,
                        leftClipped,
                        visible: rect.width > 0 && rect.height > 0
                    });
                }
                return { panelWidth: Math.round(panelRect.width), results };
            });

            console.log(`\n--- Viewport: ${vp.name} (Panel Width: ${layoutCheck.panelWidth}px) ---`);
            for (const r of layoutCheck.results) {
                assert.ok(r.found, `Button ${r.name} must be present`);
                assert.ok(r.visible, `Button ${r.name} must be visible`);
                assert.ok(!r.rightClipped, `Button ${r.name} must NOT be clipped on right`);
                assert.ok(!r.leftClipped, `Button ${r.name} must NOT be clipped on left`);
                console.log(`  ✅ ${r.name}: ${r.width}x${r.height}px (Clipped: None)`);
            }
        }

        // Test Voucher Mode toggle interaction
        console.log("\n🔵 Verifying Voucher Mode Toggle interaction");
        const initialVoucherChecked = await page.$eval('#i_voucher_mode', el => el.checked);
        assert.strictEqual(initialVoucherChecked, false, "Voucher mode initially unchecked");
        await page.click('.toggle-switch .slider');
        const afterClickChecked = await page.$eval('#i_voucher_mode', el => el.checked);
        assert.strictEqual(afterClickChecked, true, "Voucher mode is now checked");
        // Verify voucher-field visible
        const voucherFieldsVisible = await page.evaluate(() => {
            const fields = document.querySelectorAll('.voucher-field');
            return fields.length > 0 && Array.from(fields).every(f => f.style.display !== 'none');
        });
        assert.ok(voucherFieldsVisible, "Voucher fields are visible when toggle enabled");
        console.log("  ✅ Voucher Mode toggle works and reveals voucher fields");

        // Toggle back to normal
        await page.click('.toggle-switch .slider');
        assert.strictEqual(await page.$eval('#i_voucher_mode', el => el.checked), false);
        console.log("  ✅ Voucher Mode toggles back to normal quote mode");

        // Test Save Draft
        console.log("\n🔵 Verifying Save Draft interaction");
        await page.click('#btn_save_draft');
        await new Promise(r => setTimeout(r, 600));
        console.log("  ✅ Save Draft button clickable without error");

        console.log("\n========================================");
        console.log("SUMMARY: All UI button layout & responsive checks PASSED!");
        console.log("========================================");

    } finally {
        await browser.close();
        server.close();
    }
}

run().catch(err => {
    console.error("❌ Test failed:", err);
    process.exit(1);
});
