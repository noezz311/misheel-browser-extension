import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright"); }
catch { playwright = require(path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright")); }
const { chromium } = playwright;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "artifacts");
const reports = [], pageErrors = [], measurements = {};
const fixture = await readFile(path.join(root, "tests", "fixtures", "selection.html"));
const server = createServer((request, response) => {
  if (request.url === "/selection.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(fixture);
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context, browserVersion = "";
async function test(name, fn) {
  try { await fn(); reports.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { reports.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  await mkdir(artifacts, { recursive: true });
  const bundled = chromium.executablePath();
  const executablePath = process.env.BROWSER_EXECUTABLE || (require("node:fs").existsSync(bundled) ? bundled : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  context = await chromium.launchPersistentContext(path.join(root, ".work", `test-pdf-sidebar-${Date.now()}`), {
    executablePath, headless: true, viewport: { width: 1100, height: 900 },
    ignoreDefaultArgs: ["--disable-extensions"], args: [`--load-extension=${path.join(root, "extension")}`, "--enable-unsafe-extension-debugging"],
  });
  browserVersion = context.browser().version(); console.log(`Browser version: ${browserVersion}`);
  context.on("page", page => { page.setDefaultTimeout(12000); page.on("pageerror", error => pageErrors.push(error.message)); });
  let extensionId = context.serviceWorkers()[0] && new URL(context.serviceWorkers()[0].url()).host;
  if (!extensionId) {
    const cdp = await context.browser().newBrowserCDPSession();
    extensionId = (await cdp.send("Extensions.loadUnpacked", { path: path.join(root, "extension") })).id;
    await cdp.detach();
  }
  const boot = await context.newPage(); await boot.goto(`chrome-extension://${extensionId}/popup.html`);
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/pdf.html`);
  await page.locator("#file-input").setInputFiles(path.join(root, "tests", "fixtures", "korean-selectable.pdf"));
  const card = page.locator("[data-misheel-popup]");
  const school = () => page.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: /^학교$/u }).first();
  await school().waitFor({ state: "visible" }); await page.locator("#busy").waitFor({ state: "hidden" });
  async function clear() {
    await page.evaluate(() => { document.activeElement?.blur(); window.getSelection().removeAllRanges(); });
    await page.keyboard.press("Escape"); await card.waitFor({ state: "detached" });
    await page.waitForTimeout(130);
  }
  async function select(locator, mouse = false) {
    await clear(); await locator.waitFor({ state: "visible" });
    if (mouse) {
      const box = await locator.boundingBox();
      await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
    } else {
      await locator.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); });
    }
    try { await card.locator(".meaning").first().waitFor({ state: "visible" }); }
    catch (error) {
      measurements.selectionFailure = await page.evaluate(() => ({ selected: window.getSelection().toString(), annotating: document.documentElement.dataset.misheelAnnotating, active: document.activeElement?.outerHTML.slice(0, 350), page: document.getElementById("page-number").value, tools: [...document.querySelectorAll(".annotation-tools button")].map(node => [node.id, node.getAttribute("aria-pressed")]), layers: [...document.querySelectorAll(".annotationEditorLayer")].map(node => ({ classes: node.className, pointer: getComputedStyle(node).pointerEvents })), card: document.querySelector("[data-misheel-popup]")?.outerHTML, scroll: document.getElementById("reader").scrollTop }));
      measurements.selectionFailure.bounds = await geometry();
      measurements.selectionFailure.wordBounds = await locator.boundingBox();
      await page.screenshot({ path: path.join(artifacts, "pdf-sidebar-selection-diagnostic.png") });
      throw error;
    }
  }
  async function geometry() {
    return page.evaluate(() => {
      const rect = selector => { const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height }; };
      return { reader: rect("#reader"), sidebar: rect(".reader-sidebar"), header: rect(".reader-header"), toolbar: rect("#toolbar"), annotations: rect("#annotation-toolbar"), panel: rect("#translation-panel"), card: document.querySelector("[data-misheel-popup]") && rect("[data-misheel-popup]"), viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth };
    });
  }

  await test("Desktop keeps the header, page, zoom and annotation controls together on the right", async () => {
    const bounds = measurements.controls = await geometry();
    assert.equal(bounds.reader.y, 0, JSON.stringify(bounds));
    assert.ok(bounds.reader.height >= bounds.viewport.height - 40, JSON.stringify(bounds));
    assert.ok(bounds.sidebar.x >= bounds.reader.x + bounds.reader.width - 1, JSON.stringify(bounds));
    assert.equal(bounds.sidebar.x + bounds.sidebar.width, bounds.viewport.width);
    for (const name of ["header", "toolbar", "annotations", "panel"]) {
      assert.ok(bounds[name].x >= bounds.sidebar.x, JSON.stringify({ name, bounds }));
      assert.ok(bounds[name].x + bounds[name].width <= bounds.viewport.width + 1, JSON.stringify({ name, bounds }));
    }
    assert.ok(bounds.toolbar.y >= bounds.header.y + bounds.header.height - 1, JSON.stringify(bounds));
    assert.ok(bounds.annotations.y >= bounds.toolbar.y + bounds.toolbar.height - 1, JSON.stringify(bounds));
    assert.ok(bounds.panel.y >= bounds.annotations.y + bounds.annotations.height - 1, JSON.stringify(bounds));
    for (const id of ["open-file", "page-number", "previous-page", "next-page", "zoom-out", "zoom-reset", "zoom-in", "fit-width", "tool-read", "tool-highlight", "tool-ink", "tool-text", "annotation-undo", "annotation-redo", "annotation-delete", "save-pdf"]) {
      const button = page.locator(`#${id}`), box = await button.boundingBox();
      assert.equal(await button.isVisible(), true, `${id} must be visible`);
      assert.ok(box.x >= bounds.sidebar.x && box.x + box.width <= bounds.viewport.width + 1, `${id} must be inside the right sidebar`);
      assert.ok(box.y >= 0 && box.y + box.height <= bounds.viewport.height, `${id} must remain in the viewport`);
    }
  });

  await test("Actual PDF mouse selection docks 학교 and its Mongolian meaning beside the reader", async () => {
    await select(school(), true); assert.equal(await page.evaluate(() => window.getSelection().toString()), "학교");
    assert.match(await card.locator(".meaning").first().textContent(), /сургуул/u);
    assert.equal(await card.evaluate(node => node.parentElement.id), "translation-panel");
    const bounds = measurements.desktop = await geometry();
    assert.ok(bounds.panel.x >= bounds.reader.x + bounds.reader.width - 1, JSON.stringify(bounds));
    assert.equal(bounds.panel.x + bounds.panel.width, 1100); assert.ok(bounds.reader.width > 600);
    assert.equal(await page.locator(".translation-placeholder").isVisible(), false);
  });

  await test("Multiple real dictionary definitions scroll inside the panel without moving the PDF", async () => {
    const sentence = page.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: /^저는 학교에 갑니다\.$/u }).first();
    await select(sentence);
    assert.ok(await card.locator(".entry").count() >= 2);
    const body = card.locator(".body");
    const sizes = measurements.results = await body.evaluate(node => ({ height: node.clientHeight, total: node.scrollHeight }));
    assert.ok(sizes.total > sizes.height, JSON.stringify(sizes));
    const before = await page.locator("#reader").evaluate(node => node.scrollTop);
    const box = await body.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 600);
    await page.waitForFunction(() => document.querySelector("[data-misheel-popup]")?.shadowRoot.querySelector(".body").scrollTop > 0);
    assert.equal(await page.locator("#reader").evaluate(node => node.scrollTop), before);
    assert.equal(await card.count(), 1);
  });

  await test("Clearing the selected text restores the placeholder without covering the PDF", async () => {
    await clear(); assert.equal(await page.locator(".translation-placeholder").isVisible(), true);
    assert.equal(await page.locator("#translation-panel").evaluate(node => node.classList.contains("has-result")), false);
    const bounds = await geometry(); assert.ok(bounds.panel.x >= bounds.reader.x + bounds.reader.width - 1);
  });

  await test("Annotation tools suppress definitions and returning to Read restores translation", async () => {
    for (const mode of ["highlight", "ink", "text"]) {
      console.log(`Checking annotation suppression and Read restoration: ${mode}`);
      await select(school()); await page.locator(`#tool-${mode}`).click();
      await page.waitForFunction(() => document.documentElement.dataset.misheelAnnotating === "true");
      await school().evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); });
      await page.waitForTimeout(180); assert.equal(await card.count(), 0, `${mode} must suppress the dictionary`);
      assert.equal(await page.locator(".translation-placeholder").isVisible(), true);
      await page.locator("#tool-read").click();
      await page.waitForFunction(() => document.documentElement.dataset.misheelAnnotating !== "true");
      await select(school(), true); assert.match(await card.locator(".meaning").first().textContent(), /сургуул/u);
    }
  });

  for (const width of [640, 430]) {
    await test(`${width}px layout keeps a usable PDF and puts scrollable definitions beneath it`, async () => {
      await clear(); await page.setViewportSize({ width, height: 900 }); await page.locator("#fit-width").click();
      await page.waitForTimeout(220); await school().waitFor({ state: "visible" });
      await select(school(), true); assert.match(await card.locator(".meaning").first().textContent(), /сургуул/u);
      const bounds = measurements[`narrow${width}`] = await geometry();
      assert.ok(bounds.reader.height > 300, JSON.stringify(bounds)); assert.equal(bounds.reader.width, width);
      assert.ok(bounds.sidebar.y >= bounds.reader.y + bounds.reader.height - 1, JSON.stringify(bounds));
      assert.equal(bounds.sidebar.width, width); assert.ok(bounds.sidebar.height > 200); assert.ok(bounds.documentWidth <= width);
      const readerBefore = await page.locator("#reader").evaluate(node => node.scrollTop);
      await card.scrollIntoViewIfNeeded();
      assert.equal(await page.locator("#reader").evaluate(node => node.scrollTop), readerBefore, "Reaching narrow-screen definitions must leave the PDF at its current position");
      assert.ok(await page.locator(".reader-sidebar").evaluate(node => node.scrollHeight > node.clientHeight && node.scrollTop > 0), "The controls and definitions must scroll inside the lower sidebar");
      await page.screenshot({ path: path.join(artifacts, `pdf-sidebar-${width}.png`) });
      const sentence = page.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: /^저는 학교에 갑니다\.$/u }).first();
      await select(sentence);
      const body = card.locator(".body");
      await body.scrollIntoViewIfNeeded();
      const sizes = await body.evaluate(node => ({ height: node.clientHeight, total: node.scrollHeight }));
      assert.ok(sizes.total > sizes.height, JSON.stringify(sizes));
      const box = await body.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 300);
      await page.waitForFunction(() => document.querySelector("[data-misheel-popup]")?.shadowRoot.querySelector(".body").scrollTop > 0);
      await card.getByRole("button", { name: "Хаах", exact: true }).click();
      await card.waitFor({ state: "detached" }); assert.equal(await page.locator(".translation-placeholder").isVisible(), true);
    });
  }

  for (const theme of [{ name: "dark", width: 1440, height: 1000 }, { name: "light", width: 1100, height: 900 }]) {
    await test(`${theme.name} desktop screenshot shows right-side controls, translation and continuous PDF pages`, async () => {
      await page.emulateMedia({ colorScheme: theme.name });
      await page.setViewportSize({ width: theme.width, height: theme.height });
      await page.locator(".reader-sidebar").evaluate(node => { node.scrollTop = 0; });
      await page.locator("#zoom-reset").click();
      for (let i = 0; i < 2; i++) await page.locator("#zoom-out").click();
      await page.locator("#reader").evaluate(node => { node.scrollTop = 0; }); await page.waitForTimeout(240);
      await select(school(), true);
      const boundary = await page.locator('.page[data-page-number="1"]').boundingBox();
      const reader = await page.locator("#reader").boundingBox();
      assert.ok(boundary.y + boundary.height < reader.y + reader.height - 20, JSON.stringify({ boundary, reader }));
      await page.screenshot({ path: path.join(artifacts, `pdf-right-controls-${theme.name}.png`) });
    });
  }

  await test("Ordinary website definitions retain their floating card", async () => {
    const web = await context.newPage(); await web.goto(`${origin}/selection.html`);
    await web.locator("#school").evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); });
    const floating = web.locator("[data-misheel-popup]"); await floating.locator(".meaning").first().waitFor({ state: "visible" });
    assert.match(await floating.locator(".meaning").first().textContent(), /сургуул/u);
    assert.equal(await floating.evaluate(node => node.parentElement === document.documentElement), true);
    assert.equal(await floating.evaluate(node => getComputedStyle(node).position), "fixed");
    const box = await floating.boundingBox(); assert.ok(box.width >= 350 && box.x >= 12 && box.x + box.width <= 1100 - 12);
    await web.close();
  });
  await test("Sidebar and website checks produce no browser page errors", async () => { assert.deepEqual(pageErrors, []); });
} catch (error) { reports.push({ name: "PDF sidebar browser setup", passed: false, error: error.stack }); console.error(error.stack); }
finally {
  if (context) await context.close(); await new Promise(resolve => server.close(resolve));
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "pdf-sidebar-tests.json"), JSON.stringify({ date: new Date().toISOString(), browserVersion, reports, measurements, pageErrors }, null, 2));
}
const failed = reports.filter(report => !report.passed);
console.log(`${reports.length - failed.length}/${reports.length} PDF sidebar browser checks passed.`);
if (failed.length) process.exitCode = 1;
