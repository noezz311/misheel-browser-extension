import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright"); }
catch { playwright = require(path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright")); }
const { chromium } = playwright;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "artifacts");
const fixture = path.join(root, "tests", "fixtures", "korean-selectable.pdf");
const reports = [], errors = [], network = [];
const shortcutFocus = {};
let context, page, extensionId, browserVersion;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function test(name, fn) {
  try { await fn(); reports.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { reports.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function waitPage(word = "학교") {
  await page.locator(".textLayer span").filter({ hasText: new RegExp(`^${word}$`, "u") }).first().waitFor({ state: "visible" });
  await page.locator("#busy").waitFor({ state: "hidden" });
  await page.locator("#tool-ink").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("tool-ink").disabled);
}
async function tool(name) {
  await page.locator(`#tool-${name}`).click();
  await page.waitForFunction(id => document.getElementById(id).getAttribute("aria-pressed") === "true", `tool-${name}`);
  await page.locator("#busy").waitFor({ state: "hidden" });
}
async function waitMode(name) {
  await page.waitForFunction(id => document.getElementById(id).getAttribute("aria-pressed") === "true", `tool-${name}`);
}
async function recordFocus(name) {
  shortcutFocus[name] = await page.evaluate(() => {
    const node = document.activeElement;
    return { tag: node?.tagName, id: node?.id, className: node?.className,
      contentEditable: node?.isContentEditable, selection: window.getSelection()?.toString() };
  });
}
async function save(name) {
  const download = page.waitForEvent("download");
  await page.locator("#save-pdf").click();
  const file = await download;
  assert.match(file.suggestedFilename(), /-misheel\.pdf$/u);
  const destination = path.join(artifacts, name);
  await file.saveAs(destination);
  await page.waitForFunction(() => !document.getElementById("save-pdf").disabled);
  return destination;
}
async function readAnnotations(filename) {
  const data = [...await readFile(filename)];
  return page.evaluate(async ({ data, id }) => {
    const pdfjs = await import(`chrome-extension://${id}/vendor/pdfjs/pdf.mjs`);
    const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false,
      cMapUrl: `chrome-extension://${id}/vendor/pdfjs/cmaps/`, cMapPacked: true,
      standardFontDataUrl: `chrome-extension://${id}/vendor/pdfjs/standard_fonts/`,
      wasmUrl: `chrome-extension://${id}/vendor/pdfjs/wasm/`, useWorkerFetch: false });
    const doc = await task.promise;
    const annotations = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      annotations.push(...(await p.getAnnotations()).map(a => ({ page: n, id: a.id, subtype: a.subtype,
        annotationType: a.annotationType, contents: a.contentsObj?.str, hasAppearance: a.hasAppearance,
        fontSize: a.defaultAppearanceData?.fontSize, fontColor: a.defaultAppearanceData?.fontColor ? [...a.defaultAppearanceData.fontColor] : null,
        rect: a.rect, quadPoints: a.quadPoints ? [...a.quadPoints] : null,
        inkLists: a.inkLists?.map(v => [...v]), color: a.color ? [...a.color] : null })));
    }
    await task.destroy();
    return annotations;
  }, { data, id: extensionId });
}

