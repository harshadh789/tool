import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        await page.goto("http://localhost:8080/")
        
        # Login
        await page.fill("#login_user", "emp1")
        await page.fill("#login_pass", "123")
        await page.click("button:has-text('Authenticate & Unlock')")
        
        # Wait for overlay to disappear
        await page.wait_for_timeout(1000)
        
        # Click download and wait for download
        async with page.expect_download() as download_info:
            await page.click("button:has-text('Download Infinite PDF')")
        download = await download_info.value
        
        path = await download.path()
        print(f"Downloaded to {path}")
        
        # Save to a known location
        await download.save_as("test_downloaded.pdf")
        
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
