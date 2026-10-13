import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { addUnicodeNoteAppearances } from "./pdf-appearance.mjs";
// The generic viewer consumes the same PDF.js namespace as the packaged core.
globalThis.pdfjsLib = pdfjsLib;
const { PDFViewer, EventBus, PDFLinkService, LinkTarget, ScrollMode, RenderingStates } = await import("./vendor/pdfjs/pdf_viewer.mjs");
const { getDocument, GlobalWorkerOptions, PasswordResponses, AnnotationEditorType, AnnotationEditorParamsType, AnnotationMode } = pdfjsLib;

const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  "file-input", "open-file", "choose-file", "document-name", "toolbar", "previous-page", "next-page",
  "page-form", "page-number", "page-count", "zoom-out", "zoom-in", "zoom-reset", "fit-width", "message",
  "no-text", "reader", "empty-state", "page-stage", "page-shell", "busy", "busy-label", "reader-status",
  "drop-overlay", "password-dialog", "password-form", "password-hint", "pdf-password", "cancel-password",
  "annotation-toolbar", "tool-read", "tool-highlight", "tool-ink", "tool-text", "annotation-options",
  "annotation-color", "pen-size-label", "pen-size", "text-size-label", "text-size", "annotation-undo",
  "annotation-redo", "annotation-delete", "save-pdf", "save-status",
].map((id) => [id, byId(id)]));
const assetUrl = (path) => chrome.runtime.getURL(`vendor/pdfjs/${path}`);
GlobalWorkerOptions.workerSrc = assetUrl("pdf.worker.mjs");

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const state = {
  document: null, loadingTask: null,
  loadRequest: 0, pageNumber: 1, zoom: 1, fit: true,
  passwordCallback: null, passwordRequest: 0, dragDepth: 0, lastReaderWidth: 0,
  remoteController: null, editor: null, mode: AnnotationEditorType.NONE, dirty: false, saving: false, editRevision: 0,
  filename: "document.pdf", sourceUrl: null, initialHash: "", editorStates: {}, editorDefaultsSet: false,
  pageHasText: new Map(),
  colors: { [AnnotationEditorType.HIGHLIGHT]: "#fff066", [AnnotationEditorType.INK]: "#267351", [AnnotationEditorType.FREETEXT]: "#20352c" },
};

const eventBus = new EventBus();
class SafeLinkService extends PDFLinkService {
  addLinkAttributes(link, value) {
    let url;
    try { url = new URL(value, this.baseUrl || window.location.href); } catch { /* An invalid PDF link stays disabled. */ }
    if (!url || !["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password) {
      link.removeAttribute("href");
      link.title = "Энэ холбоосыг нээх боломжгүй";
      link.onclick = () => false;
      return;
    }
    super.addLinkAttributes(link, url.href, true);
  }
}
const linkService = new SafeLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: "noopener noreferrer" });
const viewer = new PDFViewer({
  container: ui.reader, viewer: ui["page-shell"], eventBus, linkService,
  annotationEditorMode: AnnotationEditorType.NONE, annotationMode: AnnotationMode.ENABLE,
  annotationEditorHighlightColors: "Шар=#fff066,Ногоон=#a6e8a1,Цэнхэр=#9bd8ff,Ягаан=#ffb7d2",
  enableHighlightFloatingButton: false, enableAutoLinking: false, enableDetailCanvas: false,
  maxCanvasPixels: 16_000_000, maxCanvasDim: 8192, imageResourcesPath: assetUrl("images/"),
});
linkService.setViewer(viewer);
viewer.scrollMode = ScrollMode.VERTICAL; // Continuous pages retain native editable annotation layers.

function commitAnnotations() {
  state.editor?.commitOrRemove();
  state.editor?.currentLayer?.endDrawingSession(false);
}

function markDirty() {
  state.editRevision += 1;
  state.dirty = true;
  ui["save-status"].textContent = "Хадгалаагүй өөрчлөлттэй";
}

function allowReplace() {
  if (state.saving) return false;
  commitAnnotations();
  return !state.dirty || window.confirm("Тэмдэглэгээний өөрчлөлтийг хадгалаагүй байна. Хадгалахгүйгээр өөр PDF нээх үү?");
}

