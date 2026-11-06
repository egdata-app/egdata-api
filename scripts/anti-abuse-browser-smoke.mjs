import { pathToFileURL } from "node:url";
const base = new URL(process.argv[2]);
if (base.hostname !== "127.0.0.1" || base.protocol !== "http:") throw new Error("Use the isolated loopback staging harness URL");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage();
  await page.goto(base.href);
  console.log(JSON.stringify(await page.evaluate(() => window.runChecks())));
} finally { await browser.close(); }
