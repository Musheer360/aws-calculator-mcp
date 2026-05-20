const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');
const fs = require('fs');

const NAV_TIMEOUT_MS = 45000;
const BROWSER_TIMEOUT_MS = 90000; // Kill browser after 90s max
let browserLock = null; // Simple mutex — one browser at a time

function findChrome() {
  try { return require('puppeteer').executablePath(); } catch {}
  const paths = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const p of paths) { try { fs.accessSync(p); return p; } catch {} }
  try { return execSync('which google-chrome || which chromium || which chromium-browser', { encoding: 'utf8' }).trim(); } catch {}
  throw new Error('No Chrome/Chromium found. Install puppeteer (`npm i puppeteer`) or install Chrome/Chromium on your system.');
}

async function refreshEstimate(estimateUrl) {
  // Mutex: only one browser instance at a time
  if (browserLock) await browserLock;
  let resolve;
  browserLock = new Promise(r => { resolve = r; });

  const executablePath = findChrome();
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });

  // Hard timeout: kill browser if it hangs
  const killTimer = setTimeout(() => { browser.close().catch(() => {}); }, BROWSER_TIMEOUT_MS);

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    console.error('[refresh] Navigating to', estimateUrl);
    await page.goto(estimateUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    await new Promise(r => setTimeout(r, 5000));

    // Click "Update estimate" button
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find(b => b.textContent.trim().toLowerCase().includes('update estimate'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (clicked) {
      console.error('[refresh] Clicked "Update estimate", waiting for recalculation...');
      await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
    }

    // Scrape data from the page
    const data = await scrapeEstimateData(page);
    console.error(`[refresh] Done: $${data.monthlyCost}/mo, ${data.services.length} services`);
    return { success: true, data, url: estimateUrl };
  } finally {
    clearTimeout(killTimer);
    await browser.close().catch(() => {});
    resolve();
    browserLock = null;
  }
}

function scrapeEstimateData(page) {
  return page.evaluate(() => {
    const result = { name: null, upfrontCost: 0, monthlyCost: 0, totalCost12Months: 0, services: [] };
    const text = document.body.innerText;

    const nameMatch = text.match(/AWS Pricing Calculator\n(.+?)\n/);
    if (nameMatch) result.name = nameMatch[1].trim();

    const monthlyMatch = text.match(/Monthly cost\n([\d,.]+)\s*USD/);
    if (monthlyMatch) result.monthlyCost = parseFloat(monthlyMatch[1].replace(/,/g, ''));
    const upfrontMatch = text.match(/Upfront cost\n([\d,.]+)\s*USD/);
    if (upfrontMatch) result.upfrontCost = parseFloat(upfrontMatch[1].replace(/,/g, ''));
    const totalMatch = text.match(/Total 12 months cost\n([\d,.]+)\s*USD/);
    if (totalMatch) result.totalCost12Months = parseFloat(totalMatch[1].replace(/,/g, ''));

    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      const header = [...(rows[0]?.querySelectorAll('td,th') || [])].map(c => c.textContent.trim());
      const monthlyIdx = header.indexOf('Monthly cost');
      const upfrontIdx = header.indexOf('Upfront cost');
      const nameIdx = header.indexOf('Service Name');
      const descIdx = header.indexOf('Description');
      const regionIdx = header.indexOf('Region');
      const configIdx = header.indexOf('Config Summary');
      if (nameIdx === -1 || monthlyIdx === -1) continue;
      for (let i = 1; i < rows.length; i++) {
        const cells = [...rows[i].querySelectorAll('td')].map(c => c.textContent.trim());
        const name = cells[nameIdx];
        if (!name) continue;
        result.services.push({
          name,
          upfront: upfrontIdx >= 0 ? (parseFloat(cells[upfrontIdx]?.replace(/[^0-9.]/g, '')) || 0) : 0,
          monthly: parseFloat(cells[monthlyIdx]?.replace(/[^0-9.]/g, '')) || 0,
          description: descIdx >= 0 ? (cells[descIdx] || null) : null,
          region: regionIdx >= 0 ? (cells[regionIdx] === '-' ? null : cells[regionIdx]) : null,
          config: configIdx >= 0 ? (cells[configIdx] === '-' ? null : cells[configIdx]) : null,
        });
      }
    }
    return result;
  });
}

module.exports = { refreshEstimate, findChrome };