function updateAnnotationControls() {
  const ready = !!state.document && !!state.editor && !state.saving;
  ui["annotation-toolbar"].hidden = !state.document;
  const modes = { read: AnnotationEditorType.NONE, highlight: AnnotationEditorType.HIGHLIGHT, ink: AnnotationEditorType.INK, text: AnnotationEditorType.FREETEXT };
  for (const [name, mode] of Object.entries(modes)) {
    ui[`tool-${name}`].disabled = !ready;
    ui[`tool-${name}`].setAttribute("aria-pressed", String(mode === state.mode));
  }
  ui["annotation-options"].hidden = state.mode === AnnotationEditorType.NONE;
  ui["pen-size-label"].hidden = state.mode !== AnnotationEditorType.INK;
  ui["text-size-label"].hidden = state.mode !== AnnotationEditorType.FREETEXT;
  ui["annotation-undo"].disabled = !ready || !state.editorStates.hasSomethingToUndo;
  ui["annotation-redo"].disabled = !ready || !state.editorStates.hasSomethingToRedo;
  ui["annotation-delete"].disabled = !ready || !state.editorStates.hasSelectedEditor;
  ui["save-pdf"].disabled = !ready;
  for (const id of ["annotation-color", "pen-size", "text-size"]) ui[id].disabled = !ready;
  ui["open-file"].disabled = state.saving;
}

function modeChanged(mode) {
  state.mode = mode;
  if (mode === AnnotationEditorType.NONE) delete document.documentElement.dataset.misheelAnnotating;
  else document.documentElement.dataset.misheelAnnotating = "true";
  if (state.colors[mode]) ui["annotation-color"].value = state.colors[mode];
  updateAnnotationControls();
  updateStatus();
}

function setMode(mode) {
  if (!state.editor || state.saving) return;
  // Block the dictionary immediately; switching existing annotation layers can
  // finish asynchronously after the underlying page is re-rendered.
  if (mode !== AnnotationEditorType.NONE) document.documentElement.dataset.misheelAnnotating = "true";
  viewer.annotationEditorMode = { mode };
}

function updateStatus() {
  if (!state.document) return;
  const hints = {
    [AnnotationEditorType.NONE]: "Солонгос үгээ сонгоорой",
    [AnnotationEditorType.HIGHLIGHT]: "Текстээ сонгож тодруулаарай",
    [AnnotationEditorType.INK]: "Хуудас дээр зурж тэмдэглээрэй",
    [AnnotationEditorType.FREETEXT]: "Хуудас дээр дарж текст бичээрэй",
  };
  ui["reader-status"].textContent = `${state.pageNumber} / ${state.document.numPages} хуудас · ${hints[state.mode] || hints[AnnotationEditorType.NONE]}`;
}

