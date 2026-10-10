const { createClient } = require('@supabase/supabase-js');
const client = createClient('http://localhost:54321', 'fakekey');
console.log(client.auth.resend.toString());
console.log(client.auth.resetPasswordForEmail.toString());
