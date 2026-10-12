/** Offline dictionary lookup. Data files are loaded only when their shard is needed. */
export const MAX_SELECTION_LENGTH = 500;
const HANGUL = /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/u;
const PARTICLES = ["으로부터", "에서부터", "에게서", "한테서", "으로는", "에서는", "에게는", "까지는", "부터는", "이라도", "이라고", "이라는", "이라면", "이랑", "처럼", "보다", "까지", "부터", "에게", "한테", "께서", "에서", "으로", "하고", "이며", "이나", "라도", "라고", "이야", "에는", "에도", "와는", "과는", "은", "는", "이", "가", "을", "를", "의", "에", "도", "만", "와", "과", "로", "랑"];
const ENDINGS = [
  ["하였습니다", "하다"], ["했습니다", "하다"], ["합니다", "하다"], ["하세요", "하다"],
  ["하셨어요", "하다"], ["했어요", "하다"], ["해요", "하다"], ["하는", "하다"],
  ["하여", "하다"], ["하면", "하다"], ["하고", "하다"], ["해서", "하다"],
  ["었습니다", "다"], ["았습니다", "다"], ["습니다", "다"],
  ["었어요", "다"], ["았어요", "다"], ["어요", "다"],
  ["아요", "다"], ["는다", "다"], ["는", "다"], ["고", "다"]
];
const COPULAS = ["이었습니다", "였습니다", "이었어요", "였어요", "입니다", "이에요", "예요"];

// Hangul syllables encode their vowel and final consonant in fixed positions.
function changeFinal(stem, expected, replacement) {
  const code = stem.charCodeAt(stem.length - 1) - 0xac00;
  if (code < 0 || code >= 11172 || code % 28 !== expected) return "";
  return stem.slice(0, -1) + String.fromCharCode(0xac00 + code - expected + replacement);
}

function contractedStem(stem) {
  const code = stem.charCodeAt(stem.length - 1) - 0xac00;
  if (code < 0 || code >= 11172 || code % 28 !== 0) return "";
  const vowel = Math.floor(code / 28) % 21;
  // 봐/와 → 보/오, 줘 → 주, 돼 → 되. Other irregular forms need a
  // morphology dictionary; avoid arbitrary prefix or syllable matches.
  const original = { 9: 8, 14: 13, 10: 11 }[vowel];
  if (original === undefined) return "";
  return stem.slice(0, -1) + String.fromCharCode(0xac00 + code + (original - vowel) * 28);
}

export function normalizeQuery(value) {
  // Websites may put soft hyphens, bidi marks or word joiners inside a word.
  // Remove formatting before NFC so a mark between Hangul jamo cannot block composition.
  return String(value ?? "").replace(/\p{Cf}/gu, "").normalize("NFC")
    .replace(/\s+/gu, " ").trim().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "").trim();
}

export function shardName(word) {
  const code = word.codePointAt(0);
  return code >= 0xac00 && code <= 0xd7a3 ? String(Math.floor((code - 0xac00) / 588)) : "other";
}

export function wordCandidates(word) {
  const candidates = [word];
  // Prefer a dictionary verb lemma to a shorter noun (먹는 → 먹다 before 먹).
  for (const [suffix, replacement] of ENDINGS) {
    if (word.endsWith(suffix) && (word.length > suffix.length || replacement === "하다")) {
      candidates.push(word.slice(0, -suffix.length) + replacement);
    }
  }
  for (const suffix of ["니다", "니까"]) {
    if (!word.endsWith(suffix)) continue;
    const stem = changeFinal(word.slice(0, -suffix.length), 17, 0); // ㅂ: 갑니다 → 가다
    if (stem) candidates.push(stem + "다");
  }
  for (const suffix of ["어요", "습니다", "다"]) {
    if (!word.endsWith(suffix)) continue;
    const stem = changeFinal(word.slice(0, -suffix.length), 20, 0); // ㅆ: 갔어요 → 가다
    if (!stem) continue;
    candidates.push(stem + "다");
    const original = contractedStem(stem);
    if (original) candidates.push(original + "다");
  }
  for (const suffix of COPULAS) {
    if (word.endsWith(suffix) && word.length > suffix.length) candidates.push(word.slice(0, -suffix.length));
  }
  for (const suffix of PARTICLES) {
    if (word.endsWith(suffix) && word.length > suffix.length) candidates.push(word.slice(0, -suffix.length));
  }
  return [...new Set(candidates)];
}

export function createDictionaryLookup(loadShard, { maxCachedShards = 5 } = {}) {
  const cache = new Map();
  async function find(word) {
    const key = shardName(word);
    if (!cache.has(key)) {
      const pending = Promise.resolve().then(() => loadShard(key));
      cache.set(key, pending);
      pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    }
    const pending = cache.get(key);
    cache.delete(key);
    cache.set(key, pending);
    while (cache.size > maxCachedShards) cache.delete(cache.keys().next().value);
    const shard = await pending;
    return Object.prototype.hasOwnProperty.call(shard, word) && Array.isArray(shard[word]) ? shard[word] : [];
  }

  return async function lookup(value) {
    const query = normalizeQuery(value);
    if (!query || !HANGUL.test(query)) return { query, mode: "none", entries: [] };
    if (query.length > MAX_SELECTION_LENGTH) throw new Error("500 хүртэл тэмдэгт сонгоно уу.");
    const exact = await find(query);
    if (exact.length) return { query, mode: "exact", entries: exact.slice(0, 16), truncated: exact.length > 16 };
    const tokens = [...new Set(query.match(/[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]+/gu) || [])];
    const entries = [];
    const matched = new Set();
    let truncated = tokens.length > 20;
    for (const token of tokens.slice(0, 20)) {
      for (const candidate of wordCandidates(token)) {
        if (matched.has(candidate)) break;
        const found = await find(candidate);
        if (found.length) {
          matched.add(candidate);
          const available = 16 - entries.length;
          entries.push(...found.slice(0, available));
          truncated ||= found.length > available;
          break;
        }
      }
      if (entries.length >= 16) { truncated ||= tokens.indexOf(token) < tokens.length - 1; break; }
    }
    return { query, mode: entries.length ? "words" : "none", entries, truncated };
  };
}
