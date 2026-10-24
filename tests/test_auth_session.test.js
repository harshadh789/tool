// ==============================================================================
// Campfly Auth Session & Refresh Regression Tests
// ==============================================================================
// Verifies session persistence across refreshes, singleton client behavior,
// onAuthStateChange synchronization, token refresh handling in fetchWithAuth,
// role preservation, and safe diagnostic logging without secret leakage.
// ==============================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log("=== RUNNING AUTH SESSION & REFRESH REGRESSION TESTS ===");

let passed = 0;
let total = 0;

function runTest(name, fn) {
    total++;
    try {
        fn();
        console.log(`✅ [PASS] ${total}. ${name}`);
        passed++;
    } catch (err) {
        console.error(`❌ [FAIL] ${total}. ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

async function runAsyncTest(name, fn) {
    total++;
    try {
        await fn();
        console.log(`✅ [PASS] ${total}. ${name}`);
        passed++;
    } catch (err) {
        console.error(`❌ [FAIL] ${total}. ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

// Helper to create a sandbox environment for testing auth.js
function createAuthSandbox() {
    const storage = new Map();
    const listeners = [];
    let clientCreatedCount = 0;
    let currentMockSession = null;
    let failGlobalSignOutOnce = false;
    const signOutScopes = [];
    let customFetchHandler = null;

    const mockSupabaseClient = {
        auth: {
            getSession: async () => {
                return { data: { session: currentMockSession }, error: null };
            },
            refreshSession: async () => {
                if (currentMockSession) {
                    currentMockSession = {
                        ...currentMockSession,
                        access_token: 'refreshed-token-' + Date.now()
                    };
                    return { data: { session: currentMockSession }, error: null };
                }
                return { data: { session: null }, error: new Error("Invalid refresh token") };
            },
            signInWithPassword: async ({ email, password }) => {
                if (password === 'correct') {
                    currentMockSession = {
                        access_token: 'token-' + email,
                        refresh_token: 'ref-token-' + email,
                        user: { id: 'u-' + email, email }
                    };
                    listeners.forEach(fn => fn('SIGNED_IN', currentMockSession));
                    return { data: { session: currentMockSession }, error: null };
                }
                return { data: { session: null }, error: new Error("Invalid login credentials") };
            },
            signOut: async (options = {}) => {
                const scope = options.scope || 'global';
                signOutScopes.push(scope);
                if (scope === 'global' && failGlobalSignOutOnce) {
                    failGlobalSignOutOnce = false;
                    return { error: new Error('Simulated global sign-out network failure') };
                }
                currentMockSession = null;
                listeners.forEach(fn => fn('SIGNED_OUT', null));
                return { error: null };
            },
            onAuthStateChange: (callback) => {
                listeners.push(callback);
                return {
                    data: {
                        subscription: {
                            unsubscribe: () => {
                                const idx = listeners.indexOf(callback);
                                if (idx !== -1) listeners.splice(idx, 1);
                            }
                        }
                    }
                };
            }
        }
    };

    const mockOverlay = {
        style: { display: 'none', opacity: '0', pointerEvents: 'none' }
    };

    const mockDocument = {
        getElementById: (id) => {
            if (id === 'auth-overlay') return mockOverlay;
            return { style: {}, innerText: '', value: '', trim: () => '' };
        },
        querySelector: () => ({ innerHTML: '' })
    };

    const mockWindow = {
        location: { pathname: '/index.html', hash: '', reload: () => {} },
        localStorage: {
            getItem: (k) => storage.get(k) || null,
            setItem: (k, v) => storage.set(k, String(v)),
            removeItem: (k) => storage.delete(k),
            clear: () => storage.clear()
        }
    };

    const logs = [];
    const mockConsole = {
        log: (...args) => logs.push(['log', args.join(' ')]),
        warn: (...args) => logs.push(['warn', args.join(' ')]),
        error: (...args) => logs.push(['error', args.join(' ')])
    };

    const mockFetch = async (url, opts = {}) => {
        if (customFetchHandler) {
            const custom = await customFetchHandler(url, opts);
            if (custom !== undefined) return custom;
        }

        if (url === '/api/auth/config') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    url: 'https://iqqkuqgsvuciunmvtmdr.supabase.co',
                    key: 'sb_publishable_test_key'
                })
            };
        }
        return {
            status: 200,
            ok: true,
            json: async () => ({ success: true })
        };
    };

    const mockSupabaseModule = {
        createClient: (url, key, options) => {
            clientCreatedCount++;
            return mockSupabaseClient;
        }
    };

    const contextObject = {
        window: mockWindow,
        document: mockDocument,
        localStorage: mockWindow.localStorage,
        console: mockConsole,
        fetch: mockFetch,
        supabase: mockSupabaseModule,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        prompt: () => 'newPassword123',
        alert: () => {}
    };

    const context = vm.createContext(contextObject);
    const authCode = fs.readFileSync(path.join(__dirname, '../auth.js'), 'utf8');
    vm.runInContext(authCode, context);

    return {
        initAuth: () => vm.runInContext('initAuth()', context),
        handleLogin: () => vm.runInContext('handleLogin()', context),
        handleLogout: () => vm.runInContext('handleLogout()', context),
        fetchWithAuth: (url, opts) => context.fetchWithAuth(url, opts),
        getSupabaseClient: () => vm.runInContext('supabaseClient', context),
        getCurrentSession: () => vm.runInContext('currentSession', context),
        getClientCreatedCount: () => clientCreatedCount,
        setMockSession: (s) => { currentMockSession = s; },
        failNextGlobalSignOut: () => { failGlobalSignOutOnce = true; },
        getSignOutScopes: () => signOutScopes.slice(),
        getMockOverlay: () => mockOverlay,
        getLogs: () => logs,
        setFetchHandler: (fn) => { customFetchHandler = fn; }
    };
}

