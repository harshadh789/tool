const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
    const downloadPath = path.resolve(__dirname, 'downloads');
    if (!fs.existsSync(downloadPath)){
        fs.mkdirSync(downloadPath);
    }
    
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath,
    });
    
    await page.goto("http://localhost:8080/");
    
    await page.type("#login_user", "emp1");
    await page.type("#login_pass", "123");
    
    // Call the function directly to login
    await page.evaluate(() => { handleLogin(); });
    await new Promise(r => setTimeout(r, 1500));
    
    console.log("Triggering PDF Generation...");
    await page.evaluate(() => { generatePDF(); });
    
    console.log("Waiting for download...");
    await new Promise(r => setTimeout(r, 5000));
    
    const files = fs.readdirSync(downloadPath);
    console.log("Downloaded files:", files);
    
    if (files.length > 0) {
        const filePath = path.join(downloadPath, files[0]);
        const stats = fs.statSync(filePath);
        console.log("File size:", stats.size, "bytes");
        // read first few bytes to check if it's a valid PDF
        const buffer = fs.readFileSync(filePath);
        console.log("File header:", buffer.toString('utf8', 0, 10));
    }
    
    await browser.close();
})();
