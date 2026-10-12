require('dotenv').config();
const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    await page.goto('http://localhost:3000/');
    
    // Bypass auth
    const testUser = process.env.TEST_USER_NAME || process.env.TEST_USER_EMAIL || 'emp1';
    const testPass = process.env.TEST_USER_PASSWORD || '';
    await page.type('#login_user', testUser);
    await page.type('#login_pass', testPass);
    await page.click('.auth-btn');
    await new Promise(r => setTimeout(r, 1000));
    
    await page.type('#i_quote', 'ZOHO-TEST-FINAL');
    await page.click('#btn_save_cloud');
    
    console.log("Waiting for Zoho WorkDrive...");
    await new Promise(r => setTimeout(r, 5000));
    
    await browser.close();
})();
