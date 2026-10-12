// Diagnostic check: isolated to localhost with mock key; never connects to remote DB
const { createClient } = require('@supabase/supabase-js');
const client = createClient('http://localhost:54321', 'mock-key-local-only');
console.log(client.auth.resend.toString());
console.log(client.auth.resetPasswordForEmail.toString());
