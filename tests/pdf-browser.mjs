import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright"); }
catch { playwright = require(path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright")); }
const { chromium } = playwright;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "artifacts");
const fixture = name => path.join(root, "tests", "fixtures", name);
const reports = [];
const requests = [];
const pageErrors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let context, browserVersion = "";

async function test(name, fn) {
  try { await fn(); reports.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { reports.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  await mkdir(artifacts, { recursive: true });
  const profile = path.join(root, ".work", `test-pdf-browser-${Date.now()}`);
  const bundled = chromium.executablePath();
  const executablePath = process.env.BROWSER_EXECUTABLE || (require("node:fs").existsSync(bundled) ? bundled : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 1100, height: 900 },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--load-extension=${path.join(root, "extension")}`, "--enable-unsafe-extension-debugging"],
  });
  browserVersion = context.browser().version();
  console.log(`Browser version: ${browserVersion}`);
  context.on("request", request => {
    if (!/^(chrome-extension:|file:|data:|blob:)/u.test(request.url())) requests.push(request.url());
  });
  context.on("page", page => {
    page.setDefaultTimeout(12000);
    page.on("pageerror", error => pageErrors.push(error.message));
  });
  let extensionId = context.serviceWorkers()[0] && new URL(context.serviceWorkers()[0].url()).host;
  if (!extensionId) {
    const cdp = await context.browser().newBrowserCDPSession();
    extensionId = (await cdp.send("Extensions.loadUnpacked", { path: path.join(root, "extension") })).id;
    await cdp.detach();
  }
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 12000 });
  console.log(`Actual service worker: ${worker.url()}`);
  await context.setOffline(true);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/pdf.html`);
  const card = page.locator("[data-misheel-popup]");
  async function choose(name) { await page.locator("#file-input").setInputFiles(fixture(name)); }
  async function waitWord(word) {
    const span = page.locator(".textLayer span").filter({ hasText: new RegExp(`^${word}$`, "u") }).first();
    await span.waitFor({ state: "visible" });
    await page.locator("#busy").waitFor({ state: "hidden" });
    return span;
  }
  async function selectWord(word, mouse = false) {
    const span = await waitWord(word);
    await page.keyboard.press("Escape");
    await page.evaluate(() => { document.activeElement?.blur(); window.getSelection().removeAllRanges(); });
    if (mouse) {
      const box = await span.boundingBox();
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      const selected = await page.evaluate(() => window.getSelection().toString());
      if (selected !== word) await page.screenshot({ path: path.join(artifacts, "pdf-mouse-diagnostic.png") });
      assert.equal(selected, word, "Mouse drag must select the PDF text layer word");
    } else {
      await span.evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      });
    }
    await card.locator(".meaning").first().waitFor({ state: "visible" });
    assert.equal(await card.locator(".query").textContent(), word);
  }

  await test("Offline first load renders embedded Korean PDF font, canvas and selectable text", async () => {
    await choose("korean-selectable.pdf"); await waitWord("학교");
    assert.equal(await page.locator("#page-count").textContent(), "2");
    assert.equal(await page.locator("#page-number").inputValue(), "1");
    assert.equal(await page.locator("#document-name").textContent(), "korean-selectable.pdf");
    assert.equal(await page.locator("#no-text").isVisible(), false);
    const canvas = await page.locator("#page-shell canvas").evaluate(node => ({ width: node.width, height: node.height }));
    assert.ok(canvas.width > 500 && canvas.height > 500);
    assert.deepEqual(requests, []);
  });

  await test("Actual mouse selection inside PDF shows 학교 to сургууль dictionary card", async () => {
    await selectWord("학교", true);
    assert.match(await card.locator(".meaning").first().textContent(), /сургуул/u);
    assert.match(await card.locator(".examples").textContent(), /сурагчдад/u);
    await page.screenshot({ path: path.join(artifacts, "pdf-selection.png") });
    await card.screenshot({ path: path.join(artifacts, "pdf-selection-card.png") });
  });

  await test("PDF next/previous controls clear old selection and translate the next page", async () => {
    await page.locator("#next-page").click(); await waitWord("사과");
    assert.equal(await page.locator("#page-number").inputValue(), "2");
    assert.equal(await card.count(), 0);
    assert.equal(await page.locator("#next-page").isDisabled(), true);
    await selectWord("사과"); assert.match(await card.locator(".meaning").first().textContent(), /алим/u);
    await page.locator("#previous-page").click(); await waitWord("학교");
    assert.equal(await page.locator("#previous-page").isDisabled(), true);
  });

  await test("Zoom, 100% reset and fit width preserve selectable Korean text", async () => {
    const before = await page.locator("#page-shell").boundingBox();
    await page.locator("#zoom-in").click(); await waitWord("학교");
    const after = await page.locator("#page-shell").boundingBox();
    assert.ok(after.width > before.width, `${before.width} -> ${after.width}`);
    assert.equal(await page.locator("#fit-width").getAttribute("aria-pressed"), "false");
    await page.locator("#zoom-reset").click(); await waitWord("학교");
    assert.equal(await page.locator("#zoom-reset").textContent(), "100%");
    await selectWord("학교");
    await page.locator("#fit-width").click(); await waitWord("학교");
    assert.equal(await page.locator("#fit-width").getAttribute("aria-pressed"), "true");
    assert.equal(await card.count(), 0);
  });

  await test("Page input and unselected Arrow keys navigate the PDF", async () => {
    await page.locator("#page-number").fill("2"); await page.locator("#page-number").press("Enter");
    await waitWord("사과");
    await page.locator("#page-number").blur();
    await page.keyboard.press("ArrowLeft"); await waitWord("학교");
    assert.equal(await page.locator("#page-number").inputValue(), "1");
  });

  await test("Invalid file reports a useful error and a subsequent valid file recovers", async () => {
    await choose("invalid.pdf"); await page.locator("#message").waitFor({ state: "visible" });
    assert.match(await page.locator("#message").textContent(), /PDF форматтай биш/u);
    await choose("korean-selectable.pdf"); await waitWord("학교");
    assert.equal(await page.locator("#message").isVisible(), false);
  });

  await test("Raster-only PDF shows scanned-page advisory with no selectable text", async () => {
    await choose("korean-scanned.pdf"); await page.locator("#no-text").waitFor({ state: "visible" });
    await page.locator("#busy").waitFor({ state: "hidden" });
    assert.match(await page.locator("#no-text").textContent(), /сканнердсан/u);
    assert.equal(await page.locator(".textLayer span").count(), 0);
    assert.equal(await page.locator("#page-count").textContent(), "1");
  });

  await test("New PDF selection wins when a previous file read completes late", async () => {
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      globalThis.__testFileArrayBuffer = original;
      File.prototype.arrayBuffer = async function (...args) {
        if (this.name === "korean-selectable.pdf") await new Promise(resolve => setTimeout(resolve, 900));
        return original.apply(this, args);
      };
    });
    try {
      await choose("korean-selectable.pdf"); await page.locator("#busy").waitFor({ state: "visible" });
      await choose("korean-scanned.pdf"); await page.locator("#no-text").waitFor({ state: "visible" });
      await pause(1100);
      assert.equal(await page.locator("#document-name").textContent(), "korean-scanned.pdf");
      assert.equal(await page.locator("#page-count").textContent(), "1");
      assert.equal(await page.locator(".textLayer span").count(), 0);
    } finally { await page.evaluate(() => { File.prototype.arrayBuffer = globalThis.__testFileArrayBuffer; delete globalThis.__testFileArrayBuffer; }); }
  });

  await test("Popup button opens the real packaged PDF reader", async () => {
    const opened = context.waitForEvent("page");
    await popup.locator("#open-pdf").click();
    const reader = await opened;
    await reader.waitForURL(`chrome-extension://${extensionId}/pdf.html`);
    await reader.locator("#choose-file").waitFor({ state: "visible" });
    await reader.close();
  });

  await test("Explicit local PDF URL renders and translates with file access granted", async () => {
    const url = new URL(`chrome-extension://${extensionId}/pdf.html`);
    url.searchParams.set("file", pathToFileURL(fixture("korean-selectable.pdf")).href);
    const linked = await context.newPage();
    try {
      await linked.goto(url.href);
      const word = linked.locator(".textLayer span").filter({ hasText: /^학교$/u }).first();
      await word.waitFor({ state: "visible" });
      await linked.locator("#busy").waitFor({ state: "hidden" });
      assert.equal(await linked.locator("#document-name").textContent(), "korean-selectable.pdf");
      await word.evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      });
      const linkedMeaning = linked.locator("[data-misheel-popup] .meaning").first();
      await linkedMeaning.waitFor({ state: "visible" });
      assert.match(await linkedMeaning.textContent(), /сургуул/u);
    } finally { await linked.close(); }
  });

  await test("Unsupported PDF source URL offers file selection and cannot execute JavaScript", async () => {
    const url = new URL(`chrome-extension://${extensionId}/pdf.html`);
    url.searchParams.set("file", "javascript:globalThis.__pdfUrlRan=true");
    const linked = await context.newPage();
    try {
      await linked.goto(url.href); await linked.locator("#message").waitFor({ state: "visible" });
      assert.match(await linked.locator("#message").textContent(), /PDF файл сонгож/u);
      assert.equal(await linked.evaluate(() => globalThis.__pdfUrlRan), undefined);
      await linked.locator("#file-input").setInputFiles(fixture("korean-selectable.pdf"));
      await linked.locator(".textLayer span").filter({ hasText: /^학교$/u }).first().waitFor({ state: "visible" });
    } finally { await linked.close(); }
  });

  await test("Corrupted PDF reaches the renderer error path and can recover", async () => {
    await page.locator("#file-input").setInputFiles({ name: "corrupted.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nnot a complete PDF\n") });
    await page.locator("#message").waitFor({ state: "visible" });
    assert.match(await page.locator("#message").textContent(), /гэмтсэн|PDF форматтай биш/u);
    await choose("korean-selectable.pdf"); await waitWord("학교");
  });

  await test("PDF reader and dictionary remain offline with no external requests or script errors", async () => {
    assert.deepEqual(requests, []); assert.deepEqual(pageErrors, []);
  });
} catch (error) {
  reports.push({ name: "PDF browser setup", passed: false, error: error.stack }); console.error(error.stack);
} finally {
  if (context) await context.close();
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "pdf-browser-tests.json"), JSON.stringify({ date: new Date().toISOString(), browserVersion, reports, requests, pageErrors }, null, 2));
}
const failed = reports.filter(report => !report.passed);
console.log(`${reports.length - failed.length}/${reports.length} PDF browser checks passed.`);
if (failed.length) process.exitCode = 1;
