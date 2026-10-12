// PDF.js writes Unicode FreeText Contents but cannot make a Helvetica
// appearance for that text. Some PDF readers, including Edge, require /AP.
// Supply a portable appearance without flattening the editable annotation.
let libraryPromise, fontPromise;

async function getLibrary() {
  libraryPromise ||= import("./vendor/pdf-lib/pdf-lib.min.js").then(() => globalThis.PDFLib);
  try { return await libraryPromise; } catch (error) { libraryPromise = null; throw error; }
}

async function getFonts() {
  fontPromise ||= (async () => {
    await import("./vendor/fontkit/fontkit.umd.min.js");
    const responses = await Promise.all(["NotoSans-Regular.ttf", "NotoSansKR-Regular.otf"]
      .map(filename => fetch(new URL(`./vendor/fonts/${filename}`, import.meta.url))));
    if (responses.some(response => !response.ok)) throw new Error("NoteFontUnavailable");
    const bytes = await Promise.all(responses.map(async response => new Uint8Array(await response.arrayBuffer())));
    return { fontkit: globalThis.fontkit, bytes, glyphFonts: bytes.map(font => globalThis.fontkit.create(font)) };
  })();
  try { return await fontPromise; } catch (error) { fontPromise = null; throw error; }
}

const number = value => Number(value.toFixed(6)).toString();
const clamp = value => Math.max(0, Math.min(1, value));

function defaultAppearance(da, edit) {
  let fontSize = edit.fontSize || 16;
  let color = (edit.color || [0, 0, 0]).map(value => clamp(value / 255));
  // PDF.js emits Tf and g/rg. Also accept a native note's CMYK default color.
  // Use the last setting of each kind, as the PDF graphics state does.
  const numeric = "[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][-+]?\\d+)?";
  const settings = new RegExp(`(${numeric})\\s+Tf\\b|(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+k\\b|(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+rg\\b|(${numeric})\\s+g\\b`, "g");
  for (const match of da.matchAll(settings)) {
    if (match[1] !== undefined) { const value = Number(match[1]); if (value > 0) fontSize = value; }
    else if (match[2] !== undefined) {
      const [c, m, y, k] = match.slice(2, 6).map(value => clamp(Number(value)));
      color = [1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)];
    } else if (match[6] !== undefined) color = match.slice(6, 9).map(value => clamp(Number(value)));
    else color = Array(3).fill(clamp(Number(match[9])));
  }
  return { fontSize, color };
}

function geometry(rect, rotation) {
  const rectWidth = rect[2] - rect[0], rectHeight = rect[3] - rect[1];
  const angle = ((rotation % 360) + 360) % 360;
  const rotated = angle === 90 || angle === 270;
  return {
    width: rotated ? rectHeight : rectWidth, height: rotated ? rectWidth : rectHeight,
    matrix: angle === 90 ? [0, 1, -1, 0, rectWidth, 0]
      : angle === 180 ? [-1, 0, 0, -1, rectWidth, rectHeight]
      : angle === 270 ? [0, -1, 1, 0, 0, rectHeight] : [1, 0, 0, 1, 0, 0],
  };
}

