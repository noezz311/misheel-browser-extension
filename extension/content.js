(() => {
  "use strict";

  // Content scripts can be injected again while developing an unpacked extension.
  const instanceKey = "__misheelSelectionTranslator";
  if (globalThis[instanceKey]) return;
  globalThis[instanceKey] = true;

  const MAX_QUERY_LENGTH = 500;
  const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/;
  const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']";
  const nodeIds = new WeakMap();
  let nextNodeId = 1;
  let enabled = true;
  let popup = null;
  let requestVersion = 0;
  let selectionTimer = 0;
  let positionFrame = 0;
  let pointer = null;
  let dismissedSelectionKey = "";
  const dockTarget = location.protocol === "chrome-extension:" && location.pathname === "/pdf.html"
    ? document.getElementById("translation-panel") : null;

  const css = `
    :host { all: initial; position: fixed; z-index: 2147483647; display: block;
      width: 360px; max-width: calc(100vw - 24px); color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      font-size: 14px; line-height: 1.5; color: #17263b; text-align: left; }
    *, *::before, *::after { box-sizing: border-box; }
    .card { overflow: hidden; border: 1px solid #dce4ee; border-radius: 16px;
      background: #fff; box-shadow: 0 12px 40px #142d5133, 0 2px 8px #142d5114;
      display: flex; flex-direction: column; max-height: min(480px, calc(100vh - 24px)); }
    .header { display: flex; align-items: center; gap: 9px; padding: 13px 13px 10px 15px;
      border-bottom: 1px solid #edf1f6; flex: none; }
    .logo { display: grid; place-items: center; width: 29px; height: 29px; flex: none;
      border-radius: 9px; background: #e7f4f0; color: #18765e; font-size: 17px; font-weight: 750; }
    .brand { flex: 1; min-width: 0; }
    .label { margin: 0; color: #233751; font-size: 12px; font-weight: 650; line-height: 1.4; }
    .badge { display: block; color: #617286; font-size: 10px; margin-top: 2px; }
    .close { appearance: none; border: 0; border-radius: 8px; background: transparent;
      color: #60738a; font: inherit; font-size: 23px; line-height: 1; width: 28px;
      height: 28px; display: grid; place-items: center; cursor: pointer; flex: none; }
    .close:hover { color: #17263b; background: #f0f4f8; }
    .body { overflow: auto; overscroll-behavior: contain; padding: 14px 16px 16px;
      scrollbar-width: thin; scrollbar-color: #c4cedb transparent; min-height: 0; }
    .query { color: #233751; font-size: 17px; font-weight: 650; line-height: 1.5;
      margin: 0 0 12px; overflow-wrap: anywhere; white-space: pre-wrap;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .content { font-size: 14px; }
    .note { margin: 0 0 13px; color: #687a8e; font-size: 12px; line-height: 1.65; }
    .limit { color: #6b7e92; font-size: 11px; margin: 0 0 10px; }
    .entry + .entry { border-top: 1px solid #edf1f6; margin-top: 13px; padding-top: 13px; }
    .word { color: #156e58; font-size: 15px; font-weight: 700; margin: 0 0 4px;
      line-height: 1.5; overflow-wrap: anywhere; }
    .meaning { margin: 0; font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
    .pronunciation { margin: 2px 0 7px; color: #758499; font-size: 12px; overflow-wrap: anywhere; }
    .examples { margin: 9px 0 0; border-left: 2px solid #d9eae4; padding-left: 10px;
      color: #596d84; font-size: 12px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
    .example + .example { margin-top: 6px; }
    .status { display: flex; gap: 9px; align-items: center; color: #65788f;
      font-size: 13px; padding: 5px 0 2px; }
    .spinner { width: 15px; height: 15px; flex: none; border: 2px solid #e1ebe7;
      border-top-color: #218166; border-radius: 50%; animation: spin .8s linear infinite; }
    .empty { margin: 0 0 8px; color: #405871; font-size: 14px; line-height: 1.6; }
    .retry { appearance: none; border: 1px solid #cbded7; background: #edf7f3; color: #18664f;
      padding: 7px 12px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px;
      font-weight: 600; margin-top: 3px; }
    .retry:hover { background: #e0f0e9; }
    .footer { display: flex; align-items: center; justify-content: space-between; gap: 9px;
      border-top: 1px solid #edf1f6; background: #fafcfd; padding: 10px 15px; flex: none; }
    .online { color: #34688e; text-decoration: none; font-size: 11px; line-height: 1.4;
      display: inline-flex; align-items: center; gap: 4px; }
    .online:hover { text-decoration: underline; }
    .hint { font-size: 10px; color: #91a0b2; white-space: nowrap; }
    button:focus-visible, a:focus-visible { outline: 2px solid #188266; outline-offset: 3px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
    @media (prefers-color-scheme: dark) {
      :host { color-scheme: dark; color: #e1e8f2; }
      .card { background: #182334; border-color: #344256; box-shadow: 0 12px 40px #0007; }
      .header, .entry + .entry, .footer { border-color: #2c3a4e; }
      .logo { background: #203e38; color: #86d6b7; }
      .label, .query { color: #e2eaf5; }
      .badge, .note, .limit, .status { color: #a0b0c5; }
      .word { color: #88d7b9; }
      .pronunciation, .examples { color: #a7b7cb; }
      .examples { border-color: #36594b; }
      .empty { color: #c6d4e5; }
      .footer { background: #152030; }
      .close { color: #aab8cb; }
      .close:hover { background: #2a394d; color: #fff; }
      .online { color: #9ac8eb; }
      .retry { background: #254238; border-color: #3a6554; color: #b3e5cc; }
      .retry:hover { background: #2f5043; }
      .spinner { border-color: #304b42; border-top-color: #87d7b8; }
    }
  `;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function isInsidePopup(node) {
    return Boolean(node && popup && (node === popup.host || node.getRootNode?.() === popup.shadow));
  }

  function ownEvent(event) {
    return Boolean(popup && event.composedPath().includes(popup.host));
  }

  function isEditable(node) {
    const target = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(target && (target.isContentEditable || target.closest?.(EDITABLE)));
  }

  function nodeId(node) {
    if (!node) return 0;
    if (!nodeIds.has(node)) nodeIds.set(node, nextNodeId++);
    return nodeIds.get(node);
  }

  function selectionKey(selection, text) {
    return `${nodeId(selection.anchorNode)}:${selection.anchorOffset}:${nodeId(selection.focusNode)}:${selection.focusOffset}:${text.length}:${text.slice(0, MAX_QUERY_LENGTH)}`;
  }

  function readSelection() {
    if (document.documentElement.dataset.misheelAnnotating === "true") return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    if (isInsidePopup(selection.anchorNode) || isInsidePopup(selection.focusNode)) return null;
    if (isEditable(selection.anchorNode) || isEditable(selection.focusNode) || isEditable(document.activeElement)) return null;
    const text = selection.toString().trim();
    if (!text || !HANGUL.test(text)) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return {
      text: text.slice(0, MAX_QUERY_LENGTH),
      tooLong: text.length > MAX_QUERY_LENGTH,
      key: selectionKey(selection, text),
      range,
    };
  }

  function dismiss(rememberSelection = true) {
    clearTimeout(selectionTimer);
    if (!popup) return;
    if (rememberSelection) dismissedSelectionKey = popup.selection.key;
    popup.host.remove();
    dockTarget?.classList.remove("has-result");
    popup = null;
    requestVersion++;
  }

  function queuePosition() {
    if (!popup || positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      positionPopup();
    });
  }

  function positionPopup() {
    if (!popup) return;
    const { host, selection } = popup;
    if (dockTarget) {
      host.style.visibility = "visible";
      return;
    }
    if (!selection.range.commonAncestorContainer.isConnected) {
      dismiss();
      return;
    }
    const anchor = selection.range.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 12;
    const gap = 9;
    if (anchor.bottom < 0 || anchor.top > viewportHeight || anchor.right < 0 || anchor.left > viewportWidth) {
      host.style.visibility = "hidden";
      return;
    }
    const box = host.getBoundingClientRect();
    const left = Math.max(margin, Math.min(anchor.left, viewportWidth - box.width - margin));
    let top = anchor.bottom + gap;
    if (top + box.height > viewportHeight - margin && anchor.top - gap - box.height >= margin) {
      top = anchor.top - gap - box.height;
    }
    top = Math.max(margin, Math.min(top, viewportHeight - box.height - margin));
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
    host.style.visibility = "visible";
  }

  function show(selection) {
    dismiss(false);
    dismissedSelectionKey = "";
    const host = document.createElement("div");
    host.setAttribute("data-misheel-popup", "");
    host.style.setProperty("position", dockTarget ? "relative" : "fixed", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("visibility", "hidden", "important");
    const shadow = host.attachShadow({ mode: "open" });
    const style = element("style");
    style.textContent = css + (dockTarget ? `
      :host { position: relative; width: 100%; max-width: none; height: 100%; }
      .card { height: 100%; max-height: none; border: 0; border-radius: 0; box-shadow: none; }
      .body { flex: 1; }
    ` : "");
    const card = element("section", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Мишээл · Солонгос → Монгол");
    const header = element("div", "header");
    const logo = element("span", "logo", "М");
    logo.setAttribute("aria-hidden", "true");
    const brand = element("div", "brand");
    brand.append(element("p", "label", "Мишээл · Солонгос → Монгол"), element("span", "badge", "Офлайн толь бичиг"));
    const close = element("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Хаах");
    close.title = "Хаах (Esc)";
    close.addEventListener("click", () => dismiss());
    header.append(logo, brand, close);
    const body = element("div", "body");
    body.append(element("p", "query", selection.text));
    const content = element("div", "content");
    content.setAttribute("aria-live", "polite");
    content.setAttribute("aria-atomic", "true");
    body.append(content);
    const footer = element("div", "footer");
    if (!selection.tooLong) {
      const online = element("a", "online", "Google Translate-аар нээх ↗");
      const translateUrl = new URL("https://translate.google.com/");
      translateUrl.search = new URLSearchParams({ sl: "ko", tl: "mn", text: selection.text, op: "translate" }).toString();
      online.href = translateUrl.href;
      online.target = "_blank";
      online.rel = "noopener noreferrer";
      online.title = "Сонгосон текстийг Google Translate-д илгээж орчуулна";
      footer.append(online);
    } else {
      footer.append(element("span", "hint", "500 тэмдэгтийн хязгаар"));
    }
    footer.append(element("span", "hint", "Esc · Хаах"));
    card.append(header, body, footer);
    shadow.append(style, card);
    popup = { host, shadow, content, selection };
    (dockTarget || document.documentElement).append(host);
    dockTarget?.classList.add("has-result");
    // Remove the initial important visibility declaration before positioning.
    host.style.removeProperty("visibility");
    positionPopup();
    lookup();
  }

  function plainText(value) {
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join("\n");
    return "";
  }

  function exampleText(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return plainText(value);
    const source = plainText(value.ko || value.korean || value.source || value.sentence || value.example || value.text);
    const translation = plainText(value.mn || value.mongolian || value.translation || value.meaning);
    return [source, translation].filter(Boolean).join("\n");
  }

  function renderResult(result) {
    if (!popup) return;
    const content = popup.content;
    content.replaceChildren();
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    if (result?.mode === "words" && entries.length) {
      content.append(element("p", "note", "Бүтэн хэллэг тольд олдсонгүй. Сонгосон хэсгээс таарсан үгсийг харуулав. Энэ толь бүтэн өгүүлбэрийг автоматаар орчуулахгүй."));
    }
    if (!entries.length) {
      content.append(
        element("p", "empty", "Офлайн тольд энэ үг, хэллэг олдсонгүй."),
        element("p", "note", "Энэ нь үгийн толь тул бүтэн өгүүлбэрийг автоматаар орчуулахгүй. Google Translate-аар өгүүлбэрээ орчуулж болно."),
      );
    } else {
      for (const entry of entries.slice(0, 40)) {
        const block = element("div", "entry");
        const word = plainText(entry?.word);
        if (word) block.append(element("p", "word", word));
        const pronunciation = plainText(entry?.pronunciation);
        if (pronunciation) block.append(element("p", "pronunciation", `Дуудлага: ${pronunciation}`));
        block.append(element("p", "meaning", plainText(entry?.meaning) || "Монгол товч утга байхгүй."));
        const examples = Array.isArray(entry?.examples) ? entry.examples : entry?.examples ? [entry.examples] : [];
        const exampleStrings = examples.map(exampleText).filter(Boolean);
        if (exampleStrings.length) {
          const group = element("div", "examples");
          for (const text of exampleStrings.slice(0, 5)) group.append(element("div", "example", text));
          block.append(group);
        }
        content.append(block);
      }
      if (result?.truncated || entries.length > 40) {
        content.append(element("p", "note", "Олдсон үгсийн эхний хэсгийг харуулав. Богино хэсэг сонговол илүү нарийн хайна."));
      }
    }
    queuePosition();
  }

  function renderError() {
    if (!popup) return;
    popup.content.replaceChildren(
      element("p", "empty", "Толь бичгийг ачаалж чадсангүй."),
      element("p", "note", "Дахин хайж үзнэ үү. Алдаа үргэлжилбэл өргөтгөлийг дахин ачаалаад хуудсаа шинэчилнэ үү."),
    );
    const retry = element("button", "retry", "Дахин хайх");
    retry.type = "button";
    retry.addEventListener("click", lookup);
    popup.content.append(retry);
    queuePosition();
  }

  function lookup() {
    if (!popup || !enabled) return;
    if (popup.selection.tooLong) {
      popup.content.replaceChildren(
        element("p", "empty", "Сонгосон текст хэт урт байна."),
        element("p", "note", "500 хүртэл тэмдэгттэй үг, хэллэг сонгоно уу."),
      );
      queuePosition();
      return;
    }
    const version = ++requestVersion;
    const content = popup.content;
    const loading = element("div", "status");
    loading.setAttribute("role", "status");
    const spinner = element("span", "spinner");
    spinner.setAttribute("aria-hidden", "true");
    loading.append(spinner, element("span", "", "Толь бичгээс хайж байна…"));
    content.replaceChildren(loading);
    queuePosition();
    try {
      chrome.runtime.sendMessage({ type: "LOOKUP", text: popup.selection.text }, response => {
        const error = chrome.runtime.lastError;
        if (!popup || version !== requestVersion || !enabled) return;
        if (error || !response?.ok || !response.result) renderError();
        else renderResult(response.result);
      });
    } catch {
      if (popup && version === requestVersion) renderError();
    }
  }

  function inspectSelection(force = false) {
    if (!enabled || pointer) return;
    const selection = readSelection();
    if (!selection) {
      // Selecting a definition inside our shadow root should keep the card open.
      const nativeSelection = window.getSelection();
      if (!isInsidePopup(nativeSelection?.anchorNode) && !isInsidePopup(nativeSelection?.focusNode)) dismiss(false);
      dismissedSelectionKey = "";
      return;
    }
    if (!force && selection.key === dismissedSelectionKey) return;
    if (popup && popup.selection.key === selection.key) {
      popup.selection.range = selection.range;
      queuePosition();
      return;
    }
    show(selection);
  }

  function scheduleSelection(delay = 100, force = false) {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => inspectSelection(force), delay);
  }

  document.addEventListener("pointerdown", event => {
    if (ownEvent(event)) return;
    const current = readSelection();
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, key: current?.key || "", moved: false };
    dismiss();
  }, true);

  document.addEventListener("pointermove", event => {
    if (pointer && pointer.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 3) pointer.moved = true;
  }, { capture: true, passive: true });

  document.addEventListener("pointerup", event => {
    if (ownEvent(event)) return;
    const previous = pointer;
    pointer = null;
    if (isEditable(event.target)) return;
    const current = readSelection();
    const deliberateSelection = previous?.moved || (current && current.key !== previous?.key);
    scheduleSelection(0, Boolean(deliberateSelection));
  }, true);

  document.addEventListener("pointercancel", () => { pointer = null; }, true);

  document.addEventListener("selectionchange", () => {
    if (!pointer) scheduleSelection();
  });

  document.addEventListener("keyup", event => {
    if (ownEvent(event) || isEditable(event.target)) return;
    if (event.shiftKey || ["Shift", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")) {
      scheduleSelection(0);
    }
  }, true);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && popup) dismiss();
  }, true);

  window.addEventListener("scroll", queuePosition, { capture: true, passive: true });
  window.addEventListener("resize", queuePosition, { passive: true });
  window.visualViewport?.addEventListener("resize", queuePosition, { passive: true });
  window.visualViewport?.addEventListener("scroll", queuePosition, { passive: true });

  try {
    chrome.storage.local.get({ enabled: true }, settings => {
      if (chrome.runtime.lastError) return;
      enabled = settings.enabled !== false;
      if (!enabled) dismiss();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.enabled) return;
      enabled = changes.enabled.newValue !== false;
      if (!enabled) dismiss();
    });
  } catch {
    // A disconnected extension context simply cannot perform another lookup.
  }
})();
