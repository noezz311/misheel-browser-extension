import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Uses a local Playwright install when available, then Codex's bundled runtime.
// Set PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE to override either location.
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright"); }
catch {
  playwright = require(path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright"));
}
const { chromium } = playwright;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extension");
const profile = path.join(root, ".work", `test-browser-${Date.now()}`);
const artifacts = path.join(root, "artifacts");
const fixture = await readFile(path.join(root, "tests", "fixtures", "selection.html"));
const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json")));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["storage", "activeTab", "webRequest"]);
assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
assert.match(manifest.content_security_policy.extension_pages, /object-src 'none'/);
assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*", "file:///*"], "Automatic PDF handling uses only web and local file sources");
assert.ok(!/(?:^|[\s;])'unsafe-eval'(?:[\s;]|$)/u.test(manifest.content_security_policy.extension_pages));

const server = createServer((request, response) => {
  if (request.url === "/selection.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture);
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const reports = [];
const externalRequests = [];
const pageErrors = [];
let context;
let browserVersion = "";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function test(name, fn) {
  try { await fn(); reports.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { reports.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}

async function exists(filename) { try { await access(filename); return true; } catch { return false; } }

try {
  if (!await exists(path.join(extension, "data", "index.json"))) throw new Error("Bundled dictionary data is missing. Export extension/data before running real integration checks.");
  await mkdir(profile, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const bundled = chromium.executablePath();
  const candidates = [process.env.BROWSER_EXECUTABLE, await exists(bundled) ? bundled : null, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean);
  const executablePath = candidates.find(filename => require("node:fs").existsSync(filename));
  if (!executablePath) throw new Error("No browser executable found. Install Playwright Chromium or set BROWSER_EXECUTABLE.");
  console.log(`Browser: ${executablePath}`);
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 900, height: 680 },
    ignoreDefaultArgs: ["--disable-extensions"],
    // The fresh profile contains no other extensions. Chrome 137+ no longer
    // honors --load-extension; --disable-extensions-except would then block
    // the same extension loaded through DevTools, so omit that allowlist flag.
    args: [`--load-extension=${extension}`, "--enable-unsafe-extension-debugging"],
  });
  browserVersion = context.browser().version();
  console.log(`Browser version: ${browserVersion}`);
  context.on("request", request => {
    if (!request.url().startsWith(origin) && !/^(chrome-extension:|chrome:\/\/resources\/|file:|data:|blob:)/u.test(request.url())) externalRequests.push(request.url());
  });
  context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    // Branded Chrome 137+ ignores --load-extension. DevTools supports unpacked
    // loading when --enable-unsafe-extension-debugging is explicitly enabled.
    try {
      const cdp = await context.browser().newBrowserCDPSession();
      const loaded = await cdp.send("Extensions.loadUnpacked", { path: extension });
      console.log(`Extension loaded through DevTools: ${loaded.id}`);
      await cdp.detach();
      const wake = await context.newPage();
      await wake.goto(`chrome-extension://${loaded.id}/popup.html`);
    } catch (error) { console.log(`DevTools extension load unavailable: ${error.message}`); }
    worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  }
  const extensionId = new URL(worker.url()).host;
  console.log(`Actual extension service worker: ${worker.url()}`);
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${origin}/selection.html`);
  const card = page.locator("[data-misheel-popup]");
  const query = card.locator(".query");
  const meaning = card.locator(".meaning").first();

  async function clear() {
    await page.evaluate(() => { document.activeElement?.blur(); window.getSelection().removeAllRanges(); });
    await page.keyboard.press("Escape");
    await pause(130);
  }
  async function select(id) {
    await clear();
    await page.evaluate(id => {
      const node = document.getElementById(id);
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, id);
  }
  async function waitMeaning() { await meaning.waitFor({ state: "visible", timeout: 7000 }); }
  async function assertBounds() {
    const box = await card.boundingBox(); const viewport = page.viewportSize();
    assert.ok(box && box.x >= 11 && box.y >= 11, JSON.stringify(box));
    assert.ok(box.x + box.width <= viewport.width - 10, JSON.stringify(box));
    assert.ok(box.y + box.height <= viewport.height - 10, JSON.stringify(box));
  }

  await test("Actual service worker loads bundled dictionary metadata", async () => {
    const info = await worker.evaluate(async () => (await fetch(chrome.runtime.getURL("data/index.json"))).json());
    assert.ok(info.entryCount > 1000, JSON.stringify(info));
    assert.equal(info.targetLanguage || "mn", "mn");
  });

  await test("Stale lookup does not overwrite a newer selection", async () => {
    await worker.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.__testOriginalFetch = original;
      globalThis.fetch = async (...args) => {
        if (String(args[0]).endsWith("/18.json")) await new Promise(resolve => setTimeout(resolve, 1200));
        return original(...args);
      };
    });
    try {
      await select("school"); await query.waitFor({ state: "visible" });
      await select("apple"); await waitMeaning();
      assert.equal(await query.textContent(), "사과");
      const before = await meaning.textContent();
      await pause(1400);
      assert.equal(await query.textContent(), "사과");
      assert.equal(await meaning.textContent(), before);
    } finally {
      await worker.evaluate(() => { globalThis.fetch = globalThis.__testOriginalFetch; delete globalThis.__testOriginalFetch; });
    }
  });

  await test("Mouse selection shows an adjacent Korean to Mongolian definition", async () => {
    await clear();
    const box = await page.locator("#school").boundingBox();
    await page.mouse.move(box.x - 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 2, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await waitMeaning();
    assert.equal(await query.textContent(), "학교");
    assert.match(await meaning.textContent(), /сургуул/i);
    const word = await card.locator(".word").first().textContent();
    assert.equal(word, "학교");
    assert.match(await card.locator(".examples").textContent(), /교사가 학생을 가르치는 기관/);
    assert.match(await card.locator(".examples").textContent(), /сурагчдад сургаж заадаг байгууллага/);
    await assertBounds();
    await card.screenshot({ path: path.join(artifacts, "selection-card.png") });
    const popupBox = await card.boundingBox();
    const left = Math.max(0, Math.min(box.x, popupBox.x) - 16);
    const top = Math.max(0, Math.min(box.y, popupBox.y) - 16);
    await page.screenshot({ path: path.join(artifacts, "selection-school.png"), clip: {
      x: left, y: top,
      width: Math.max(box.x + box.width, popupBox.x + popupBox.width) - left + 16,
      height: Math.max(box.y + box.height, popupBox.y + popupBox.height) - top + 16,
    } });
  });

  await test("Escape closes and the dismissed selection stays closed", async () => {
    await page.keyboard.press("Escape");
    await card.waitFor({ state: "detached" });
    await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
    await pause(250); assert.equal(await card.count(), 0);
  });

  await test("Caret selection changes and Shift key release show the definition", async () => {
    await clear();
    await page.evaluate(() => {
      const text = document.getElementById("school").firstChild;
      const selection = window.getSelection(); selection.setPosition(text, 0);
    });
    await page.keyboard.down("Shift");
    // Static pages require caret browsing for native Shift+Arrow selection.
    // Exercise Chrome's selection movement and an actual Shift key release
    // without changing the fixture into an editable field.
    await page.evaluate(() => {
      window.getSelection().modify("extend", "forward", "character");
      window.getSelection().modify("extend", "forward", "character");
    });
    await page.keyboard.up("Shift");
    assert.equal(await page.evaluate(() => window.getSelection().toString()), "학교", "Browser keyboard selection must select both Korean characters");
    await waitMeaning(); assert.equal(await query.textContent(), "학교");
  });

  await test("Outside click and close button dismiss the definition", async () => {
    await page.locator("#outside").click(); await card.waitFor({ state: "detached" });
    await select("school"); await waitMeaning();
    await card.getByRole("button", { name: "Хаах", exact: true }).click();
    await card.waitFor({ state: "detached" });
  });

  await test("English and editable fields do not open a tooltip", async () => {
    await select("english"); await pause(300); assert.equal(await card.count(), 0);
    await select("editable"); await pause(300); assert.equal(await card.count(), 0);
    for (const id of ["input", "textarea"]) {
      await clear(); await page.locator(`#${id}`).focus(); await page.keyboard.press("Control+A");
      await pause(300); assert.equal(await card.count(), 0);
    }
  });

  await test("Multiword and unknown selections show honest dictionary status", async () => {
    await select("words"); await waitMeaning();
    assert.ok(await card.locator(".word").count() >= 2);
    assert.match(await card.locator(".note").first().textContent(), /автоматаар орчуулахгүй/);
    await select("unknown"); await card.locator(".empty").waitFor({ state: "visible" });
    assert.match(await card.locator(".empty").textContent(), /олдсонгүй/);
  });

  await test("Selections over 500 characters show the limit without truncating or submitting", async () => {
    await select("long"); await card.locator(".empty").waitFor({ state: "visible" });
    assert.match(await card.locator(".empty").textContent(), /урт|500|хэтэр/);
    assert.match(await card.locator(".note").textContent(), /500/);
    assert.equal(await card.locator(".meaning").count(), 0);
    assert.equal(await card.locator(".online").count(), 0);
  });

  await test("Tooltip remains inside the viewport at bottom right and after resize", async () => {
    await select("edge"); await waitMeaning(); await assertBounds();
    await page.screenshot({ path: path.join(artifacts, "selection-edge.png") });
    await page.setViewportSize({ width: 320, height: 480 }); await pause(200); await assertBounds();
    await page.setViewportSize({ width: 900, height: 680 });
  });

  const popup = await context.newPage();
  popup.setDefaultTimeout(7000);
  popup.on("pageerror", error => pageErrors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await test("Popup searches the same real dictionary with examples and an explicit external link", async () => {
    await popup.locator("#query").fill("학교"); await popup.getByRole("button", { name: "Хайх", exact: true }).click();
    await popup.locator(".meaning").first().waitFor({ state: "visible" });
    assert.match(await popup.locator(".meaning").first().textContent(), /сургуул/i);
    assert.match(await popup.locator(".example-ko").first().textContent(), /교사가 학생을 가르치는 기관/);
    assert.match(await popup.locator(".example-mn").first().textContent(), /сурагчдад сургаж заадаг байгууллага/);
    const online = popup.locator("#online");
    assert.ok(await online.isVisible()); assert.equal(new URL(await online.getAttribute("href")).hostname, "translate.google.com");
    assert.equal(new URL(await online.getAttribute("href")).searchParams.get("text"), "학교");
    assert.match(await popup.locator("#dictionary-info").textContent(), /\d/);
    await popup.locator("body").screenshot({ path: path.join(artifacts, "popup-search.png") });
  });

  await test("Storage toggle immediately disables and reenables selection in an existing page", async () => {
    await select("school"); await waitMeaning();
    await popup.locator("#enabled").uncheck(); await card.waitFor({ state: "detached" });
    await select("apple"); await pause(300); assert.equal(await card.count(), 0);
    await popup.locator("#enabled").check(); await select("school"); await waitMeaning();
  });

  await test("Bundled lookup works with the browser offline and makes no external requests", async () => {
    await context.setOffline(true);
    // 바다 belongs to a shard not requested by earlier lookups. This proves
    // local packaged fetches still work offline, beyond the lookup cache.
    await select("sea"); await waitMeaning(); assert.equal(await query.textContent(), "바다");
    await popup.locator("#query").fill("학교"); await popup.getByRole("button", { name: "Хайх", exact: true }).click();
    await popup.locator(".meaning").first().waitFor({ state: "visible" });
    assert.deepEqual(externalRequests, []);
    await context.setOffline(false);
  });

  await test("Extension pages enforce CSP and render dictionary values as text", async () => {
    const csp = await popup.evaluate(() => {
      // DevTools evaluation itself may bypass unsafe-eval. A real script node
      // must still obey the extension page's CSP.
      const script = document.createElement("script");
      script.textContent = "globalThis.__misheelInlineScriptRan = true";
      document.body.append(script);
      script.remove();
      return globalThis.__misheelInlineScriptRan !== true;
    });
    assert.equal(csp, true);
    assert.equal(await popup.locator("#results script, #results iframe").count(), 0);
    assert.deepEqual(pageErrors, []);
  });

  await test("Local HTML selection works after file URL access is explicitly enabled", async () => {
    const settings = await context.newPage();
    await settings.goto(`chrome://extensions/?id=${extensionId}`);
    const fileAccess = settings.locator("#allow-on-file-urls");
    await fileAccess.waitFor({ state: "visible" });
    // The CDP unpacked-loader grants file access in this isolated profile.
    // Read the actual row state, because cr-toggle exposes aria-checked,
    // not aria-pressed; blindly clicking would revoke the existing grant.
    if (await fileAccess.getAttribute("checked") === null) {
      await fileAccess.locator("cr-toggle").click();
      await settings.waitForFunction(() => {
        const manager = document.querySelector("extensions-manager")?.shadowRoot;
        return manager?.querySelector("extensions-detail-view")?.shadowRoot?.querySelector("#allow-on-file-urls")?.hasAttribute("checked");
      });
    }
    await settings.close();
    const localPage = await context.newPage();
    await localPage.goto(new URL(`file:///${path.join(root, "tests", "fixtures", "selection.html").replaceAll("\\", "/")}`).href);
    await localPage.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.getElementById("school"));
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    const localCard = localPage.locator("[data-misheel-popup]");
    await localCard.locator(".meaning").waitFor({ state: "visible", timeout: 7000 });
    assert.match(await localCard.locator(".meaning").textContent(), /сургуул/i);
    await localPage.close();
  });
} catch (error) {
  reports.push({ name: "Browser setup", passed: false, error: error.stack });
  console.error(error.stack);
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  await mkdir(artifacts, { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(artifacts, "browser-tests.json"), JSON.stringify({ date: new Date().toISOString(), browserVersion, reports, externalRequests, pageErrors }, null, 2));
}
const failed = reports.filter(report => !report.passed);
console.log(`${reports.length - failed.length}/${reports.length} browser checks passed.`);
if (failed.length) process.exitCode = 1;