async function makeAppearance(pdf, note, resources, embeddedFonts) {
  const { bytes, glyphFonts } = resources;
  const { contents, width, height, matrix, fontSize, color } = note;
  const lines = contents.split(/\r\n?|\n/u).map(line => line.replace(/\t/gu, "    "));
  const pickFont = char => glyphFonts.findIndex(font => font.hasGlyphForCodePoint(char.codePointAt(0)));
  let stream;
  if (lines.every(line => [...line].every(char => pickFont(char) >= 0))) {
    // Noto Sans covers extended Mongolian Cyrillic (Ө/Ү); the Korean font
    // supplies Hangul. Runs retain both fonts within the same line.
    const runs = lines.map(line => {
      const grouped = [];
      for (const char of line) {
        const index = pickFont(char);
        if (grouped.at(-1)?.index === index) grouped.at(-1).text += char;
        else grouped.push({ index, text: char });
      }
      return grouped;
    });
    for (const run of runs.flat()) embeddedFonts[run.index] ||= await pdf.embedFont(bytes[run.index], { subset: true });
    const maxWidth = Math.max(1, ...runs.map(line => line.reduce((sum, run) => sum + embeddedFonts[run.index].widthOfTextAtSize(run.text, fontSize), 0)));
    const size = fontSize * Math.min(1, width / maxWidth, height / (lines.length * fontSize * 1.35));
    const commands = ["q", `0 0 ${number(width)} ${number(height)} re W n`, "BT", `${color.map(number).join(" ")} rg`];
    runs.forEach((line, i) => {
      commands.push(`1 0 0 1 0 ${number(height - size - i * size * 1.35)} Tm`);
      for (const run of line) commands.push(`/MisheelNote${run.index} ${number(size)} Tf`, `${embeddedFonts[run.index].encodeText(run.text).toString()} Tj`);
    });
    commands.push("ET", "Q");
    const fonts = Object.fromEntries(embeddedFonts.flatMap((font, i) => font ? [[`MisheelNote${i}`, font.ref]] : []));
    stream = pdf.context.flateStream(commands.join("\n"), {
      Type: "XObject", Subtype: "Form", FormType: 1, BBox: [0, 0, width, height], Matrix: matrix,
      Resources: { Font: fonts },
    });
  } else {
    // Use the browser's font fallback for unsupported glyphs such as emoji.
    // Rasterize only that note; its original Contents remain editable.
    const scale = Math.min(4, 4096 / width, 4096 / height, Math.sqrt(16_000_000 / (width * height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width * scale)); canvas.height = Math.max(1, Math.ceil(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("NoteAppearanceUnavailable");
    ctx.scale(canvas.width / width, canvas.height / height);
    ctx.font = `${fontSize}px Arial, sans-serif`;
    const maxWidth = Math.max(1, ...lines.map(line => ctx.measureText(line).width));
    const size = fontSize * Math.min(1, width / maxWidth, height / (lines.length * fontSize * 1.35));
    ctx.font = `${size}px Arial, sans-serif`;
    ctx.fillStyle = `rgb(${color.map(value => Math.round(value * 255)).join(",")})`;
    lines.forEach((line, i) => ctx.fillText(line, 0, size + i * size * 1.35));
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("NoteAppearanceUnavailable");
    const image = await pdf.embedPng(await png.arrayBuffer());
    stream = pdf.context.flateStream(`q ${number(width)} 0 0 ${number(height)} 0 0 cm /MisheelNoteImage Do Q`, {
      Type: "XObject", Subtype: "Form", FormType: 1, BBox: [0, 0, width, height], Matrix: matrix,
      Resources: { XObject: { MisheelNoteImage: image.ref } },
    });
  }
  return pdf.context.register(stream);
}

export async function addUnicodeNoteAppearances(data, edits) {
  const notes = edits.filter(edit => edit.annotationType === 3 && !edit.deleted && /[^\u0000-\u007f]/u.test(edit.value || ""));
  if (!notes.length) return data;
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber } = await getLibrary();
  // Keep PDF-lib's encryption guard. Rewriting encrypted source streams after
  // ignoring encryption could produce an unreadable document.
  const pdf = await PDFDocument.load(data, { updateMetadata: false });
  const name = PDFName.of;
  const pending = [];
  for (const [pageIndex, page] of pdf.getPages().entries()) {
    const annotations = page.node.lookupMaybe(name("Annots"), PDFArray);
    if (!annotations) continue;
    for (const ref of annotations.asArray()) {
      const annotation = pdf.context.lookup(ref);
      if (!(annotation instanceof PDFDict) || annotation.get(name("Subtype"))?.toString() !== "/FreeText") continue;
      const contents = annotation.lookup(name("Contents"))?.decodeText?.() || "";
      const rectArray = annotation.lookupMaybe(name("Rect"), PDFArray);
      if (!rectArray || rectArray.size() !== 4) continue;
      const rect = rectArray.asArray().map(value => pdf.context.lookup(value, PDFNumber).asNumber());
      const edit = notes.find(note => note.pageIndex === pageIndex && note.value === contents && note.rect?.every((value, i) => Math.abs(value - rect[i]) < 0.1));
      if (!edit) continue;
      // Only touch matching edited notes. PDF.js may leave their old /AP in
      // place when a later Unicode edit cannot get a Helvetica appearance.
      const rotation = annotation.lookupMaybe(name("Rotate"), PDFNumber)?.asNumber() ?? edit.rotation ?? 0;
      const layout = geometry(rect, rotation);
      if (!(layout.width > 0 && layout.height > 0)) continue;
      const da = annotation.lookup(name("DA"))?.decodeText?.() || "";
      pending.push({ annotation, contents, ...layout, ...defaultAppearance(da, edit) });
    }
  }
  if (!pending.length) return data;
  const resources = await getFonts();
  pdf.registerFontkit(resources.fontkit);
  const embeddedFonts = [];
  for (const note of pending) {
    const appearance = note.annotation.lookupMaybe(name("AP"), PDFDict) || pdf.context.obj({});
    appearance.set(name("N"), await makeAppearance(pdf, note, resources, embeddedFonts));
    note.annotation.set(name("AP"), appearance);
  }
  return pdf.save({ addDefaultPage: false });
}
