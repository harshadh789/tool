let supabaseClient = null;
let currentSession = null;

async function initAuth() {
    try {
        const res = await fetch('/api/auth/config');
        const config = await res.json();
        
        if (!config.success || !config.url || !config.key) {
            console.error("Supabase not configured on server.");
            return false;
        }

        supabaseClient = supabase.createClient(config.url, config.key);
        
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error) throw error;
        
        if (session) {
            currentSession = session;
            
            // Handle invitation and password setup
            if (window.location.hash.includes('type=invite') || window.location.hash.includes('type=recovery')) {
                setTimeout(async () => {
                    const newPassword = prompt("Please set your new password (minimum 6 characters):");
                    if (newPassword && newPassword.length >= 6) {
                        const { error: updateError } = await supabaseClient.auth.updateUser({ password: newPassword });
                        if (updateError) alert("Error setting password: " + updateError.message);
                        else alert("Password set successfully! You can now log in normally.");
                    } else {
                        alert("Password setup cancelled or invalid. You must set a password to retain access.");
                    }
                    window.location.hash = ''; // Clear hash securely
                }, 500); // slight delay to ensure UI is ready
            }
            
            return true;
        }
        return false;
    } catch (e) {
        console.error("Error initializing auth:", e);
        return false;
    }
}

async function handleLogin() {
    if (!supabaseClient) {
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
        errorEl.innerText = "Please enter both Email and Password.";
        errorEl.style.display = "block";
        return;
    }
    
    const btn = document.querySelector('.auth-btn');
    if(btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...';
    
    const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: email,
        password: password,
    });
    
    if(btn) btn.innerHTML = 'Authenticate & Unlock <i class="fa-solid fa-arrow-right"></i>';
    
    if (error) {
        errorEl.innerText = error.message;
        errorEl.style.display = "block";
    } else {
        currentSession = data.session;
        document.getElementById('auth-overlay').style.opacity = '0';
        setTimeout(() => {
            document.getElementById('auth-overlay').style.display = 'none';
        }, 300);
        if(typeof showToast === 'function') showToast("Access Granted. Welcome!");
        
        // Let the main script know we logged in
        if (typeof onLoginSuccess === 'function') onLoginSuccess();
    }
}

async function handleLogout() {
    if (!supabaseClient) return;
    await supabaseClient.auth.signOut();
    window.location.reload(); 
}

async function fetchWithAuth(url, options = {}) {
    if (!currentSession && supabaseClient) {
        const { data } = await supabaseClient.auth.getSession();
        currentSession = data.session;
    }
    
    if (!currentSession) {
        throw new Error("No active session. Please log in.");
    }
    
    const headers = options.headers || {};
    headers['Authorization'] = `Bearer ${currentSession.access_token}`;
    
    return fetch(url, { ...options, headers });
}
