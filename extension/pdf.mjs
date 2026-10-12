import { getDocument, GlobalWorkerOptions, PasswordResponses, TextLayer } from "./vendor/pdfjs/pdf.mjs";

const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  "file-input", "open-file", "choose-file", "document-name", "toolbar", "previous-page", "next-page",
  "page-form", "page-number", "page-count", "zoom-out", "zoom-in", "zoom-reset", "fit-width", "message",
  "no-text", "reader", "empty-state", "page-stage", "page-shell", "busy", "busy-label", "reader-status",
  "drop-overlay", "password-dialog", "password-form", "password-hint", "pdf-password", "cancel-password",
].map((id) => [id, byId(id)]));
const assetUrl = (path) => chrome.runtime.getURL(`vendor/pdfjs/${path}`);
GlobalWorkerOptions.workerSrc = assetUrl("pdf.worker.mjs");

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const CSS_UNITS = 96 / 72;
const state = {
  document: null, loadingTask: null, page: null, renderTask: null, textTask: null,
  loadRequest: 0, renderRequest: 0, pageNumber: 1, zoom: 1, fit: true,
  passwordCallback: null, passwordRequest: 0, dragDepth: 0, lastReaderWidth: 0,
  remoteController: null,
};

function message(text = "", info = false) {
  ui.message.textContent = text;
  ui.message.hidden = !text;
  ui.message.classList.toggle("info", info);
}

function busy(value, label = "Хуудас ачаалж байна…") {
  ui.busy.hidden = !value;
  ui["busy-label"].textContent = label;
  ui["page-shell"].setAttribute("aria-busy", String(value));
  ui.reader.setAttribute("aria-busy", String(value));
}

function updateControls() {
  const document = state.document;
  const controls = ["previous-page", "next-page", "page-number", "zoom-out", "zoom-in", "zoom-reset", "fit-width"];
  for (const id of controls) ui[id].disabled = !document;
  ui.toolbar.hidden = !document;
  if (!document) return;
  ui["page-number"].value = String(state.pageNumber);
  ui["page-number"].max = String(document.numPages);
  ui["page-count"].textContent = String(document.numPages);
  ui["previous-page"].disabled = state.pageNumber <= 1;
  ui["next-page"].disabled = state.pageNumber >= document.numPages;
  ui["zoom-out"].disabled = !state.fit && state.zoom <= 0.25;
  ui["zoom-in"].disabled = !state.fit && state.zoom >= 3;
  ui["zoom-reset"].textContent = `${Math.round(state.zoom * 100)}%`;
  ui["fit-width"].setAttribute("aria-pressed", String(state.fit));
}

function cancelRendering() {
  state.renderRequest += 1;
  const tasks = [state.renderTask, state.textTask].filter(Boolean);
  state.renderTask = null;
  state.textTask = null;
  for (const task of tasks) task.cancel();
  return Promise.allSettled(tasks.map((task) => task.promise).filter(Boolean));
}

function closePassword() {
  state.passwordCallback = null;
  ui["pdf-password"].value = "";
  if (ui["password-dialog"].open) ui["password-dialog"].close();
}

function forgetDocument() {
  cancelRendering();
  closePassword();
  const previous = state.loadingTask;
  state.loadingTask = null;
  state.document = null;
  state.page = null;
  if (previous) previous.destroy().catch(() => {});
  window.getSelection()?.removeAllRanges();
  ui["page-shell"].replaceChildren();
  ui["page-shell"].style.width = "";
  ui["page-shell"].style.height = "";
  ui["page-stage"].hidden = true;
  ui["empty-state"].hidden = false;
  ui["no-text"].hidden = true;
  updateControls();
}

function beginLoad(name) {
  state.remoteController?.abort();
  state.remoteController = null;
  const request = ++state.loadRequest;
  // Stop an earlier pending open even when the new candidate later turns out
  // invalid. A fully opened document remains until validation succeeds.
  if (!state.document && !ui.busy.hidden) {
    forgetDocument();
    busy(false);
  }
  return request;
}

function showLoading(name) {
  forgetDocument();
  message();
  ui["document-name"].textContent = name;
  ui["document-name"].title = name;
  ui["reader-status"].textContent = "Файлыг төхөөрөмж дээр нээж байна";
  ui["empty-state"].hidden = true;
  busy(true, "PDF нээж байна…");
}

function hasPdfSignature(data) {
  return new TextDecoder("latin1").decode(data.subarray(0, 1024)).includes("%PDF-");
}

