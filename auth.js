// ==============================================================================
// Campfly Authentication Module
// ==============================================================================
// Singleton Supabase browser client with persistent session handling,
// automatic token refresh, onAuthStateChange synchronization, and safe retry.
// Separates client initialization latch from per-call session inspection.
// ==============================================================================

let supabaseClient = null;
let currentSession = null;
let clientInitPromise = null;
let authStateSubscription = null;
let authStorageKey = null;
let lastLoginHandledAt = 0;

/**
 * Safely updates the authentication overlay UI.
 * Never exposes tokens or secrets.
 */
function updateAuthUI(isAuthenticated) {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('auth-overlay');
    if (!overlay) return;

    if (isAuthenticated) {
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 200);
    } else {
        overlay.style.display = 'flex';
        overlay.style.pointerEvents = 'auto';
        setTimeout(() => {
            overlay.style.opacity = '1';
        }, 10);
    }
}

/**
 * Ensures a single shared Supabase client instance exists.
 * Prevents concurrent client creation races while never caching session state.
 */
async function getOrInitSupabaseClient() {
    if (supabaseClient) {
        return supabaseClient;
    }

    if (clientInitPromise) {
        return clientInitPromise;
    }

    clientInitPromise = (async () => {
        try {
            const res = await fetch('/api/auth/config');
            const config = await res.json();
            
            if (!config.success || !config.url || !config.key) {
                console.error("[Auth] Supabase configuration missing or invalid from backend.");
                return null;
            }

            if (typeof supabase === 'undefined' || !supabase.createClient) {
                console.error("[Auth] Supabase client library not loaded.");
                return null;
            }

            // Match Supabase JS's default localStorage key so logout can verify and
            // clear this project's persisted session if the Auth API is unreachable.
            const projectRef = new URL(config.url).hostname.split('.')[0];
            authStorageKey = `sb-${projectRef}-auth-token`;

            // Explicitly configure supported browser authentication options
            supabaseClient = supabase.createClient(config.url, config.key, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true,
                    storage: typeof window !== 'undefined' ? window.localStorage : undefined
                }
            });

            // Subscribe to auth state changes to keep currentSession synchronized
            if (!authStateSubscription && supabaseClient.auth?.onAuthStateChange) {
                const { data } = supabaseClient.auth.onAuthStateChange((event, session) => {
                    console.log('[Auth] Auth state change event:', event, '| session active:', !!session);
                    currentSession = session || null;
                    if (session) {
                        updateAuthUI(true);
                        const now = Date.now();
                        if (event === 'SIGNED_IN' && now - lastLoginHandledAt > 1000) {
                            lastLoginHandledAt = now;
                            if (typeof onLoginSuccess === 'function') {
                                onLoginSuccess();
                            }
                        }
                    } else if (event === 'SIGNED_OUT') {
                        updateAuthUI(false);
                        if (typeof onLogoutSuccess === 'function') {
                            onLogoutSuccess();
                        }
                    }
                });
                if (data && data.subscription) {
                    authStateSubscription = data.subscription;
                }
            }

            return supabaseClient;
        } catch (e) {
            console.error("[Auth] Failed to initialize Supabase client:", e.message || e);
            return null;
        } finally {
            clientInitPromise = null;
        }
    })();

    return clientInitPromise;
}

/**
 * Initializes authentication and always retrieves the freshest session state.
 * Never permanently caches an initial unauthenticated result.
 * Safe to call repeatedly before or after login.
 */
async function initAuth() {
    const client = await getOrInitSupabaseClient();
    if (!client) {
        currentSession = null;
        updateAuthUI(false);
        return false;
    }

    try {
        // Always query client.auth.getSession() for the latest live state
        const { data: { session }, error } = await client.auth.getSession();
        if (error) {
            console.error("[Auth] Error restoring session:", error.message);
            currentSession = null;
            updateAuthUI(false);
            return false;
        }
        
        if (session) {
            currentSession = session;
            updateAuthUI(true);
            
            // Handle invitation and password setup
            if (typeof window !== 'undefined' && window.location.hash) {
                if (window.location.hash.includes('type=invite') || window.location.hash.includes('type=recovery')) {
                    setTimeout(async () => {
                        const newPassword = prompt("Please set your new password (minimum 6 characters):");
                        if (newPassword && newPassword.length >= 6) {
                            const { error: updateError } = await client.auth.updateUser({ password: newPassword });
                            if (updateError) alert("Error setting password: " + updateError.message);
                            else alert("Password set successfully! You can now log in normally.");
                        } else {
                            alert("Password setup cancelled or invalid. You must set a password to retain access.");
                        }
                        window.location.hash = ''; // Clear hash securely
                    }, 500);
                }
            }
            
            return true;
        }

        currentSession = null;
        updateAuthUI(false);
        return false;
    } catch (e) {
        console.error("[Auth] Error checking authentication session:", e.message || "Unknown error");
        currentSession = null;
        updateAuthUI(false);
        return false;
    }
}

/**
 * Handles user login from the auth overlay form.
 */
