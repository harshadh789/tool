// ==============================================================================
// Campfly Browser E2E Auth Session Test
// ==============================================================================
// Tests actual browser behavior with Puppeteer on local Express server:
// 1. Initial unauthenticated load displays login overlay.
// 2. Real user form login: fill credentials & click Authenticate button.
// 3. Supabase Auth SDK receives response, sets storage, triggers onLoginSuccess.
// 4. Subsequent initAuth() in boot() succeeds and editor remains visible.
// 5. Hard refresh keeps user logged in and overlay hidden.
// 6. Navigation to dashboard retains active session.
// 7. Logout clears session, redirects, and displays overlay.
// 8. Reload after logout keeps user logged out.
// ==============================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const app = require('../api/server.js');

let server;
let browser;
const PORT = 3899;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let passedCount = 0;
let totalCount = 0;

function reportPass(description) {
    totalCount++;
    passedCount++;
    console.log(`✅ [PASS] ${totalCount}. ${description}`);
}

async function main() {
    console.log("=== RUNNING BROWSER E2E AUTH SESSION VERIFICATION ===");

    // Inject backend auth dependencies so server verifies the valid test session
    const mockSupabase = {
        auth: {
            getUser: async (token) => {
                if (token === 'auth-test-valid-access-token') {
                    return {
                        data: {
                            user: {
                                id: 'usr-admin-1',
                                email: 'admin@campfly.in'
                            }
                        },
                        error: null
                    };
                }
                return { data: { user: null }, error: new Error('Invalid token') };
            }
        }
    };

    const mockSupabaseAdmin = {
        from: (table) => ({
            select: () => ({
                eq: () => ({
                    single: async () => ({
                        data: { role: 'ADMIN', is_active: true },
                        error: null
                    })
                })
            })
        })
    };
    app.setDependencies(mockSupabase, mockSupabaseAdmin);

    server = app.listen(PORT);
    await new Promise(r => setTimeout(r, 500));

    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    // Intercept network requests to provide a secure mock for Supabase Auth API
    await page.setRequestInterception(true);
    page.on('request', interceptedRequest => {
        const url = interceptedRequest.url();
        if (url.includes('/auth/v1/token')) {
            if (interceptedRequest.method() === 'OPTIONS') {
                interceptedRequest.respond({
                    status: 200,
                    headers: {
                        'access-control-allow-origin': '*',
                        'access-control-allow-methods': 'POST, GET, OPTIONS',
                        'access-control-allow-headers': '*'
                    }
                });
                return;
            }
            if (interceptedRequest.method() === 'POST') {
                const postData = interceptedRequest.postData() || '';
                if (postData.includes('admin%40campfly.in') || postData.includes('admin@campfly.in')) {
                    interceptedRequest.respond({
                        status: 200,
                        contentType: 'application/json',
                        headers: { 'access-control-allow-origin': '*' },
                        body: JSON.stringify({
                            access_token: 'auth-test-valid-access-token',
                            token_type: 'bearer',
                            expires_in: 3600,
                            expires_at: Math.floor(Date.now() / 1000) + 3600,
                            refresh_token: 'auth-test-valid-refresh-token',
                            user: {
                                id: 'usr-admin-1',
                                aud: 'authenticated',
                                role: 'authenticated',
                                email: 'admin@campfly.in',
                                confirmed_at: '2026-10-01T00:00:00Z',
                                app_metadata: { provider: 'email' },
                                user_metadata: {}
                            }
                        })
                    });
                    return;
                }
            }
        }
        interceptedRequest.continue();
    });

    const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '/Users/campfly/.gemini/antigravity-ide/brain/bd31c1b8-269d-4f94-816c-5dc1aab208b0';
    if (!fs.existsSync(ARTIFACTS_DIR)) {
        try { fs.mkdirSync(ARTIFACTS_DIR, { recursive: true }); } catch (e) {}
    }

    try {
        // ----------------------------------------------------------------------
        // Step 1: Open app with no session → login screen appears
        // ----------------------------------------------------------------------
        await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'networkidle2' });

        const unauthOverlay = await page.evaluate(() => {
            const el = document.getElementById('auth-overlay');
            return el ? {
                display: window.getComputedStyle(el).display,
                opacity: window.getComputedStyle(el).opacity
            } : null;
        });
        assert.strictEqual(unauthOverlay.display, 'flex', "Unauthenticated overlay should be display: flex");
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'preview_step1_unauthenticated_overlay.png') });
        reportPass("Initial visit with no session displays login overlay");

        // ----------------------------------------------------------------------
        // Step 2: Sign in via UI form → onLoginSuccess() runs → boot() runs again
        // ----------------------------------------------------------------------
        await page.type('#login_email', 'admin@campfly.in');
        await page.type('#login_pass', 'validPassword123');

        // Click the authenticate button
        await page.click('.auth-btn');

        // Wait for overlay transition to finish
        await page.waitForFunction(() => {
            const el = document.getElementById('auth-overlay');
            return el && window.getComputedStyle(el).display === 'none';
        }, { timeout: 5000 });

        const postLoginState = await page.evaluate(() => {
            const el = document.getElementById('auth-overlay');
            return {
                display: window.getComputedStyle(el).display,
                hasSession: typeof currentSession !== 'undefined' && currentSession !== null,
                userEmail: currentSession?.user?.email || null
            };
        });

        assert.strictEqual(postLoginState.display, 'none', "Overlay must be hidden after successful sign in");
        assert.strictEqual(postLoginState.hasSession, true, "Current session must be active after sign in");
        assert.strictEqual(postLoginState.userEmail, 'admin@campfly.in');
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'preview_step2_authenticated_editor.png') });
        reportPass("UI sign-in succeeds, triggers onLoginSuccess and boot(), editor stays visible without re-prompt");

        // ----------------------------------------------------------------------
        // Step 3: Hard refresh after login → still logged in & overlay hidden
        // ----------------------------------------------------------------------
        await page.reload({ waitUntil: 'networkidle2' });

        const postRefreshState = await page.evaluate(() => {
            const el = document.getElementById('auth-overlay');
            return {
                overlayDisplay: el ? window.getComputedStyle(el).display : null,
                hasSession: typeof currentSession !== 'undefined' && currentSession !== null,
                userEmail: currentSession?.user?.email || null
            };
        });

        assert.strictEqual(postRefreshState.overlayDisplay, 'none', "Overlay must remain hidden after hard refresh");
        assert.strictEqual(postRefreshState.hasSession, true, "Session must be restored after refresh");
        assert.strictEqual(postRefreshState.userEmail, 'admin@campfly.in');
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'preview_step3_hard_refresh_persisted.png') });
        reportPass("Hard refresh restores authenticated session and editor remains visible");

        // ----------------------------------------------------------------------
        // Step 4: Navigate to Dashboard → session remains active & verifies /api/me
        // ----------------------------------------------------------------------
        await page.goto(`${BASE_URL}/dashboard.html`, { waitUntil: 'networkidle2' });
        const dashboardUrl = page.url();
        assert.ok(dashboardUrl.includes('dashboard.html'), "User should stay on dashboard.html without redirect");

        // Wait for dashboard.js to fetch /api/me and update DOM
        await page.waitForFunction(() => {
            const el = document.getElementById('dash_user_role');
            return el && el.innerText.trim() === 'ADMIN';
        }, { timeout: 5000 });

        const dashProfile = await page.evaluate(() => {
            return {
                role: document.getElementById('dash_user_role')?.innerText.trim(),
                email: document.getElementById('dash_user_email')?.innerText.trim(),
                teamNavDisplay: window.getComputedStyle(document.getElementById('nav_team')).display
            };
        });
        assert.strictEqual(dashProfile.role, 'ADMIN', "Backend /api/me must return validated ADMIN role");
        assert.strictEqual(dashProfile.email, 'admin@campfly.in', "Backend /api/me must return user email");
        assert.strictEqual(dashProfile.teamNavDisplay, 'block', "Admin team navigation link must be displayed");
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'preview_step4_dashboard_session_active.png') });
        reportPass("Navigation to Dashboard preserves session and backend /api/me verifies valid test session");

        // ----------------------------------------------------------------------
        // Step 5: Verify distinction: Real backend /api/me rejects invalid token
        // ----------------------------------------------------------------------
        const rejectionCheck = await page.evaluate(async () => {
            const res = await fetch('/api/me', {
                headers: { 'Authorization': 'Bearer invalid-token-forged-999' }
            });
            const body = await res.json().catch(() => ({}));
            return { status: res.status, body };
        });
        assert.strictEqual(rejectionCheck.status, 401, "Backend must reject forged/invalid token with 401");
        assert.strictEqual(rejectionCheck.body.success, false);
        assert.ok(rejectionCheck.body.error.includes('Invalid token'), "Error message must indicate invalid token");
        reportPass("Distinguishes simulated auth from real backend verification: /api/me rejects invalid token");

        // ----------------------------------------------------------------------
        // Step 6: Failed network request does NOT log out user
        // ----------------------------------------------------------------------
        const networkFailureCheck = await page.evaluate(async () => {
            const preSession = typeof currentSession !== 'undefined' && currentSession !== null;
            let caughtExpected = false;
            try {
                // Call an endpoint that returns 404 or 500 via fetchWithAuth
                const res = await fetchWithAuth('/api/non-existent-route-network-test');
                if (res.status === 404) caughtExpected = true;
            } catch (e) {
                caughtExpected = true;
            }
            const postSession = typeof currentSession !== 'undefined' && currentSession !== null;
            const overlay = document.getElementById('auth-overlay');
            const overlayDisplay = overlay ? window.getComputedStyle(overlay).display : 'none';
            return { preSession, postSession, caughtExpected, overlayDisplay };
        });
        assert.strictEqual(networkFailureCheck.preSession, true);
        assert.strictEqual(networkFailureCheck.postSession, true, "Session must NOT be wiped on non-401 failure");
        assert.strictEqual(networkFailureCheck.overlayDisplay, 'none', "Overlay must not appear on non-401 failure");
        reportPass("Failed network/server request does NOT log out user or show login overlay");

        // ----------------------------------------------------------------------
        // Step 7: Logout → redirect to login
        // ----------------------------------------------------------------------
        await page.evaluate(async () => {
            await handleLogout();
        });
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        const postLogoutUrl = page.url();
        assert.ok(postLogoutUrl.includes('index.html'), "Logout redirects to index.html");
        reportPass("Logout clears session and redirects to index.html");

        // ----------------------------------------------------------------------
        // Step 8: Reload after logout → user remains logged out with overlay visible
        // ----------------------------------------------------------------------
        await page.reload({ waitUntil: 'networkidle2' });
        const loggedOutOverlay = await page.evaluate(() => {
            const el = document.getElementById('auth-overlay');
            return el ? {
                display: window.getComputedStyle(el).display,
                hasSession: typeof currentSession !== 'undefined' && currentSession !== null
            } : null;
        });

        assert.strictEqual(loggedOutOverlay.display, 'flex', "Overlay must be visible after logout reload");
        assert.strictEqual(loggedOutOverlay.hasSession, false, "Session must remain null after logout reload");
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'preview_step5_post_logout_overlay.png') });
        reportPass("Reloading after logout keeps user logged out with overlay visible");

        console.log("\n========================================");
        console.log(`SUMMARY: ${passedCount} / ${totalCount} Browser E2E session tests PASSED!`);
        console.log("========================================\n");

    } finally {
        if (browser) await browser.close();
        if (server) server.close();
    }
}

main().catch(err => {
    console.error("Browser E2E test failed:", err);
    if (browser) browser.close();
    if (server) server.close();
    process.exit(1);
});