function errorText(error) {
  if (error?.name === "InvalidPDFException") return "PDF файлыг нээж чадсангүй. Файл гэмтсэн эсвэл PDF форматтай биш байна.";
  if (error?.name === "PasswordException") return "PDF файлын нууц үг буруу байна. Файлаа дахин нээгээд зөв нууц үгээ оруулна уу.";
  if (error?.name === "MissingPDFException") return "PDF файл олдсонгүй. Файлаа дахин сонгоно уу.";
  return "PDF-ийг нээхэд алдаа гарлаа. Өөр PDF сонгох эсвэл энэ файлаа дахин нээгээд үзээрэй.";
}

async function loadFile(file) {
  if (!file) return;
  const request = beginLoad();
  if (file.size > MAX_FILE_BYTES) {
    message("Энэ файл 200 МБ-аас том байна. Жижиг PDF файл сонгоно уу.");
    return;
  }
  if (!file.size) {
    message("Сонгосон файл хоосон байна. PDF файл сонгоно уу.");
    return;
  }
  try {
    const header = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    if (request !== state.loadRequest) return;
    if (!hasPdfSignature(header)) {
      message("Энэ файл PDF форматтай биш байна. .pdf файл сонгоно уу.");
      return;
    }
    showLoading(file.name);
    const data = new Uint8Array(await file.arrayBuffer());
    if (request !== state.loadRequest) return;
    await openBytes(data, request);
  } catch (error) {
    if (request !== state.loadRequest) return;
    forgetDocument();
    busy(false);
    message(errorText(error));
    ui["reader-status"].textContent = "Өөр PDF файл сонгоод дахин оролдоно уу";
  }
}

async function openBytes(data, request) {
    // The reader creates no annotation/scripting layer, never runs embedded
    // document JavaScript and loads only packaged CMaps/fonts/WASM resources.
    const task = getDocument({
      data, cMapUrl: assetUrl("cmaps/"), cMapPacked: true,
      standardFontDataUrl: assetUrl("standard_fonts/"), wasmUrl: assetUrl("wasm/"),
      isEvalSupported: false, useWorkerFetch: false, enableXfa: false,
    });
    state.loadingTask = task;
    task.onProgress = ({ loaded, total }) => {
      if (request !== state.loadRequest) return;
      if (total > 0 && loaded < total) ui["busy-label"].textContent = `PDF нээж байна… ${Math.round(loaded / total * 100)}%`;
    };
    task.onPassword = (callback, reason) => {
      if (request !== state.loadRequest) return;
      state.passwordCallback = callback;
      state.passwordRequest = request;
      ui["password-hint"].textContent = reason === PasswordResponses.INCORRECT_PASSWORD
        ? "Нууц үг буруу байна. Дахин оруулна уу."
        : "Файлыг нээхийн тулд нууц үгийг оруулна уу.";
      ui["pdf-password"].value = "";
      if (!ui["password-dialog"].open) ui["password-dialog"].showModal();
      ui["pdf-password"].focus();
    };
    const document = await task.promise;
    if (request !== state.loadRequest) { await task.destroy(); return; }
    closePassword();
    state.document = document;
    state.pageNumber = 1;
    state.fit = true;
    state.zoom = 1;
    updateControls();
    await renderPage();
}

async function readResponse(response, request) {
  const length = Number(response.headers.get("content-length")) || 0;
  if (length > MAX_FILE_BYTES) throw new Error("FileTooLarge");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_FILE_BYTES) throw new Error("FileTooLarge");
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (request !== state.loadRequest) throw new Error("Superseded");
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) throw new Error("FileTooLarge");
      chunks.push(value);
      if (length > 0) ui["busy-label"].textContent = `PDF татаж байна… ${Math.min(100, Math.round(size / length * 100))}%`;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

