import { createDictionaryLookup, MAX_SELECTION_LENGTH } from "./dictionary.mjs";

const lookup = createDictionaryLookup(async (key) => {
  const response = await fetch(chrome.runtime.getURL(`data/shards/${key}.json`));
  if (!response.ok) throw new Error("Толийн өгөгдлийг ачаалж чадсангүй. Extension-оо дахин ачаална уу.");
  return response.json();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ enabled: true }).then((settings) => chrome.storage.local.set({ enabled: settings.enabled !== false }));
});

// Returning true keeps the message channel alive while the local shard is read.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "LOOKUP") {
    if (typeof message.text !== "string" || message.text.length > MAX_SELECTION_LENGTH) {
      sendResponse({ ok: false, error: "500 хүртэл тэмдэгттэй солонгос текст оруулна уу." });
      return false;
    }
    lookup(message.text).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error.message || "Толь хайхад алдаа гарлаа." })
    );
    return true;
  }
  if (message?.type === "GET_INFO") {
    fetch(chrome.runtime.getURL("data/index.json")).then((response) => {
      if (!response.ok) throw new Error("Толийн мэдээллийг ачаалж чадсангүй.");
      return response.json();
    }).then((info) => sendResponse({ ok: true, info }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});