eventBus.on("annotationeditoruimanager", ({ uiManager }) => {
  state.editor = uiManager;
  // AnnotationStorage keeps mutable editor objects and only calls
  // onSetModified when an object is first inserted. Track native commands too,
  // including later color/move/delete changes and keyboard undo after a save.
  const addCommands = uiManager.addCommands.bind(uiManager);
  uiManager.addCommands = (params) => { addCommands(params); markDirty(); };
  for (const action of ["undo", "redo"]) {
    const original = uiManager[action].bind(uiManager);
    uiManager[action] = () => {
      const available = state.editorStates[action === "undo" ? "hasSomethingToUndo" : "hasSomethingToRedo"];
      original();
      if (available) markDirty();
    };
  }
  updateAnnotationControls();
});
eventBus.on("switchannotationeditormode", (options) => { if (state.editor) viewer.annotationEditorMode = options; });
eventBus.on("annotationeditormodechanged", ({ mode }) => modeChanged(mode));
eventBus.on("editingstateschanged", ({ details }) => { state.editorStates = { ...details }; updateAnnotationControls(); });
eventBus.on("annotationeditorparamschanged", ({ details }) => {
  const colorTypes = { [AnnotationEditorParamsType.HIGHLIGHT_COLOR]: AnnotationEditorType.HIGHLIGHT, [AnnotationEditorParamsType.INK_COLOR]: AnnotationEditorType.INK, [AnnotationEditorParamsType.FREETEXT_COLOR]: AnnotationEditorType.FREETEXT };
  for (const [type, value] of details) {
    const mode = colorTypes[type];
    if (mode !== undefined && typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
      state.colors[mode] = value;
      if (state.mode === mode) ui["annotation-color"].value = value;
    }
    if (type === AnnotationEditorParamsType.INK_THICKNESS) ui["pen-size"].value = String(value);
    if (type === AnnotationEditorParamsType.FREETEXT_SIZE) ui["text-size"].value = String(value);
  }
});
eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = "page-width";
  if (state.initialHash) linkService.setHash(state.initialHash);
  updateControls();
});
eventBus.on("pagechanging", ({ pageNumber }) => {
  commitAnnotations();
  if (state.mode === AnnotationEditorType.NONE) window.getSelection()?.removeAllRanges();
  state.pageNumber = pageNumber;
  ui["no-text"].hidden = state.pageHasText.get(pageNumber) !== false;
  const pageView = viewer.getPageView(pageNumber - 1);
  busy(pageView?.renderingState !== RenderingStates.FINISHED, `${pageNumber}-р хуудас ачаалж байна…`);
  updateControls(); updateStatus();
});
eventBus.on("scalechanging", ({ scale }) => { state.zoom = scale; updateControls(); });
eventBus.on("pagerender", ({ pageNumber }) => { if (pageNumber === state.pageNumber) busy(true, `${pageNumber}-р хуудас ачаалж байна…`); });
eventBus.on("pagerendered", ({ pageNumber, error }) => {
  if (pageNumber !== state.pageNumber) return;
  busy(false);
  if (error) message("Энэ хуудсыг харуулж чадсангүй. Дараагийн хуудас руу шилжих эсвэл өөр PDF сонгоно уу.");
  updateStatus();
});
eventBus.on("textlayerrendered", ({ pageNumber, source }) => {
  const hasText = [...source.div.querySelectorAll(".textLayer span")].some(span => span.textContent.trim());
  state.pageHasText.set(pageNumber, hasText);
  if (pageNumber !== state.pageNumber) return;
  ui["no-text"].hidden = hasText;
});
eventBus.on("annotationeditorlayerrendered", () => {
  if (!state.editor || state.editorDefaultsSet) return;
  state.editorDefaultsSet = true;
  for (const [type, value] of [
    [AnnotationEditorParamsType.HIGHLIGHT_COLOR, state.colors[AnnotationEditorType.HIGHLIGHT]],
    [AnnotationEditorParamsType.INK_COLOR, state.colors[AnnotationEditorType.INK]],
    [AnnotationEditorParamsType.FREETEXT_COLOR, state.colors[AnnotationEditorType.FREETEXT]],
    [AnnotationEditorParamsType.INK_THICKNESS, 2], [AnnotationEditorParamsType.FREETEXT_SIZE, 16],
  ]) state.editor.updateParams(type, value);
});

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
  for (const id of controls) ui[id].disabled = !document || state.saving;
  ui.toolbar.hidden = !document;
  if (!document) return;
  ui["page-number"].value = String(state.pageNumber);
  ui["page-number"].max = String(document.numPages);
  ui["page-count"].textContent = String(document.numPages);
  ui["previous-page"].disabled = state.saving || state.pageNumber <= 1;
  ui["next-page"].disabled = state.saving || state.pageNumber >= document.numPages;
  ui["zoom-out"].disabled = state.saving || (!state.fit && state.zoom <= 0.25);
  ui["zoom-in"].disabled = state.saving || (!state.fit && state.zoom >= 3);
  ui["zoom-reset"].textContent = `${Math.round(state.zoom * 100)}%`;
  ui["fit-width"].setAttribute("aria-pressed", String(state.fit));
  updateAnnotationControls();
}

function closePassword() {
  state.passwordCallback = null;
  ui["pdf-password"].value = "";
  if (ui["password-dialog"].open) ui["password-dialog"].close();
}

