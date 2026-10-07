const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    await page.goto('http://localhost:3000/');
    
    // Bypass auth
    await page.type('#login_user', 'emp1');
    await page.type('#login_pass', 'password123');
    await page.click('.auth-btn');
    await new Promise(r => setTimeout(r, 1000));
    
    await page.type('#i_quote', 'ZOHO-TEST-FINAL');
    await page.click('#btn_save_cloud');
    
    console.log("Waiting for Zoho WorkDrive...");
    await new Promise(r => setTimeout(r, 5000));
    
    await browser.close();
})();