async function readAppearances(filename) {
  return page.evaluate(async ({ data, id }) => {
    await import(`chrome-extension://${id}/vendor/pdf-lib/pdf-lib.min.js`);
    const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = globalThis.PDFLib;
    const pdf = await PDFDocument.load(new Uint8Array(data), { updateMetadata: false });
    const name = PDFName.of, details = [];
    for (const p of pdf.getPages()) {
      for (const ref of p.node.lookupMaybe(name("Annots"), PDFArray)?.asArray() || []) {
        const annotation = pdf.context.lookup(ref, PDFDict);
        if (annotation.get(name("Subtype"))?.toString() !== "/FreeText") continue;
        const ap = annotation.lookupMaybe(name("AP"), PDFDict)?.lookupMaybe(name("N"), PDFRawStream);
        const resources = ap?.dict.lookupMaybe(name("Resources"), PDFDict);
        const fonts = resources?.lookupMaybe(name("Font"), PDFDict);
        const fontBytes = [];
        for (const [, ref] of fonts?.entries() || []) {
          const font = pdf.context.lookup(ref, PDFDict);
          const descendant = pdf.context.lookup(font.lookup(name("DescendantFonts"), PDFArray).get(0), PDFDict);
          const descriptor = descendant.lookup(name("FontDescriptor"), PDFDict);
          const file = descriptor.lookupMaybe(name("FontFile2"), PDFRawStream) || descriptor.lookupMaybe(name("FontFile3"), PDFRawStream);
          fontBytes.push(file?.getContentsSize());
        }
        details.push({ contents: annotation.lookup(name("Contents"))?.decodeText(), da: annotation.lookup(name("DA"))?.decodeText(),
          bbox: ap?.dict.lookupMaybe(name("BBox"), PDFArray)?.asArray().map(n => n.asNumber()),
          matrix: ap?.dict.lookupMaybe(name("Matrix"), PDFArray)?.asArray().map(n => n.asNumber()),
          stream: ap ? new TextDecoder().decode(decodePDFRawStream(ap).decode()) : null,
          fontBytes, image: !!resources?.lookupMaybe(name("XObject"), PDFDict) });
      }
    }
    return details;
  }, { data: [...await readFile(filename)], id: extensionId });
}