function forgetDocument() {
  closePassword();
  const previous = state.loadingTask;
  state.loadingTask = null;
  state.document = null;
  viewer.setDocument(null);
  linkService.setDocument(null);
  state.editor = null;
  state.editorDefaultsSet = false;
  state.editorStates = {};
  state.pageHasText.clear();
  state.dirty = false;
  state.editRevision = 0;
  ui["save-status"].textContent = "";
  modeChanged(AnnotationEditorType.NONE);
  if (previous) previous.destroy().catch(() => {});
  window.getSelection()?.removeAllRanges();
  ui["page-shell"].replaceChildren();
  ui["page-shell"].style.width = "";
  ui["page-shell"].style.height = "";
  ui["page-stage"].hidden = true;
  ui["empty-state"].hidden = false;
  ui["no-text"].hidden = true;
  updateControls();
  updateAnnotationControls();
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
  state.filename = name;
  state.sourceUrl = null;
  state.initialHash = "";
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
  let replacementStarted = false;
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
    if (!allowReplace()) return;
    replacementStarted = true;
    showLoading(file.name);
    const data = new Uint8Array(await file.arrayBuffer());
    if (request !== state.loadRequest) return;
    await openBytes(data, request);
  } catch (error) {
    if (request !== state.loadRequest) return;
    if (replacementStarted || !state.document) {
      forgetDocument();
      busy(false);
    }
    message(errorText(error));
    if (!state.document) ui["reader-status"].textContent = "Өөр PDF файл сонгоод дахин оролдоно уу";
  }
}

async function openBytes(data, request) {
    // No scripting manager is installed. Embedded PDF JavaScript is never run;
    // fonts, CMaps, WASM and editor resources come from the packaged extension.
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
    document.annotationStorage.onSetModified = markDirty;
    document.annotationStorage.onResetModified = () => {};
    updateControls();
    ui["page-stage"].hidden = false;
    linkService.setDocument(document, state.sourceUrl);
    viewer.setDocument(document);
    updateStatus();
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
  if (!allowReplace()) return;
  let name = url.pathname.split("/").filter(Boolean).pop() || "PDF файл";
  try { name = decodeURIComponent(name); } catch { /* Preserve a malformed escaped filename as plain text. */ }
  showLoading(name);
  state.sourceUrl = url.href.split("#")[0];
  state.initialHash = url.hash.slice(1);
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

function goToPage(value) {
  if (!state.document || state.saving) return;
  const page = Math.max(1, Math.min(state.document.numPages, Math.trunc(Number(value) || 1)));
  ui["page-number"].value = String(page);
  if (page === state.pageNumber) return;
  commitAnnotations();
  message();
  viewer.currentPageNumber = page;
}

function zoom(value) {
  if (!state.document || state.saving) return;
  state.fit = false;
  commitAnnotations();
  state.zoom = Math.max(0.25, Math.min(3, value));
  viewer.currentScaleValue = String(state.zoom);
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
  commitAnnotations();
  viewer.currentScaleValue = "page-width";
});

for (const [name, mode] of Object.entries({ read: AnnotationEditorType.NONE, highlight: AnnotationEditorType.HIGHLIGHT, ink: AnnotationEditorType.INK, text: AnnotationEditorType.FREETEXT })) {
  ui[`tool-${name}`].addEventListener("click", () => setMode(mode));
}
ui["annotation-color"].addEventListener("input", () => {
  const types = { [AnnotationEditorType.HIGHLIGHT]: AnnotationEditorParamsType.HIGHLIGHT_COLOR, [AnnotationEditorType.INK]: AnnotationEditorParamsType.INK_COLOR, [AnnotationEditorType.FREETEXT]: AnnotationEditorParamsType.FREETEXT_COLOR };
  if (types[state.mode] === undefined || state.saving) return;
  state.colors[state.mode] = ui["annotation-color"].value;
  state.editor?.updateParams(types[state.mode], ui["annotation-color"].value);
});
ui["pen-size"].addEventListener("change", () => state.editor?.updateParams(AnnotationEditorParamsType.INK_THICKNESS, Number(ui["pen-size"].value)));
ui["text-size"].addEventListener("change", () => state.editor?.updateParams(AnnotationEditorParamsType.FREETEXT_SIZE, Number(ui["text-size"].value)));
for (const action of ["undo", "redo", "delete"]) {
  // Keeping focus on the editor preserves its selection until the action runs.
  ui[`annotation-${action}`].addEventListener("pointerdown", (event) => event.preventDefault());
  ui[`annotation-${action}`].addEventListener("click", () => {
    if (state.saving) return;
    commitAnnotations();
    eventBus.dispatch("editingaction", { source: ui[`annotation-${action}`], name: action });
  });
}

