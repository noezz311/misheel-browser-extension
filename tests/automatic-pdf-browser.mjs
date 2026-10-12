import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright"); }
catch { playwright = require(path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright")); }
const { chromium } = playwright;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "artifacts");
const sourceFile = path.join(root, "tests", "fixtures", "korean-selectable.pdf");
const sourcePdf = await readFile(sourceFile);
const html = "<!doctype html><meta charset='utf-8'><title>Ordinary Korean HTML</title><p id='school'>학교</p>";
const server = createServer((request, response) => {
  if (["/sample.pdf", "/document", "/sample.PDF"].includes(request.url)) {
    response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": sourcePdf.length }); response.end(sourcePdf);
  } else if (request.url === "/html.pdf") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html);
  } else if (request.url === "/embedded.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(`${html}<iframe src='/sample.pdf' width='600' height='700'></iframe>`);
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const reports = [], externalRequests = [], pageErrors = [], navigationEvents = [];
let context, worker, browserVersion = "";

async function test(name, fn) {
  try { await fn(); reports.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { reports.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  await mkdir(artifacts, { recursive: true });
  const bundled = chromium.executablePath();
  const executablePath = process.env.BROWSER_EXECUTABLE || (require("node:fs").existsSync(bundled) ? bundled : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  context = await chromium.launchPersistentContext(path.join(root, ".work", `automatic-pdf-${Date.now()}`), {
    executablePath, headless: true, viewport: { width: 1100, height: 900 },
    ignoreDefaultArgs: ["--disable-extensions"], args: [`--load-extension=${path.join(root, "extension")}`, "--enable-unsafe-extension-debugging"],
  });
  browserVersion = context.browser().version(); console.log(`Browser version: ${browserVersion}`);
  context.on("request", request => { if (!request.url().startsWith(origin) && !/^(chrome-extension:|chrome:\/\/resources\/|file:|data:|blob:)/u.test(request.url())) externalRequests.push(request.url()); });
  context.on("page", page => { page.setDefaultTimeout(15000); page.on("pageerror", error => pageErrors.push(error.message)); });
  let extensionId = context.serviceWorkers()[0] && new URL(context.serviceWorkers()[0].url()).host;
  if (!extensionId) {
    const cdp = await context.browser().newBrowserCDPSession();
    extensionId = (await cdp.send("Extensions.loadUnpacked", { path: path.join(root, "extension") })).id;
    await cdp.detach();
  }
  const boot = await context.newPage(); await boot.goto(`chrome-extension://${extensionId}/popup.html`);
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  if (process.env.AUTOMATIC_PDF_DIAGNOSTICS) {
    await worker.evaluate(() => {
      const events = globalThis.__automaticPdfEvents = [];
      const record = (event, details) => events.push({ at: Date.now(), event, ...details });
      const state = tab => ({ id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl, status: tab.status, title: tab.title });
      chrome.webRequest.onHeadersReceived.addListener(details => record("headers", {
        url: details.url, tabId: details.tabId, type: details.type, statusCode: details.statusCode,
        responseHeaders: details.responseHeaders,
      }), { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }, ["responseHeaders"]);
      chrome.tabs.onUpdated.addListener((tabId, changes, tab) => record("updated", { tabId, changes, tab: state(tab) }));
      for (const method of ["get", "update"]) {
        const original = chrome.tabs[method].bind(chrome.tabs);
        chrome.tabs[method] = async (...args) => {
          record(`tabs.${method}.called`, { args });
          try { const result = await original(...args); record(`tabs.${method}.resolved`, { tab: state(result) }); return result; }
          catch (error) { record(`tabs.${method}.rejected`, { error: error.message }); throw error; }
        };
      }
    });
  }

  async function navigateToPdf(page, url) {
    try { await page.goto(url, { waitUntil: "domcontentloaded" }); }
    catch (error) { if (!/ERR_ABORTED|interrupted|Navigation/u.test(error.message)) throw error; }
    await page.waitForURL(candidate => candidate.protocol === "chrome-extension:" && candidate.hostname === extensionId && candidate.pathname === "/pdf.html", { timeout: 15000 });
    await page.locator(".textLayer span").filter({ hasText: /^학교$/u }).first().waitFor({ state: "visible" });
    await page.locator("#busy").waitFor({ state: "hidden" });
    assert.equal(new URL(page.url()).searchParams.get("file"), url);
  }
  async function realWordSelection(page) {
    const word = page.locator(".textLayer span").filter({ hasText: /^학교$/u }).first();
    const box = await word.boundingBox();
    await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection().toString()), "학교");
    const card = page.locator("[data-misheel-popup]");
    await card.locator(".meaning").first().waitFor({ state: "visible" });
    assert.match(await card.locator(".meaning").first().textContent(), /сургуул/u);
    return card;
  }

  await test("Opening a PDF URL automatically loads it in the same tab and selection shows its meaning", async () => {
    const page = await context.newPage(); const count = context.pages().length;
    try {
      await navigateToPdf(page, `${origin}/sample.pdf`);
      assert.equal(context.pages().length, count, "Automatic routing must not create another tab");
      await realWordSelection(page);
      await page.screenshot({ path: path.join(artifacts, "automatic-pdf-selection.png") });
    } finally { await page.close(); }
  });
  await test("Extensionless application/pdf response automatically loads and translates", async () => {
    const page = await context.newPage();
    try { await navigateToPdf(page, `${origin}/document`); await realWordSelection(page); }
    finally { await page.close(); }
  });
  await test("Opening a local PDF automatically loads in the same tab and works offline", async () => {
    await context.setOffline(true);
    const page = await context.newPage();
    try { await navigateToPdf(page, pathToFileURL(sourceFile).href); await realWordSelection(page); }
    finally { await page.close(); await context.setOffline(false); }
  });
  await test("HTML response using a .pdf URL stays an ordinary web page", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/html.pdf`); await page.locator("#school").waitFor({ state: "visible" });
      await page.waitForTimeout(600); assert.equal(page.url(), `${origin}/html.pdf`);
    } finally { await page.close(); }
  });
  await test("An embedded PDF does not replace its parent HTML page", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/embedded.html`); await page.locator("#school").waitFor({ state: "visible" });
      await page.waitForTimeout(600); assert.equal(page.url(), `${origin}/embedded.html`);
    } finally { await page.close(); }
  });
  await test("Automatic local PDF workflow has no external requests or page errors", async () => {
    assert.deepEqual(externalRequests, []); assert.deepEqual(pageErrors, []);
  });
} catch (error) { reports.push({ name: "Automatic PDF browser setup", passed: false, error: error.stack }); console.error(error.stack); }
finally {
  if (worker && process.env.AUTOMATIC_PDF_DIAGNOSTICS) {
    try { navigationEvents.push(...await worker.evaluate(() => globalThis.__automaticPdfEvents || [])); }
    catch (error) { navigationEvents.push({ event: "diagnostic-read-failed", error: error.message }); }
  }
  if (context) await context.close(); await new Promise(resolve => server.close(resolve));
  await mkdir(artifacts, { recursive: true });
  if (process.env.AUTOMATIC_PDF_DIAGNOSTICS) {
    await writeFile(path.join(artifacts, "automatic-pdf-navigation.json"), JSON.stringify({ date: new Date().toISOString(), browserVersion, navigationEvents }, null, 2));
  }
  await writeFile(path.join(artifacts, "automatic-pdf-tests.json"), JSON.stringify({ date: new Date().toISOString(), browserVersion, reports, externalRequests, pageErrors, navigationEvents }, null, 2));
}
const failed = reports.filter(report => !report.passed);
console.log(`${reports.length - failed.length}/${reports.length} automatic PDF browser checks passed.`);
if (failed.length) process.exitCode = 1;