try {
  await mkdir(artifacts, { recursive: true });
  const bundled = chromium.executablePath();
  const executablePath = process.env.BROWSER_EXECUTABLE || (require("node:fs").existsSync(bundled) ? bundled : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  context = await chromium.launchPersistentContext(path.join(root, ".work", `test-pdf-annotations-${Date.now()}`), {
    executablePath, headless: true, viewport: { width: 1100, height: 900 }, acceptDownloads: true,
    ignoreDefaultArgs: ["--disable-extensions"], args: ["--enable-unsafe-extension-debugging"],
  });
  browserVersion = context.browser().version();
  const cdp = await context.browser().newBrowserCDPSession();
  extensionId = (await cdp.send("Extensions.loadUnpacked", { path: path.join(root, "extension") })).id;
  await cdp.detach();
  context.on("request", request => { if (!/^(chrome-extension:|file:|data:|blob:)/u.test(request.url())) network.push(request.url()); });
  context.on("page", p => { p.setDefaultTimeout(15000); p.on("pageerror", e => errors.push(e.message)); });
  await context.setOffline(true);
  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/pdf.html`);
  await page.locator("#file-input").setInputFiles(fixture);
  await waitPage();

  await test("Alt+T switches Text and Read, clears definitions, and a held key switches only once", async () => {
    const word = page.locator(".textLayer span").filter({ hasText: /^학교$/u }).first();
    const box = await word.boundingBox();
    await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
    const card = page.locator("[data-misheel-popup]");
    await card.locator(".meaning").first().waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.getSelection().toString()), "학교");
    assert.match(await card.locator(".meaning").first().textContent(), /сургуул/u);
    await recordFocus("selectedWord");
    await page.keyboard.down("Alt");
    try {
      await page.keyboard.down("t"); await waitMode("text");
      await card.waitFor({ state: "detached" });
      assert.equal(await page.locator(".translation-placeholder").isVisible(), true);
      await recordFocus("enteredText");
      await page.keyboard.down("t");
      await pause(100);
      assert.equal(await page.locator("#tool-text").getAttribute("aria-pressed"), "true", "Holding the shortcut must not toggle back to Read");
      assert.equal(await page.locator(".freeTextEditor").count(), 0, "The shortcut must not create a stray text note");
    } finally { await page.keyboard.up("t"); await page.keyboard.up("Alt"); }
    await page.keyboard.press("Alt+t"); await waitMode("read"); await recordFocus("returnedRead");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.misheelAnnotating), undefined);
    for (const name of ["highlight", "ink"]) {
      await tool(name); await page.keyboard.press("Alt+t"); await waitMode("text");
      await page.keyboard.press("Alt+t"); await waitMode("read");
    }
  });
  await test("Text highlight uses actual drag selection and suppresses the dictionary in annotation mode", async () => {
    await tool("highlight");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.misheelAnnotating), "true");
    const word = page.locator(".textLayer span").filter({ hasText: /^학교$/u }).first();
    const box = await word.boundingBox();
    await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
    await page.locator(".highlightEditor").first().waitFor();
    assert.equal(await page.locator("[data-misheel-popup]").count(), 0);
  });
  await test("Freehand drawing creates an Ink editor and native undo/redo preserve it", async () => {
    await tool("ink");
    await page.locator("#annotation-color").evaluate(input => { input.value = "#267351"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    const b = await page.locator('.page[data-page-number="1"] .annotationEditorLayer').boundingBox();
    await page.mouse.move(b.x + 100, b.y + 500); await page.mouse.down();
    for (let n = 0; n < 18; n++) await page.mouse.move(b.x + 100 + n * 9, b.y + 500 + Math.sin(n / 3) * 22);
    await page.mouse.up();
    await tool("read"); await tool("ink");
    await page.locator(".inkEditor").first().waitFor();
    await page.locator("#annotation-undo").click();
    await page.waitForFunction(() => document.querySelectorAll(".inkEditor").length === 0);
    await page.locator("#annotation-redo").click(); await page.locator(".inkEditor").first().waitFor();
  });
  await test("A native FreeText note supports Mongolian input and editor size controls", async () => {
    await tool("text");
    await page.locator("#text-size").selectOption("20");
    await page.locator("#annotation-color").evaluate(input => { input.value = "#c0265b"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    const b = await page.locator('.page[data-page-number="1"] .annotationEditorLayer').boundingBox();
    await page.mouse.click(b.x + 100, b.y + 550);
    const input = page.locator(".freeTextEditor [contenteditable='true']").last();
    await input.waitFor(); await input.fill("No");
    await page.keyboard.press("t"); await page.keyboard.insertText("e: Тэмдэглэл ӨөҮү 학교");
    assert.equal(await input.textContent(), "Note: Тэмдэглэл ӨөҮү 학교", "An ordinary t key must still type into a note");
    assert.equal(await input.evaluate(node => document.activeElement === node), true);
    await recordFocus("editingUnicodeNote");
    await page.keyboard.press("Alt+t"); await waitMode("read");
    await recordFocus("committedUnicodeNote");
    assert.equal(await page.locator(".freeTextEditor").last().textContent(), "Note: Тэмдэглэл ӨөҮү 학교", "Switching out of the active note must preserve all text without an extra t");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.misheelAnnotating), undefined);
    const word = page.locator(".textLayer span").filter({ hasText: /^학교$/u }).first();
    const wordBox = await word.boundingBox();
    await page.mouse.move(wordBox.x + 1, wordBox.y + wordBox.height / 2); await page.mouse.down();
    await page.mouse.move(wordBox.x + wordBox.width - 1, wordBox.y + wordBox.height / 2, { steps: 10 }); await page.mouse.up();
    const meaning = page.locator("[data-misheel-popup]").locator(".meaning").first();
    await meaning.waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.getSelection().toString()), "학교");
    assert.match(await meaning.textContent(), /сургуул/u, "Read mode must translate actual PDF selection after committing a note with Alt+T");
    assert.match(await page.locator("#save-status").textContent(), /Хадгалаагүй/u);
    await page.screenshot({ path: path.join(artifacts, "pdf-annotations-editor.png") });
  });
  let saved, annotations;
  await test("Saving writes interoperable Highlight, Ink and FreeText PDF annotation dictionaries", async () => {
    saved = await save("pdf-annotations-saved.pdf");
    annotations = await readAnnotations(saved);
    assert.ok(annotations.some(a => a.annotationType === 9 && a.quadPoints?.length >= 8));
    assert.ok(annotations.some(a => a.annotationType === 15 && a.inkLists?.[0]?.length >= 4));
    assert.deepEqual(annotations.find(a => a.annotationType === 15).color, [38, 115, 81]);
    assert.ok(annotations.some(a => a.annotationType === 3 && a.contents === "Note: Тэмдэглэл ӨөҮү 학교" && a.hasAppearance));
    const note = annotations.find(a => a.annotationType === 3);
    assert.equal(note.fontSize, 20);
    assert.ok(note.fontColor.every((value, index) => Math.abs(value - [192, 38, 91][index]) <= 1), "Saved note preserves the selected color within PDF.js DA rounding");
    const [appearance] = await readAppearances(saved);
    assert.equal(appearance.fontBytes.length, 2, "Mixed Cyrillic/Hangul text embeds both fallback font subsets");
    assert.ok(appearance.fontBytes.every(size => size > 0 && size < 100_000), "Bundled fonts are subset rather than fully embedded");
    assert.match(appearance.stream, /\/MisheelNote0 20 Tf/u);
    assert.match(appearance.stream, /\/MisheelNote1 20 Tf/u);
    assert.equal(appearance.image, false, "Supported Mongolian and Korean glyphs stay vector text");
    await writeFile(path.join(artifacts, "pdf-annotations-inspection.json"), JSON.stringify(annotations, null, 2));
    console.log("Saved annotation data:", JSON.stringify(annotations));
  });
  await test("Saved PDF reopens with visible annotations and an editable text note", async () => {
    assert.ok(saved, "First save must succeed");
    await page.locator("#file-input").setInputFiles(saved); await waitPage();
    await page.screenshot({ path: path.join(artifacts, "pdf-annotations-reopened.png") });
    await tool("text");
    const text = page.locator(".freeTextEditor").first();
    await text.waitFor(); await text.dblclick();
    const input = text.locator("[contenteditable='true']");
    await input.waitFor();
    assert.equal((await input.textContent()).replace(/\u00a0/gu, " "), "Note: Тэмдэглэл ӨөҮү 학교", "The note committed by Alt+T must reopen with its complete Unicode text");
    await input.fill("Edited note Тэмдэглэл ӨөҮү 학교");
    await tool("read");
    const edited = await save("pdf-annotations-edited.pdf");
    const changed = await readAnnotations(edited);
    assert.ok(changed.some(a => a.annotationType === 3 && a.contents === "Edited note Тэмдэглэл ӨөҮү 학교"));
    const [before] = await readAppearances(saved), [after] = await readAppearances(edited);
    assert.notEqual(after.stream, before.stream, "Changing an existing Unicode note refreshes its rendered text");
    assert.equal(after.fontBytes.length, 2);
    assert.ok(changed.some(a => a.annotationType === 9));
    assert.ok(changed.some(a => a.annotationType === 15));
  });
  await test("Deleting a reopened annotation is undoable and persists to the next PDF save", async () => {
    await tool("ink"); await page.locator(".inkEditor").first().click();
    await page.locator("#annotation-delete").click();
    await page.waitForFunction(() => document.querySelectorAll(".inkEditor").length === 0);
    await page.locator("#annotation-undo").click(); await page.locator(".inkEditor").first().waitFor();
    await page.locator(".inkEditor").first().click(); await page.locator("#annotation-delete").click();
    await tool("read"); const deleted = await save("pdf-annotations-deleted.pdf");
    const after = await readAnnotations(deleted);
    assert.equal(after.filter(a => a.annotationType === 15).length, 0);
    assert.ok(after.some(a => a.annotationType === 9));
  });
  await test("A slow save blocks editor keyboard changes until its PDF snapshot is downloaded", async () => {
    await page.evaluate(async ({ data, id }) => {
      const pdfjs = await import(`chrome-extension://${id}/vendor/pdfjs/pdf.mjs`);
      const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false });
      const doc = await task.promise;
      const proto = Object.getPrototypeOf(doc);
      globalThis.__savePrototype = proto;
      globalThis.__originalSaveDocument = proto.saveDocument;
      proto.saveDocument = async function (...args) {
        const snapshot = globalThis.__originalSaveDocument.apply(this, args);
        await new Promise(resolve => { globalThis.__releaseSave = resolve; });
        return snapshot;
      };
      await task.destroy();
    }, { data: [...await readFile(fixture)], id: extensionId });
    try {
      await tool("text");
      const originalText = await page.locator(".freeTextEditor").first().textContent();
      const download = page.waitForEvent("download");
      await page.locator("#save-pdf").click();
      await page.waitForFunction(() => document.getElementById("reader").inert && typeof globalThis.__releaseSave === "function");
      await page.keyboard.press("Alt+t");
      assert.equal(await page.locator("#tool-text").getAttribute("aria-pressed"), "true", "A shortcut during save must leave the editor mode unchanged");
      await page.keyboard.press("Control+z"); await page.keyboard.press("Delete"); await page.keyboard.type("MUTATION");
      assert.equal(await page.locator(".freeTextEditor").first().textContent(), originalText);
      assert.equal(await page.locator("#save-pdf").isDisabled(), true);
      await page.evaluate(() => globalThis.__releaseSave());
      const result = await download;
      const saved = path.join(artifacts, "pdf-annotations-slow-save.pdf"); await result.saveAs(saved);
      await page.waitForFunction(() => !document.getElementById("reader").inert);
      const annotations = await readAnnotations(saved);
      assert.ok(annotations.some(a => a.annotationType === 3 && a.contents === "Edited note Тэмдэглэл ӨөҮү 학교"));
      assert.doesNotMatch(await page.locator("#save-status").textContent(), /Хадгалаагүй/u);
      await tool("read");
    } finally {
      await page.evaluate(() => {
        globalThis.__releaseSave?.();
        globalThis.__savePrototype.saveDocument = globalThis.__originalSaveDocument;
        delete globalThis.__savePrototype; delete globalThis.__originalSaveDocument; delete globalThis.__releaseSave;
      });
    }
  });
  await test("Unsaved changes warn before replacing a document, and declining preserves it", async () => {
    await tool("text");
    const b = await page.locator('.page[data-page-number="1"] .annotationEditorLayer').boundingBox();
    await page.mouse.click(b.x + 300, b.y + 390);
    await page.locator(".freeTextEditor [contenteditable='true']").last().fill("Unsaved"); await tool("read");
    const filename = await page.locator("#document-name").textContent();
    page.once("dialog", async dialog => { assert.equal(dialog.type(), "confirm"); await dialog.dismiss(); });
    await page.locator("#file-input").setInputFiles(fixture); await pause(250);
    assert.equal(await page.locator("#document-name").textContent(), filename);
    assert.match(await page.locator(".freeTextEditor").last().textContent(), /Unsaved/u);
  });
  await test("An unreadable candidate PDF preserves the current document and unsaved annotations", async () => {
    const before = await page.locator("#document-name").textContent();
    await page.evaluate(() => {
      const slice = File.prototype.slice;
      globalThis.__originalFileSlice = slice;
      File.prototype.slice = function (...args) {
        const blob = slice.apply(this, args);
        if (this.name === "unreadable.pdf") blob.arrayBuffer = async () => { throw new Error("Unreadable test file"); };
        return blob;
      };
    });
    try {
      await page.locator("#file-input").setInputFiles({ name: "unreadable.pdf", mimeType: "application/pdf", buffer: await readFile(fixture) });
      await page.locator("#message").waitFor({ state: "visible" });
      assert.equal(await page.locator("#document-name").textContent(), before);
      assert.match(await page.locator(".freeTextEditor").last().textContent(), /Unsaved/u);
      assert.match(await page.locator("#save-status").textContent(), /Хадгалаагүй/u);
    } finally { await page.evaluate(() => { File.prototype.slice = globalThis.__originalFileSlice; delete globalThis.__originalFileSlice; }); }
  });
  await test("Unicode appearance repair honors native DA and rotation, preserves other notes, and falls back for emoji", async () => {
    const data = await page.evaluate(async id => {
      await import(`chrome-extension://${id}/vendor/pdf-lib/pdf-lib.min.js`);
      const { addUnicodeNoteAppearances } = await import(`chrome-extension://${id}/pdf-appearance.mjs`);
      const { PDFDocument, PDFHexString, PDFName } = globalThis.PDFLib;
      const pdf = await PDFDocument.create(), p = pdf.addPage([612, 792]);
      const original = pdf.context.register(pdf.context.flateStream("q Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 50] }));
      const untouched = pdf.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [20, 700, 220, 750],
        Contents: PDFHexString.fromText("Unrelated 학교"), DA: "/Helv 14 Tf 0 g", T: PDFHexString.fromText("Original author"), AP: { N: original } });
      const rotated = pdf.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [40, 40, 130, 370], Rotate: 90,
        Contents: PDFHexString.fromText("Тэмдэглэл ӨөҮү 학교\nSecond line 학교"), DA: "/Helv 22 Tf 0.1 0.3 0.5 rg", F: 4 });
      const emoji = pdf.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [150, 60, 450, 110],
        Contents: PDFHexString.fromText("Emoji 😀 학교"), DA: "/Helv 18 Tf 0.6 g", F: 4 });
      p.node.set(PDFName.of("Annots"), pdf.context.obj([untouched, rotated, emoji].map(annotation => pdf.context.register(annotation))));
      const bytes = await pdf.save();
      if (await addUnicodeNoteAppearances(bytes, []) !== bytes) throw new Error("An unchanged PDF must keep its native byte stream");
      const edits = [rotated, emoji].map(annotation => ({ annotationType: 3, pageIndex: 0, value: annotation.get(PDFName.of("Contents")).decodeText(),
        rect: annotation.get(PDFName.of("Rect")).asArray().map(n => n.asNumber()), fontSize: 7, color: [0, 0, 0], rotation: 0 }));
      return [...await addUnicodeNoteAppearances(bytes, edits)];
    }, extensionId);
    const filename = path.join(artifacts, "pdf-annotations-appearance-cases.pdf");
    await writeFile(filename, new Uint8Array(data));
    const [untouched, rotated, emoji] = await readAppearances(filename);
    assert.equal(untouched.stream, "q Q", "An unrelated native appearance remains intact");
    assert.equal(rotated.da, "/Helv 22 Tf 0.1 0.3 0.5 rg");
    assert.deepEqual(rotated.bbox, [0, 0, 330, 90]);
    assert.deepEqual(rotated.matrix, [0, 1, -1, 0, 90, 0]);
    assert.match(rotated.stream, /0\.1 0\.3 0\.5 rg/u);
    assert.match(rotated.stream, /\/MisheelNote0 22 Tf/u);
    assert.equal(rotated.fontBytes.length, 2);
    assert.equal(emoji.contents, "Emoji 😀 학교");
    assert.equal(emoji.image, true, "An unsupported emoji gets a visible PNG appearance while retaining its Contents");
    assert.equal(emoji.fontBytes.length, 0);
  });
  await test("All annotation editing, PDF serialization and reopened editing work offline without script errors", async () => {
    assert.deepEqual(network, []); assert.deepEqual(errors, []);
  });
} catch (error) {
  reports.push({ name: "Annotation browser setup", passed: false, error: error.stack }); console.error(error.stack);
} finally {
  if (page) await page.screenshot({ path: path.join(artifacts, "pdf-annotations-final.png") }).catch(() => {});
  if (context) await context.close();
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "pdf-annotations-browser-tests.json"), JSON.stringify({ date: new Date().toISOString(), browserVersion, reports, shortcutFocus, errors, network }, null, 2));
}
const failed = reports.filter(report => !report.passed);
console.log(`${reports.length - failed.length}/${reports.length} annotation browser checks passed.`);
if (failed.length) process.exitCode = 1;