async function savePdf() {
  const pdf = state.document;
  if (!pdf || state.saving) return;
  commitAnnotations();
  const savedRevision = state.editRevision;
  state.saving = true;
  ui.reader.classList.add("saving");
  ui.reader.inert = true;
  ui["save-status"].textContent = "Хадгалж байна…";
  updateControls();
  try {
    // Preserve standard annotation metadata and portable visible appearances.
    const edits = [...(pdf.annotationStorage.serializable.map?.values() || [])];
    const original = pdf.annotationStorage.size ? await pdf.saveDocument() : await pdf.getData();
    const data = await addUnicodeNoteAppearances(original, edits);
    if (pdf !== state.document) return;
    const filename = `${state.filename.replace(/\.pdf$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "document"}-misheel.pdf`;
    const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    state.dirty = savedRevision !== state.editRevision;
    ui["save-status"].textContent = state.dirty ? "Хадгалаагүй өөрчлөлттэй" : "Тэмдэглэгээтэй PDF татлаа";
    message(`${filename} файлыг татлаа. Хадгалсан PDF-ээ Edge болон бусад PDF уншигчаар нээж болно.`, true);
  } catch (error) {
    state.dirty = true;
    ui["save-status"].textContent = "Хадгалж чадсангүй";
    if (globalThis.PDFLib?.EncryptedPDFError && error instanceof globalThis.PDFLib.EncryptedPDFError) {
      message("Нууц үгтэй PDF-д монгол, солонгос текст тэмдэглэгээ хадгалахын тулд нууц үггүй PDF хувилбарыг нээх шаардлагатай. Өөрчлөлт энд хэвээр байна.");
    } else {
      message("PDF тэмдэглэгээг хадгалахад алдаа гарлаа. Өөрчлөлт энд хэвээр байна. Дахин хадгалж үзээрэй.");
    }
  } finally {
    state.saving = false;
    ui.reader.classList.remove("saving");
    ui.reader.inert = false;
    updateControls();
  }
}
ui["save-pdf"].addEventListener("click", () => void savePdf());
ui["page-shell"].addEventListener("input", (event) => {
  if (event.target instanceof Element && event.target.closest(".annotationEditorLayer")) markDirty();
});
for (const type of ["keydown", "beforeinput", "paste", "cut", "drop"]) {
  window.addEventListener(type, (event) => {
    if (!state.saving) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
}
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

// Toggle while a text note has focus, without inserting a letter or losing it.
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.repeat || event.isComposing || ui["password-dialog"].open) return;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.getModifierState("AltGraph")) return;
  if (event.code !== "KeyT" && event.key.toLowerCase() !== "t") return;
  if (!state.document || !state.editor || state.saving || ui["tool-text"].disabled || ui["tool-read"].disabled) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  commitAnnotations();
  window.getSelection()?.removeAllRanges();
  setMode(state.mode === AnnotationEditorType.FREETEXT ? AnnotationEditorType.NONE : AnnotationEditorType.FREETEXT);
}, { capture: true });

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || ui["password-dialog"].open) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && state.document) {
    event.preventDefault(); void savePdf(); return;
  }
  const editable = event.composedPath().some((node) => node instanceof Element && node.matches("input, textarea, select, [contenteditable='true']"));
  const insideCard = event.composedPath().some((node) => node instanceof Element && node.hasAttribute("data-misheel-popup"));
  if (editable || insideCard) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); chooseFile(); return; }
  if (!state.document || state.mode !== AnnotationEditorType.NONE || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || window.getSelection()?.toString() || window.document.querySelector("[data-misheel-popup]")) return;
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
  resizeTimer = setTimeout(() => {
    if (state.document && state.fit && !state.saving) viewer.currentScaleValue = "page-width";
  }, 150);
}).observe(ui.reader);
window.addEventListener("beforeunload", (event) => {
  commitAnnotations();
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("pagehide", () => { state.loadRequest += 1; state.remoteController?.abort(); forgetDocument(); });
updateControls();
updateAnnotationControls();
const requestedFile = new URLSearchParams(window.location.search).get("file");
if (requestedFile) void openUrl(requestedFile);
