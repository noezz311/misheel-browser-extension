"use strict";
const toggle = document.getElementById("enabled");
const results = document.getElementById("results");
const queryInput = document.getElementById("query");
const online = document.getElementById("online");
const autoPdfToggle = document.getElementById("auto-pdf");
let sequence = 0;
let currentPdfUrl = null;

function openPdfReader(fileUrl = null) {
  const url = new URL(chrome.runtime.getURL("pdf.html"));
  if (fileUrl) url.searchParams.set("file", fileUrl);
  return chrome.tabs.create({ url: url.href });
}

document.getElementById("open-pdf").addEventListener("click", () => {
  openPdfReader().catch(() => results.replaceChildren(paragraph("PDF уншигчийг нээж чадсангүй.", "hint error")));
});
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab?.url) return;
  const url = new URL(tab.url);
  if (["file:", "https:", "http:"].includes(url.protocol) && (/\.pdf$/i.test(url.pathname) || /\.pdf(?:\s|$)/i.test(tab.title || ""))) {
    currentPdfUrl = url.href;
    document.getElementById("open-current-pdf").hidden = false;
  }
}).catch(() => {});
document.getElementById("open-current-pdf").addEventListener("click", () => {
  if (currentPdfUrl) openPdfReader(currentPdfUrl).catch(() => results.replaceChildren(paragraph("PDF уншигчийг нээж чадсангүй.", "hint error")));
});

function paragraph(text, className) {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

chrome.storage.local.get({ enabled: true }).then((settings) => { toggle.checked = settings.enabled !== false; });
chrome.storage.local.get({ autoPdf: true }).then((settings) => { autoPdfToggle.checked = settings.autoPdf !== false; });
autoPdfToggle.addEventListener("change", async () => {
  try { await chrome.storage.local.set({ autoPdf: autoPdfToggle.checked }); }
  catch { autoPdfToggle.checked = !autoPdfToggle.checked; results.replaceChildren(paragraph("PDF тохиргоог хадгалж чадсангүй.", "hint error")); }
});
toggle.addEventListener("change", async () => {
  try { await chrome.storage.local.set({ enabled: toggle.checked }); }
  catch { toggle.checked = !toggle.checked; results.replaceChildren(paragraph("Тохиргоог хадгалж чадсангүй.", "hint error")); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) toggle.checked = changes.enabled.newValue !== false;
  if (area === "local" && changes.autoPdf) autoPdfToggle.checked = changes.autoPdf.newValue !== false;
});
chrome.runtime.sendMessage({ type: "GET_INFO" }).then((response) => {
  if (response?.ok && response.info.wordCount) {
    document.getElementById("dictionary-info").textContent = `${response.info.wordCount.toLocaleString("en-US")} үг · Офлайн толь`;
  }
}).catch(() => {});

document.getElementById("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = queryInput.value.trim();
  const id = ++sequence;
  online.hidden = true;
  if (!text) { results.replaceChildren(paragraph("Хайх солонгос үгээ оруулна уу.", "hint")); return; }
  results.replaceChildren(paragraph("Толиос хайж байна…", "hint"));
  try {
    const response = await chrome.runtime.sendMessage({ type: "LOOKUP", text });
    if (id !== sequence) return;
    if (!response?.ok) throw new Error(response?.error || "Extension-оо дахин ачаална уу.");
    const { entries, mode, truncated } = response.result;
    results.replaceChildren();
    if (mode === "words") results.append(paragraph("Сонгосон текстийн үгсийг толиос хайлаа. Бүтэн өгүүлбэрийн орчуулга биш.", "note"));
    if (!entries.length) results.append(paragraph("Энэ үг эсвэл хэллэг толиос олдсонгүй. Үндсэн хэлбэрээр нь хайж үзээрэй.", "hint"));
    for (const entry of entries) {
      const article = document.createElement("article");
      article.className = "entry";
      const word = paragraph(entry.word, "word");
      word.lang = "ko";
      if (entry.pronunciation) {
        const pronunciation = document.createElement("span");
        pronunciation.className = "pronunciation";
        pronunciation.textContent = entry.pronunciation;
        word.append(pronunciation);
      }
      article.append(word, paragraph(entry.meaning || "Монгол товч утга байхгүй.", "meaning"));
      if (entry.examples?.length) {
        const examples = document.createElement("div");
        examples.className = "examples";
        for (const example of entry.examples.slice(0, 3)) {
          examples.append(paragraph(example.ko || "", "example-ko"), paragraph(example.mn || "", "example-mn"));
        }
        article.append(examples);
      }
      results.append(article);
    }
    if (truncated) results.append(paragraph("Эхний 16 үр дүнг харууллаа. Цөөн үг сонгоод дахин хайгаарай.", "note"));
    if (/[\uac00-\ud7a3]/u.test(text)) {
      online.href = `https://translate.google.com/?sl=ko&tl=mn&text=${encodeURIComponent(text)}&op=translate`;
      online.hidden = false;
    }
  } catch (error) {
    if (id === sequence) results.replaceChildren(paragraph(error.message || "Толь хайхад алдаа гарлаа.", "hint error"));
  }
});
