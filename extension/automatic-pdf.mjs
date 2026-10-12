const ALLOWED_PROTOCOLS = new Set(["file:", "http:", "https:"]);

export function pdfSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!ALLOWED_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

export function looksLikePdfUrl(value) {
  const url = pdfSourceUrl(value);
  return Boolean(url && /\.pdf$/iu.test(url.pathname));
}

export function isInlinePdfResponse(details) {
  if (details.type !== "main_frame" || details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 400) return false;
  const headers = new Map((details.responseHeaders || []).map(header => [header.name.toLowerCase(), header.value || ""]));
  return /^application\/pdf(?:\s*;|\s*$)/iu.test(headers.get("content-type") || "") &&
    !/^attachment(?:\s*;|\s*$)/iu.test(headers.get("content-disposition") || "");
}

export function readerUrl(readerBase, source) {
  const url = new URL(readerBase);
  url.searchParams.set("file", source);
  return url.href;
}

export function installAutomaticPdf(api) {
  const pendingTabs = new Set();
  const getSettings = () => api.storage.local.get({ autoPdf: true });

  async function redirect(tabId, source) {
    const sourceUrl = pdfSourceUrl(source);
    if (!sourceUrl || pendingTabs.has(tabId)) return;
    pendingTabs.add(tabId);
    try {
      if ((await getSettings()).autoPdf === false) return;
      const tab = await api.tabs.get(tabId);
      const activeUrl = tab.pendingUrl || tab.url;
      if (!activeUrl || activeUrl.startsWith(api.runtime.getURL(""))) return;
      // A delayed response from an earlier page must never redirect a newer tab.
      const current = pdfSourceUrl(activeUrl);
      if (!current || current.href.split("#")[0] !== sourceUrl.href.split("#")[0]) return;
      await api.tabs.update(tabId, { url: readerUrl(api.runtime.getURL("pdf.html"), current.href) });
    } catch { /* Closed tabs and revoked file/site access keep the browser viewer. */ }
    finally { pendingTabs.delete(tabId); }
  }

  api.webRequest.onHeadersReceived.addListener(details => {
    if (isInlinePdfResponse(details)) void redirect(details.tabId, details.url);
  }, { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }, ["responseHeaders"]);

  api.tabs.onUpdated.addListener((tabId, changes, tab) => {
    const source = changes.url || tab.url;
    if ((changes.url || changes.status === "loading") && source?.startsWith("file:") && looksLikePdfUrl(source)) {
      void redirect(tabId, source);
    }
  });

  async function existingHttpPdf(source) {
    // Only inspect already-open PDF candidates, reading at most their header.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(source, { credentials: "include", headers: { Range: "bytes=0-1023" }, signal: controller.signal });
      if (!response.ok) return false;
      if (/^application\/pdf(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") || "")) {
        await response.body?.cancel(); return true;
      }
      const stream = response.body?.getReader();
      if (!stream) return false;
      const { value } = await stream.read();
      await stream.cancel();
      return Boolean(value && new TextDecoder("latin1").decode(value.subarray(0, 1024)).includes("%PDF-"));
    } catch { return false; }
    finally { clearTimeout(timeout); controller.abort(); }
  }

  async function routeOpenPdfTabs() {
    if ((await getSettings()).autoPdf === false) return;
    const tabs = await api.tabs.query({});
    await Promise.allSettled(tabs.map(async tab => {
      if (!tab.url || !pdfSourceUrl(tab.url) || !(looksLikePdfUrl(tab.url) || /\.pdf(?:\s|$)/iu.test(tab.title || ""))) return;
      if (tab.url.startsWith("file:") || await existingHttpPdf(tab.url)) await redirect(tab.id, tab.url);
    }));
  }
  api.runtime.onInstalled.addListener(() => { void routeOpenPdfTabs(); });
  api.runtime.onStartup.addListener(() => { void routeOpenPdfTabs(); });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.autoPdf?.newValue === true) void routeOpenPdfTabs();
  });
}