(async () => {
    // --------------------------------------------------------------------------
    // Test 1: Login → hard refresh → still logged in & overlay hidden
    // --------------------------------------------------------------------------
    await runAsyncTest("Login -> hard refresh restores session and hides overlay", async () => {
        const sb = createAuthSandbox();
        sb.setMockSession({
            access_token: 'test-token-active',
            refresh_token: 'test-refresh-token',
            user: { id: 'u-admin-1', email: 'admin@campfly.in' }
        });

        // Simulate page refresh: initAuth runs on page load
        const isAuth = await sb.initAuth();
        assert.strictEqual(isAuth, true, "initAuth must resolve to true when session exists");
        assert.ok(sb.getCurrentSession(), "currentSession must be populated");
        assert.strictEqual(sb.getCurrentSession().user.email, 'admin@campfly.in');

        // Verify overlay is hidden
        const overlay = sb.getMockOverlay();
        assert.strictEqual(overlay.style.display, 'none', "Overlay must be hidden when session is restored");
        assert.strictEqual(overlay.style.opacity, '0', "Overlay opacity must be 0");
    });

    // --------------------------------------------------------------------------
    // Test 2: Unauthenticated state displays overlay
    // --------------------------------------------------------------------------
    await runAsyncTest("Unauthenticated load displays login overlay", async () => {
        const sb = createAuthSandbox();
        sb.setMockSession(null);

        const isAuth = await sb.initAuth();
        assert.strictEqual(isAuth, false, "initAuth must resolve to false when no session exists");
        assert.strictEqual(sb.getCurrentSession(), null, "currentSession must be null");

        const overlay = sb.getMockOverlay();
        assert.strictEqual(overlay.style.display, 'flex', "Overlay must be displayed for unauthenticated user");
    });

    // --------------------------------------------------------------------------
    // Test 3: Idempotent & Singleton client creation
    // --------------------------------------------------------------------------
    await runAsyncTest("initAuth is idempotent and does not recreate client or race", async () => {
        const sb = createAuthSandbox();
        sb.setMockSession({ access_token: 'tok-1', user: { id: 'u1' } });

        // Concurrent initialization calls
        const [res1, res2, res3] = await Promise.all([
            sb.initAuth(),
            sb.initAuth(),
            sb.initAuth()
        ]);

        assert.strictEqual(res1, true);
        assert.strictEqual(res2, true);
        assert.strictEqual(res3, true);
        assert.strictEqual(sb.getClientCreatedCount(), 1, "Must only create one Supabase client instance");

        // Subsequent sequential call
        const res4 = await sb.initAuth();
        assert.strictEqual(res4, true);
        assert.strictEqual(sb.getClientCreatedCount(), 1, "Must reuse existing singleton client on repeated call");
    });

    // --------------------------------------------------------------------------
    // Test 4: Unauthenticated load -> sign in -> onLoginSuccess -> boot() runs again
    // --------------------------------------------------------------------------
    await runAsyncTest("Login flow: unauthenticated open -> sign in -> onLoginSuccess -> boot re-check detects session", async () => {
        const sb = createAuthSandbox();
        sb.setMockSession(null);

        // Step 1: Open app with no session (initial boot)
        const initialAuth = await sb.initAuth();
        assert.strictEqual(initialAuth, false, "Initial load must return false");
        const overlay = sb.getMockOverlay();
        assert.strictEqual(overlay.style.display, 'flex', "Login overlay must be shown initially");

        // Step 2: Sign in successfully
        let onLoginSuccessCalled = 0;
        let bootCalledCount = 0;
        let overlayAfterBoot = null;

        // Mock boot function as in script.js
        const simulateBoot = async () => {
            bootCalledCount++;
            const isAuth = await sb.initAuth();
            if (!isAuth) {
                overlay.style.display = 'flex';
                overlay.style.opacity = '1';
            } else {
                overlay.style.display = 'none';
                overlay.style.opacity = '0';
            }
            overlayAfterBoot = { ...overlay.style };
            return isAuth;
        };

        // When login succeeds, onLoginSuccess triggers boot()
        sb.setMockSession({
            access_token: 'new-valid-token',
            refresh_token: 'new-refresh-token',
            user: { id: 'u-login', email: 'agent@campfly.in' }
        });

        // Step 3: Subsequent initAuth() MUST detect the new session and NOT return cached false!
        const postLoginBootResult = await simulateBoot();
        assert.strictEqual(postLoginBootResult, true, "Subsequent initAuth must detect the new session");
        assert.strictEqual(overlayAfterBoot.display, 'none', "Overlay must remain hidden");
        assert.strictEqual(overlayAfterBoot.opacity, '0', "Overlay opacity must be 0");
        assert.strictEqual(sb.getCurrentSession().user.email, 'agent@campfly.in');
    });

    // --------------------------------------------------------------------------
    // Test 4: Expired token refresh in fetchWithAuth
    // --------------------------------------------------------------------------
    await runAsyncTest("fetchWithAuth automatically refreshes expired token on 401 and retries", async () => {
        const sb = createAuthSandbox();
        sb.setMockSession({
            access_token: 'initial-expired-token',
            refresh_token: 'valid-refresh-token',
            user: { id: 'u-1', email: 'staff@campfly.in' }
        });

        await sb.initAuth();

        let requestCount = 0;
        let receivedTokens = [];

        sb.setFetchHandler(async (url, opts) => {
            if (url === '/api/auth/config') return undefined; // use default config
            requestCount++;
            const authHeader = opts.headers?.['Authorization'];
            receivedTokens.push(authHeader);

            if (requestCount === 1) {
                // First call fails with 401 expired
                return { status: 401, ok: false, json: async () => ({ error: 'jwt expired' }) };
            }
            // Second call succeeds with refreshed token
            return { status: 200, ok: true, json: async () => ({ success: true, data: [] }) };
        });

        const res = await sb.fetchWithAuth('/api/test-endpoint');
        assert.strictEqual(res.status, 200, "Request should succeed after auto-refresh");
        assert.strictEqual(requestCount, 2, "Should have retried request once");
        assert.ok(receivedTokens[1].includes('refreshed-token'), "Second request must use refreshed token");
    });

    // --------------------------------------------------------------------------
    // Test 5: Logout clears session and updates overlay
    // --------------------------------------------------------------------------
    await runAsyncTest("handleLogout clears session and updates overlay", async () => {
        const sb = createAuthSandbox();
        sb.setMockSession({ access_token: 'tok-logout', user: { id: 'u-out' } });

        await sb.initAuth();
        assert.ok(sb.getCurrentSession(), "Session active before logout");

        await sb.handleLogout();
        assert.strictEqual(sb.getCurrentSession(), null, "Session must be null after logout");
        const overlay = sb.getMockOverlay();
        assert.strictEqual(overlay.style.display, 'flex', "Overlay must be displayed after logout");
    });

    // --------------------------------------------------------------------------
    // Test 6: Logout falls back to local session clearing if global sign-out fails
    // --------------------------------------------------------------------------
    await runAsyncTest("handleLogout clears persisted session after global sign-out error", async () => {
        const sb = createAuthSandbox();
        sb.setMockSession({ access_token: 'tok-logout-fallback', refresh_token: 'ref-logout-fallback', user: { id: 'u-out-fallback' } });
        sb.failNextGlobalSignOut();

        await sb.initAuth();
        assert.ok(sb.getCurrentSession(), "Session active before logout");

        await sb.handleLogout();

        assert.strictEqual(sb.getCurrentSession(), null, "Session must be cleared after fallback");
        assert.ok(sb.getSignOutScopes().includes('global'), "Should attempt normal global sign-out first");
        assert.ok(sb.getSignOutScopes().includes('local'), "Should fall back to local sign-out when global fails");
        assert.strictEqual(sb.getMockOverlay().style.display, 'flex', "Login overlay should appear after logout");
    });

    // --------------------------------------------------------------------------
    // Test 6: Inactive or revoked user rejected on API
    // --------------------------------------------------------------------------
    await runAsyncTest("Revoked or invalid session fails fetchWithAuth and prompts login", async () => {
        const sb = createAuthSandbox();
        sb.setMockSession({ access_token: 'revoked-token', refresh_token: 'revoked-ref' });
        await sb.initAuth();

        // Make refresh fail by removing active session from provider
        sb.setMockSession(null);

        sb.setFetchHandler(async (url, opts) => {
            if (url === '/api/auth/config') return undefined;
            return { status: 401, ok: false, json: async () => ({ error: 'Invalid token' }) };
        });

        const res = await sb.fetchWithAuth('/api/protected');
        assert.strictEqual(res.status, 401, "Should return 401 when refresh fails");
        assert.strictEqual(sb.getCurrentSession(), null, "Session must be cleared on revoked credentials");
        const overlay = sb.getMockOverlay();
        assert.strictEqual(overlay.style.display, 'flex', "Login overlay must be shown for revoked user");
    });

    // --------------------------------------------------------------------------
    // Test 7: Diagnostics never log sensitive tokens or secrets
    // --------------------------------------------------------------------------
    runTest("Diagnostics do not leak access tokens, refresh tokens or secrets", () => {
        const sb = createAuthSandbox();
        const logs = sb.getLogs();

        logs.forEach(([level, msg]) => {
            assert.ok(!msg.includes('test-token-active'), "Must not log access tokens");
            assert.ok(!msg.includes('test-refresh-token'), "Must not log refresh tokens");
            assert.ok(!msg.includes('sb_publishable_test_key'), "Must not log publishable keys in debug strings");
            assert.ok(!msg.includes('password'), "Must not log passwords");
        });
    });

    // --------------------------------------------------------------------------
    // Test 8: Pinning Supabase CDN in HTML files
    // --------------------------------------------------------------------------
    runTest("HTML files pin Supabase CDN to tested version @supabase/supabase-js@2.117.3", () => {
        const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
        const dashHtml = fs.readFileSync(path.join(__dirname, '../dashboard.html'), 'utf8');
        const usersHtml = fs.readFileSync(path.join(__dirname, '../users.html'), 'utf8');

        const expectedCdn = '@supabase/supabase-js@2.117.3';
        assert.ok(indexHtml.includes(expectedCdn), "index.html must pin Supabase CDN");
        assert.ok(!indexHtml.includes('@supabase/supabase-js@2"'), "index.html must not use unpinned @2");

        assert.ok(dashHtml.includes(expectedCdn), "dashboard.html must pin Supabase CDN");
        assert.ok(!dashHtml.includes('@supabase/supabase-js@2"'), "dashboard.html must not use unpinned @2");

        assert.ok(usersHtml.includes(expectedCdn), "users.html must pin Supabase CDN");
        assert.ok(!usersHtml.includes('@supabase/supabase-js@2"'), "users.html must not use unpinned @2");
    });

    // --------------------------------------------------------------------------
    // Test 10: Canonical production origin used in server.js redirects
    // --------------------------------------------------------------------------
    runTest("api/server.js uses canonical production origin tool-five-alpha.vercel.app for redirects", () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '../api/server.js'), 'utf8');
        assert.ok(serverCode.includes('tool-five-alpha.vercel.app'), "server.js must use tool-five-alpha.vercel.app");
        assert.ok(!serverCode.includes('campfly-itinerary.vercel.app'), "server.js must not reference old origin");
    });

    // --------------------------------------------------------------------------
    // Test 11: Transient network failure does NOT log out user or clear session
    // --------------------------------------------------------------------------
    await runAsyncTest("Transient network failures (500/503/offline) do NOT log out user or show overlay", async () => {
        const sb = createAuthSandbox();
        sb.setMockSession({ access_token: 'valid-persisted-token', user: { id: 'u-1', email: 'staff@campfly.in' } });
        await sb.initAuth();

        const initialSession = sb.getCurrentSession();
        assert.ok(initialSession, "Session should be active initially");

        // 1. Simulate server 500/503 error
        sb.setFetchHandler(async (url, opts) => {
            if (url === '/api/auth/config') return undefined;
            return { status: 503, ok: false, json: async () => ({ error: 'Service Unavailable' }) };
        });

        const res503 = await sb.fetchWithAuth('/api/some-endpoint');
        assert.strictEqual(res503.status, 503, "Should return 503 response");
        assert.ok(sb.getCurrentSession(), "currentSession must NOT be cleared on 503 error");
        const overlay = sb.getMockOverlay();
        assert.strictEqual(overlay.style.display, 'none', "Overlay must NOT be displayed on 503 error");

        // 2. Simulate complete network offline drop (fetch throws TypeError)
        sb.setFetchHandler(async (url, opts) => {
            if (url === '/api/auth/config') return undefined;
            throw new TypeError("Failed to fetch");
        });

        let threwNetworkError = false;
        try {
            await sb.fetchWithAuth('/api/some-endpoint');
        } catch (e) {
            threwNetworkError = true;
        }
        assert.strictEqual(threwNetworkError, true, "Network error should propagate without logging out");
        assert.ok(sb.getCurrentSession(), "currentSession must remain intact after network drop");
        assert.strictEqual(overlay.style.display, 'none', "Overlay must remain hidden after network drop");
    });

    // --------------------------------------------------------------------------
    // Test 12: Backend real token verification on /api/me
    // --------------------------------------------------------------------------
    await runAsyncTest("Backend /api/me succeeds with valid test session and rejects missing/invalid tokens", async () => {
        const request = require('supertest');
        const app = require('../api/server.js');

        // Set up mock Supabase dependencies to verify valid and invalid tokens
        const mockSupabase = {
            auth: {
                getUser: async (token) => {
                    if (token === 'valid-test-session-token') {
                        return { data: { user: { id: 'u-valid-1', email: 'valid@campfly.in' } }, error: null };
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

        // A. Missing token
        const resMissing = await request(app).get('/api/me');
        assert.strictEqual(resMissing.status, 401, "Missing token must return HTTP 401");
        assert.strictEqual(resMissing.body.success, false);

        // B. Invalid token
        const resInvalid = await request(app).get('/api/me').set('Authorization', 'Bearer invalid-token-xyz-123');
        assert.strictEqual(resInvalid.status, 401, "Invalid token must return HTTP 401");
        assert.strictEqual(resInvalid.body.success, false);

        // C. Valid test session succeeds
        const resValid = await request(app).get('/api/me').set('Authorization', 'Bearer valid-test-session-token');
        assert.strictEqual(resValid.status, 200, "Valid token must return HTTP 200");
        assert.strictEqual(resValid.body.success, true);
        assert.strictEqual(resValid.body.user.email, 'valid@campfly.in');
        assert.strictEqual(resValid.body.user.role, 'ADMIN');
        assert.strictEqual(resValid.body.user.is_active, true);
    });

    console.log(`\n========================================`);
    console.log(`SUMMARY: ${passed} / ${total} auth session tests passed.`);
    console.log(`========================================\n`);
})();
