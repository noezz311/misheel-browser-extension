import test from "node:test";
import assert from "node:assert/strict";
import { pdfSourceUrl, looksLikePdfUrl, isInlinePdfResponse, readerUrl, installAutomaticPdf } from "../extension/automatic-pdf.mjs";

test("PDF source parsing preserves query/fragment and rejects unsupported or credential URLs", () => {
  assert.ok(looksLikePdfUrl("file:///C:/Books/%ED%95%99%EA%B5%90.PDF#page=4"));
  assert.ok(looksLikePdfUrl("https://example.com/book.pdf?token=a&part=2"));
  assert.equal(pdfSourceUrl("javascript:alert(1)"), null);
  assert.equal(pdfSourceUrl("https://user:pass@example.com/book.pdf"), null);
  const source = "https://example.com/book.pdf?token=a&part=2#page=4";
  assert.equal(new URL(readerUrl("chrome-extension://test/pdf.html", source)).searchParams.get("file"), source);
});

test("automatic HTTP routing uses inline PDF MIME and ignores HTML, downloads, frames and errors", () => {
  const details = { tabId: 1, type: "main_frame", statusCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/pdf; charset=binary" }] };
  assert.equal(isInlinePdfResponse(details), true);
  assert.equal(isInlinePdfResponse({ ...details, type: "sub_frame" }), false);
  assert.equal(isInlinePdfResponse({ ...details, statusCode: 404 }), false);
  assert.equal(isInlinePdfResponse({ ...details, responseHeaders: [{ name: "Content-Type", value: "text/html" }] }), false);
  assert.equal(isInlinePdfResponse({ ...details, responseHeaders: [...details.responseHeaders, { name: "Content-Disposition", value: "attachment; filename=book.pdf" }] }), false);
});

function event() { const listeners = []; return { listeners, addListener(fn) { listeners.push(fn); } }; }
function mock(currentTab, autoPdf = true) {
  const updates = [];
  const api = {
    runtime: { getURL: path => `chrome-extension://test/${path}`, onInstalled: event(), onStartup: event() },
    storage: { local: { get: async () => ({ autoPdf }) }, onChanged: event() },
    tabs: { get: async () => currentTab, update: async (id, properties) => updates.push({ id, ...properties }), query: async () => [], onUpdated: event() },
    webRequest: { onHeadersReceived: event() }
  };
  installAutomaticPdf(api);
  const fire = source => api.webRequest.onHeadersReceived.listeners[0]({ tabId: 7, url: source, type: "main_frame", statusCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/pdf" }] });
  return { fire, updates };
}

test("new PDF navigation routes from pendingUrl even before a current URL is available", async () => {
  const source = "https://example.com/book.pdf";
  const { fire, updates } = mock({ pendingUrl: source });
  fire(source);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, 1);
  assert.equal(new URL(updates[0].url).searchParams.get("file"), source);
});

test("a stale response or disabled preference never replaces the current tab", async () => {
  const stale = mock({ url: "https://example.com/new-page" });
  stale.fire("https://example.com/old.pdf");
  const disabled = mock({ url: "https://example.com/book.pdf" }, false);
  disabled.fire("https://example.com/book.pdf");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stale.updates.length, 0);
  assert.equal(disabled.updates.length, 0);
});