async function openUrl(value) {
  let url;
  try { url = new URL(value); } catch { message("PDF-ийн холбоос буруу байна. PDF файл сонгож нээгээрэй."); return; }
  if (!["file:", "http:", "https:"].includes(url.protocol) || url.username || url.password) {
    message("Энэ холбоосоос PDF нээх боломжгүй. PDF файл сонгож нээгээрэй.");
    return;
  }
  const request = beginLoad();
  if (url.protocol === "file:") {
    const allowed = await new Promise((resolve) => chrome.extension.isAllowedFileSchemeAccess(resolve));
    if (request !== state.loadRequest) return;
    if (!allowed) {
      message("Компьютерийн PDF-ийг шууд нээхийн тулд extension-ийн тохиргоонд «Allow access to file URLs»-ийг асаана уу. Эсвэл «PDF нээх» товчоор файлаа сонгоорой.", true);
      return;
    }
  }
  let name = url.pathname.split("/").filter(Boolean).pop() || "PDF файл";
  try { name = decodeURIComponent(name); } catch { /* Preserve a malformed escaped filename as plain text. */ }
  showLoading(name);
  const controller = new AbortController();
  state.remoteController = controller;
  ui["busy-label"].textContent = "PDF татаж байна…";
  try {
    const response = await fetch(url.href, { credentials: "include", signal: controller.signal });
    if (!response.ok) throw new Error("HttpError");
    const data = await readResponse(response, request);
    if (request !== state.loadRequest) return;
    if (!hasPdfSignature(data)) throw new Error("NotPdf");
    state.remoteController = null;
    await openBytes(data, request);
  } catch (error) {
    if (request !== state.loadRequest) return;
    state.remoteController = null;
    forgetDocument();
    busy(false);
    message(error?.message === "FileTooLarge"
      ? "Энэ PDF 200 МБ-аас том байна. Жижиг PDF сонгоно уу."
      : "Холбоосоос PDF нээж чадсангүй. Сайтын нэвтрэлт эсвэл хандалтын тохиргоо нээхийг хязгаарласан байж болно. PDF-ээ компьютерт хадгалаад «PDF нээх» товчоор сонгоорой.");
    ui["reader-status"].textContent = "PDF файл сонгож нээх боломжтой";
  }
}

async function renderPage() {
  const document = state.document;
  if (!document) return;
  const settled = cancelRendering();
  const request = state.renderRequest;
  const pageNumber = state.pageNumber;
  const current = () => request === state.renderRequest && document === state.document;
  window.getSelection()?.removeAllRanges();
  ui["no-text"].hidden = true;
  ui["page-shell"].replaceChildren();
  ui["page-stage"].hidden = false;
  busy(true, `${pageNumber}-р хуудас ачаалж байна…`);
  try {
    await settled;
    if (!current()) return;
    const previousPage = state.page;
    const page = await document.getPage(pageNumber);
    if (!current()) return;
    if (previousPage && previousPage !== page) previousPage.cleanup();
    state.page = page;
    const baseViewport = page.getViewport({ scale: CSS_UNITS });
    if (state.fit) {
      const padding = window.innerWidth <= 640 ? 32 : 64;
      state.zoom = Math.max(0.1, Math.min(3, (ui.reader.clientWidth - padding) / baseViewport.width));
    }
    const viewport = page.getViewport({ scale: state.zoom * CSS_UNITS });
    if (!(viewport.width > 0 && viewport.height > 0) || viewport.width > 50000 || viewport.height > 50000) {
      throw new Error("Unsupported page dimensions");
    }
    updateControls();
    const canvas = window.document.createElement("canvas");
    const textContainer = window.document.createElement("div");
    textContainer.className = "textLayer";
    textContainer.lang = "ko";
    textContainer.hidden = true;
    canvas.setAttribute("aria-hidden", "true");
    const outputScale = Math.min(window.devicePixelRatio || 1, 2,
      Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
      8192 / viewport.width, 8192 / viewport.height);
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ui["page-shell"].style.width = `${viewport.width}px`;
    ui["page-shell"].style.height = `${viewport.height}px`;
    ui["page-shell"].style.setProperty("--scale-factor", String(viewport.scale));
    ui["page-shell"].style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit));
    ui["page-shell"].replaceChildren(canvas, textContainer);
    const renderTask = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      background: "rgb(255,255,255)", annotationMode: 0,
    });
    state.renderTask = renderTask;
    const [, textContent] = await Promise.all([renderTask.promise, page.getTextContent()]);
    if (!current()) return;
    const textTask = new TextLayer({ textContentSource: textContent, container: textContainer, viewport });
    state.textTask = textTask;
    await textTask.render();
    if (!current()) return;
    textContainer.hidden = false;
    state.renderTask = null;
    state.textTask = null;
    ui["no-text"].hidden = textContent.items.some((item) => item.str?.trim());
    ui["reader-status"].textContent = `${pageNumber} / ${document.numPages} хуудас · Солонгос үгээ сонгоорой`;
    busy(false);
  } catch (error) {
    if (!current()) return;
    cancelRendering();
    busy(false);
    message("Энэ хуудсыг харуулж чадсангүй. Дараагийн хуудас руу шилжих эсвэл өөр PDF сонгоно уу.");
    ui["reader-status"].textContent = "Хуудсыг харуулахад алдаа гарлаа";
  }
}