async function handleLogin() {
    const client = await getOrInitSupabaseClient();
    if (!client) {
        alert("Authentication is not configured on the server. Please check backend setup.");
        return;
    }
    
    const emailEl = document.getElementById('login_email');
    const passEl = document.getElementById('login_pass');
    if (!emailEl || !passEl) return;
    
    const email = emailEl.value.trim();
    const password = passEl.value.trim();
    const errorEl = document.getElementById('login_error');
    
    if (!email || !password) {
        if (errorEl) {
            errorEl.innerText = "Please enter both Email and Password.";
            errorEl.style.display = "block";
        }
        return;
    }
    
    const btn = document.querySelector('.auth-btn');
    if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...';
    
    const { data, error } = await client.auth.signInWithPassword({
        email: email,
        password: password,
    });
    
    if (btn) btn.innerHTML = 'Authenticate & Unlock <i class="fa-solid fa-arrow-right"></i>';
    
    if (error) {
        if (errorEl) {
            errorEl.innerText = error.message;
            errorEl.style.display = "block";
        }
    } else {
        currentSession = data.session;
        if (errorEl) errorEl.style.display = "none";
        updateAuthUI(true);
        if (typeof showToast === 'function') showToast("Access Granted. Welcome!");
        
        lastLoginHandledAt = Date.now();
        // Let the main script know we logged in
        if (typeof onLoginSuccess === 'function') onLoginSuccess();
    }
}

/**
 * Signs out the current user, clears the local session, and prompts login.
 */
async function handleLogout() {
    const client = await getOrInitSupabaseClient();
    let sessionCleared = false;
    let globalSignOutFailed = false;

    if (client) {
        // First attempt a full server-side sign-out (the Supabase default).
        // Inspect the returned error: Supabase commonly returns { error } rather
        // than throwing, so ignoring this value can leave localStorage intact.
        try {
            const { error } = await client.auth.signOut();
            if (error) {
                globalSignOutFailed = true;
                console.warn("[Auth] Global sign-out was not confirmed:", error.message);
            }
        } catch (e) {
            globalSignOutFailed = true;
            console.warn("[Auth] Global sign-out request failed:", e.message || e);
        }

        // Verify persisted session state. If global sign-out failed or left the
        // session behind, make a local sign-out attempt so this browser exits.
        try {
            const beforeVerify = await client.auth.getSession();
            if (beforeVerify.error || beforeVerify.data?.session) {
                const { error: localError } = await client.auth.signOut({ scope: 'local' });
                if (localError) throw localError;
            }

            const verify = await client.auth.getSession();
            if (verify.error) throw verify.error;
            sessionCleared = !verify.data?.session;
        } catch (e) {
            console.warn("[Auth] SDK local sign-out verification failed:", e.message || e);
        }
    }

    // Last-resort local cleanup only for this Supabase project's auth entry.
    // Do not clear all localStorage keys or touch unrelated application data.
    if (!sessionCleared && authStorageKey && typeof window !== 'undefined' && window.localStorage) {
        try {
            window.localStorage.removeItem(authStorageKey);
            sessionCleared = window.localStorage.getItem(authStorageKey) === null;
            if (!sessionCleared) {
                console.error("[Auth] Persisted session could not be removed.");
            }
        } catch (e) {
            console.error("[Auth] Local session cleanup failed:", e.message || e);
        }
    }

    if (!sessionCleared) {
        alert("Logout could not clear the saved session. Please check your connection and try again.");
        return;
    }

    currentSession = null;
    updateAuthUI(false);

    if (globalSignOutFailed && typeof alert === 'function') {
        alert("You are signed out on this browser. Campfly could not confirm sign-out from all sessions, so other devices may remain signed in until their sessions expire.");
    }

    if (typeof window !== 'undefined') {
        if (!window.location.pathname.endsWith('index.html') && window.location.pathname !== '/') {
            window.location.href = 'index.html';
        } else {
            window.location.reload();
        }
    }
}

/**
 * Authenticated fetch helper.
 * Automatically obtains the latest valid session, attaches the bearer token,
 * and refreshes token if the backend returns a 401 challenge.
 */
async function fetchWithAuth(url, options = {}) {
    const client = await getOrInitSupabaseClient();
    
    // Always request the freshest session (getSession automatically refreshes expired sessions)
    if (client) {
        try {
            const { data, error } = await client.auth.getSession();
            if (!error && data?.session) {
                currentSession = data.session;
            }
        } catch (e) {
            console.warn("[Auth] getSession warning in fetchWithAuth:", e.message);
        }
    }
    
    if (!currentSession || !currentSession.access_token) {
        updateAuthUI(false);
        throw new Error("No active session. Please log in.");
    }
    
    const headers = { ...(options.headers || {}) };
    headers['Authorization'] = `Bearer ${currentSession.access_token}`;
    
    let response = await fetch(url, { ...options, headers });

    // Handle token expiration / 401 gracefully with single token refresh attempt
    if (response.status === 401 && client) {
        console.warn("[Auth] Received 401 from API. Attempting token refresh...");
        try {
            const { data: refreshData, error: refreshError } = await client.auth.refreshSession();
            if (!refreshError && refreshData?.session) {
                currentSession = refreshData.session;
                const retryHeaders = { ...(options.headers || {}) };
                retryHeaders['Authorization'] = `Bearer ${currentSession.access_token}`;
                response = await fetch(url, { ...options, headers: retryHeaders });
            } else {
                console.warn("[Auth] Session refresh unsuccessful after 401. Re-authenticating.");
                currentSession = null;
                updateAuthUI(false);
            }
        } catch (refreshErr) {
            console.warn("[Auth] Token refresh error:", refreshErr.message);
            currentSession = null;
            updateAuthUI(false);
        }
    }
    
    return response;
}
