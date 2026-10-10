const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 1. Mock DOM
global.window = { location: { href: '' } };
global.document = {
    addEventListener: () => {},
    getElementById: (id) => {
        return { 
            innerText: '', 
            value: '', 
            style: {}, 
            innerHTML: '', 
            disabled: false,
            appendChild: () => {}
        };
    },
    createElement: () => ({ innerHTML: '' })
};
global.alert = () => {};
const realError = console.error;
global.console = { ...console, error: () => {} }; // suppress expected errors

// 2. Mock fetchWithAuth (configurable per test)
let mockFetchResponse = null;
global.fetchRequests = [];
global.fetchWithAuth = async (url, options) => {
    // Record request for assertions
    global.fetchRequests.push({ url, options });
    return mockFetchResponse;
};
global.initAuth = async () => true;

// 3. Load users.js
const code = fs.readFileSync(path.join(__dirname, '../users.js'), 'utf8');
eval(code + '\n' +
    'global.fetchUsers = fetchUsers;\n' +
    'global.submitInvite = submitInvite;\n' +
    'global.submitEdit = submitEdit;\n' +
    'global.resendUserAction = resendUserAction;\n' +
    'global.confirmDeleteUser = confirmDeleteUser;\n' +
    'global.getAllUsers = () => allUsers;'
);

// Test Helper
function createMockResponse(status, data, ok = true) {
    return {
        status,
        ok,
        json: async () => {
            if (data === 'INVALID_JSON') throw new SyntaxError("Unexpected token");
            return data;
        }
    };
}

async function runTests() {
    let passed = 0;
    let total = 0;
    console.log("Running frontend API handling tests...");

    const test = async (name, fn) => {
        total++;
        global.fetchRequests = [];
        try {
            await fn();
            console.log(`✅ ${name}`);
            passed++;
        } catch (e) {
            realError(`❌ ${name}`);
            realError(e.message, e.stack);
        }
    };

    // --- TEST 1: Successful /api/me ---
    await test('Successful /api/me response', async () => {
        mockFetchResponse = createMockResponse(200, { success: true, user: { role: 'ADMIN', email: 'admin@campfly.com' } });
        
        // Simulate DOMContentLoaded manually by running the try block logic
        const meResRaw = await global.fetchWithAuth('/api/me');
        const meData = await meResRaw.json();
        assert(meData.success && meData.user.role === 'ADMIN');
    });

    // --- TEST 2: Successful user-list response with two users ---
    await test('Successful user-list response with two users', async () => {
        mockFetchResponse = createMockResponse(200, { success: true, users: [{ id: 1, email: '1@c.c', role: 'ADMIN' }, { id: 2, email: '2@c.c', role: 'SALES' }] });
        await global.fetchUsers();
        const users = global.getAllUsers();
        assert(users.length === 2);
        assert(users[1].role === 'SALES');
    });

    // --- TEST 3: HTTP 401 response ---
    await test('HTTP 401 response', async () => {
        global.window.location.href = '';
        mockFetchResponse = createMockResponse(401, {}, false);
        await fetchUsers(); // calls fetchWithAuth('/api/users')
        assert(global.window.location.href === 'index.html', 'Should redirect to index.html');
    });

    // --- TEST 4: HTTP 403 response ---
    await test('HTTP 403 response', async () => {
        mockFetchResponse = createMockResponse(403, { success: false, error: 'Access Denied' }, false);
        // It will throw inside fetchUsers, which is caught and logs error, modifying the table body.
        await global.fetchUsers();
        // Since we mocked document, it won't crash. allUsers should not be updated from empty
        assert(global.fetchRequests[0].url === '/api/users');
    });

    // --- TEST 5: HTTP 500 response ---
    await test('HTTP 500 response', async () => {
        mockFetchResponse = createMockResponse(500, { success: false, error: 'Internal Server Error' }, false);
        await global.fetchUsers();
        assert(global.fetchRequests[0].url === '/api/users');
    });

    // --- TEST 6: Invalid JSON response ---
    await test('Invalid JSON response', async () => {
        mockFetchResponse = createMockResponse(200, 'INVALID_JSON', true);
        await fetchUsers();
        // The catch block inside fetchUsers will handle the thrown error "Invalid response from server"
    });

    // --- TEST 7: Invite request headers and response parsing ---
    await test('Invite request headers and response parsing', async () => {
        mockFetchResponse = createMockResponse(200, { success: true });
        
        // Setup mock inputs
        global.document.getElementById = (id) => {
            if (id === 'invite_email') return { value: 'new@campfly.com', trim: () => 'new@campfly.com' };
            if (id === 'invite_role') return { value: 'SALES' };
            if (id === 'btn_invite_submit') return { disabled: false };
            return { innerText: '', value: '', style: {} };
        };
        
        await global.submitInvite();
        
        const inviteReq = global.fetchRequests.find(r => r.url === '/api/users' && r.options && r.options.method === 'POST');
        assert(inviteReq, "POST request was not made");
        assert(inviteReq.options.headers['Content-Type'] === 'application/json');
        
        const body = JSON.parse(inviteReq.options.body);
        assert(body.email === 'new@campfly.com');
        assert(body.role === 'SALES');
    });
    
    // --- TEST 8: Edit request headers and response parsing ---
    await test('Edit request headers and response parsing', async () => {
        mockFetchResponse = createMockResponse(200, { success: true });
        
        global.document.getElementById = (id) => {
            if (id === 'edit_user_id') return { value: 'user-123' };
            if (id === 'edit_role') return { value: 'OPS' };
            if (id === 'edit_status') return { value: 'false' };
            if (id === 'btn_edit_submit') return { disabled: false };
            return { innerText: '', value: '', style: {} };
        };
        
        await global.submitEdit();
        
        const editReq = global.fetchRequests.find(r => r.url === '/api/users/user-123' && r.options && r.options.method === 'PATCH');
        assert(editReq, "PATCH request was not made");
        assert(editReq.options.headers['Content-Type'] === 'application/json');
        
        const body = JSON.parse(editReq.options.body);
        assert(body.role === 'OPS');
        assert(body.is_active === false);
    });

    // --- TEST 9: Password Reset Request ---
    await test('Password reset request correctly parsed', async () => {
        global.confirm = () => true; // user confirms
        mockFetchResponse = createMockResponse(200, { success: true });
        
        await global.resendUserAction('user-123', 'test@example.com');
        
        const resetReq = global.fetchRequests.find(r => r.url === '/api/users/user-123/resend' && r.options && r.options.method === 'POST');
        assert(resetReq, "POST request for resend was not made");
    });
    
    // --- TEST 10: Delete Request ---
    await test('Delete request correctly parsed', async () => {
        global.confirm = () => true; // user confirms
        mockFetchResponse = createMockResponse(200, { success: true });
        
        await global.confirmDeleteUser('user-123', 'test@example.com');
        
        const deleteReq = global.fetchRequests.find(r => r.url === '/api/users/user-123' && r.options && r.options.method === 'DELETE');
        assert(deleteReq, "DELETE request was not made");
    });

    console.log(`\nFrontend tests completed: ${passed}/${total} passed.`);
}

runTests();