function goToPage(value) {
  if (!state.document) return;
  const page = Math.max(1, Math.min(state.document.numPages, Math.trunc(Number(value) || 1)));
  ui["page-number"].value = String(page);
  if (page === state.pageNumber) return;
  state.pageNumber = page;
  ui.reader.scrollTo(0, 0);
  message();
  updateControls();
  void renderPage();
}

function zoom(value) {
  if (!state.document) return;
  state.fit = false;
  state.zoom = Math.max(0.25, Math.min(3, value));
  updateControls();
  void renderPage();
}

const chooseFile = () => ui["file-input"].click();
ui["open-file"].addEventListener("click", chooseFile);
ui["choose-file"].addEventListener("click", chooseFile);
ui["file-input"].addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  void loadFile(file);
});
ui["previous-page"].addEventListener("click", () => goToPage(state.pageNumber - 1));
ui["next-page"].addEventListener("click", () => goToPage(state.pageNumber + 1));
ui["page-form"].addEventListener("submit", (event) => { event.preventDefault(); goToPage(ui["page-number"].value); });
ui["page-number"].addEventListener("change", () => goToPage(ui["page-number"].value));
ui["zoom-out"].addEventListener("click", () => zoom(state.zoom / 1.2));
ui["zoom-in"].addEventListener("click", () => zoom(state.zoom * 1.2));
ui["zoom-reset"].addEventListener("click", () => zoom(1));
ui["fit-width"].addEventListener("click", () => {
  if (!state.document) return;
  state.fit = true;
  updateControls();
  void renderPage();
});
ui["password-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  const callback = state.passwordCallback;
  if (!callback || state.passwordRequest !== state.loadRequest) return;
  const password = ui["pdf-password"].value;
  closePassword();
  callback(password);
});
function cancelPassword() {
  state.loadRequest += 1;
  forgetDocument();
  busy(false);
  message("Нууц үгтэй PDF нээхийг цуцаллаа.", true);
  ui["reader-status"].textContent = "Унших PDF файлаа сонгоорой";
}
ui["cancel-password"].addEventListener("click", cancelPassword);
ui["password-dialog"].addEventListener("cancel", (event) => { event.preventDefault(); cancelPassword(); });

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || ui["password-dialog"].open) return;
  const editable = event.composedPath().some((node) => node instanceof Element && node.matches("input, textarea, select, [contenteditable='true']"));
  const insideCard = event.composedPath().some((node) => node instanceof Element && node.hasAttribute("data-misheel-popup"));
  if (editable || insideCard) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); chooseFile(); return; }
  if (!state.document || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || window.getSelection()?.toString() || window.document.querySelector("[data-misheel-popup]")) return;
  if (["ArrowLeft", "PageUp"].includes(event.key)) { event.preventDefault(); goToPage(state.pageNumber - 1); }
  else if (["ArrowRight", "PageDown"].includes(event.key)) { event.preventDefault(); goToPage(state.pageNumber + 1); }
});

const draggingFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (event) => {
  if (!draggingFiles(event) || ui["password-dialog"].open) return;
  event.preventDefault(); state.dragDepth += 1; ui["drop-overlay"].hidden = false;
});
window.addEventListener("dragover", (event) => { if (draggingFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } });
window.addEventListener("dragleave", (event) => {
  if (!draggingFiles(event)) return;
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (!state.dragDepth) ui["drop-overlay"].hidden = true;
});
window.addEventListener("drop", (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault(); state.dragDepth = 0; ui["drop-overlay"].hidden = true;
  if (ui["password-dialog"].open) return;
  const files = [...event.dataTransfer.files];
  if (files.length !== 1) { message("Нэг PDF файл сонгож оруулна уу."); return; }
  void loadFile(files[0]);
});
window.addEventListener("blur", () => { state.dragDepth = 0; ui["drop-overlay"].hidden = true; });

let resizeTimer;
new ResizeObserver(() => {
  const width = ui.reader.clientWidth;
  if (Math.abs(width - state.lastReaderWidth) <= 1) return;
  state.lastReaderWidth = width;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.document && state.fit) void renderPage(); }, 150);
}).observe(ui.reader);
window.addEventListener("pagehide", () => { state.loadRequest += 1; state.remoteController?.abort(); forgetDocument(); });
updateControls();
const requestedFile = new URLSearchParams(window.location.search).get("file");
if (requestedFile) void openUrl(requestedFile);
