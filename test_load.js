const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    
    // Visit the specific quote URL we saved earlier
    await page.goto('http://localhost:3000/?id=ZOHO-TEST-FINAL');
    
    // Bypass auth
    await page.type('#login_user', 'emp1');
    await page.type('#login_pass', 'password123');
    await page.click('.auth-btn');
    
    console.log("Waiting for data to load from WorkDrive...");
    await new Promise(r => setTimeout(r, 4000));
    
    // Check if the Quote ID field was populated automatically from DB
    const loadedQuote = await page.$eval('#i_quote', el => el.value);
    console.log("Loaded Quote ID from DB:", loadedQuote);
    
    if (loadedQuote === 'ZOHO-TEST-FINAL') {
        console.log("SUCCESS: Data successfully fetched from Zoho WorkDrive DB!");
    } else {
        console.log("ERROR: Data was not loaded.");
    }
    
    await browser.close();
})();
