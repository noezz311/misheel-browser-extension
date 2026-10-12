import test from "node:test";
import assert from "node:assert/strict";
import { createDictionaryLookup, normalizeQuery, shardName } from "../extension/dictionary.mjs";

const entries = {
  학교: [{ word: "학교", meaning: "сургууль", examples: [{ ko: "학교에 가다", mn: "сургуульд явах" }] }],
  공부하다: [{ word: "공부하다", meaning: "хичээл хийх" }],
  하다: [{ word: "하다", meaning: "хийх" }],
  먹다: [{ word: "먹다", meaning: "идэх" }],
  먹: [{ word: "먹", meaning: "бэх" }],
  한국어: [{ word: "한국어", meaning: "солонгос хэл" }],
  "한국어 학교": [{ word: "한국어 학교", meaning: "солонгос хэлний сургууль" }],
  사과: [{ word: "사과", meaning: "алим" }, { word: "사과", meaning: "уучлал" }]
};
function setup(options) {
  const calls = [];
  const lookup = createDictionaryLookup(async key => {
    calls.push(key);
    return Object.fromEntries(Object.entries(entries).filter(([word]) => shardName(word) === key));
  }, options);
  return { lookup, calls };
}

test("normalizes copied punctuation, invisible characters and decomposed Hangul", () => {
  assert.equal(normalizeQuery("  ‘학교’\u200b  "), "학교");
  assert.equal(normalizeQuery("한국어\n\t학교"), "한국어 학교");
});

test("exact lookup preserves homonyms and examples", async () => {
  const { lookup } = setup();
  assert.deepEqual((await lookup("학교")).entries, entries.학교);
  assert.equal((await lookup("사과")).entries.length, 2);
  assert.equal((await lookup("한국어 학교")).mode, "exact");
});

test("looks up particles and regular forms only when their dictionary entry exists", async () => {
  const { lookup } = setup();
  const result = await lookup("학교에서 한국어를 공부합니다.");
  assert.equal(result.mode, "words");
  assert.deepEqual(result.entries.map(entry => entry.word), ["학교", "한국어", "공부하다"]);
  assert.equal((await lookup("없는단어입니다")).mode, "none");
});

test("deduplicates word matches and keeps exact entries ahead of suffix guesses", async () => {
  const { lookup } = setup();
  assert.equal((await lookup("학교 학교에서 학교")).entries.length, 1);
  assert.equal((await lookup("사과")).mode, "exact");
});

test("standalone 하다 forms resolve and verb stems precede unrelated short nouns", async () => {
  const { lookup } = setup();
  for (const form of ["해요", "합니다", "하세요", "했어요"]) {
    assert.equal((await lookup(form)).entries[0]?.word, "하다");
  }
  assert.equal((await lookup("먹는")).entries[0]?.word, "먹다");
  assert.equal((await lookup("먹")).entries[0]?.word, "먹");
});

test("bounded shard cache coalesces concurrent reads and retries failed loads", async () => {
  let attempts = 0;
  const lookup = createDictionaryLookup(async () => {
    attempts++;
    if (attempts === 1) throw new Error("read failure");
    return { 학교: entries.학교 };
  });
  await assert.rejects(lookup("학교"), /read failure/);
  await Promise.all([lookup("학교"), lookup("학교")]);
  assert.equal(attempts, 2);
  const { lookup: cached, calls } = setup({ maxCachedShards: 1 });
  await cached("학교"); await cached("사과"); await cached("학교");
  assert.equal(calls.length, 3);
});

test("rejects oversized Korean selections and avoids loading non-Korean text", async () => {
  const { lookup, calls } = setup();
  await assert.rejects(lookup("가".repeat(501)), /500/);
  assert.equal((await lookup("Hello world")).mode, "none");
  assert.equal(calls.length, 0);
});
