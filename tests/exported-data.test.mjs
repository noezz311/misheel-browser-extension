import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeQuery, shardName, createDictionaryLookup } from "../extension/dictionary.mjs";

const dataRoot = new URL("../extension/data/", import.meta.url);
const info = JSON.parse(await readFile(new URL("index.json", dataRoot), "utf8"));
const shards = new Map(await Promise.all(info.shards.map(async key => [
  key, JSON.parse(await readFile(new URL(`shards/${key}.json`, dataRoot), "utf8"))
])));

test("bundled data counts, shard locations and message schema remain complete", () => {
  let headwords = 0, entries = 0, blankGlosses = 0;
  assert.equal(info.shards.length, 20);
  assert.match(info.sourceAssetSha256, /^[a-f0-9]{64}$/);
  for (const [key, shard] of shards) {
    for (const [headword, values] of Object.entries(shard)) {
      headwords++;
      assert.equal(normalizeQuery(headword), headword);
      assert.equal(shardName(headword), key);
      assert.ok(Array.isArray(values) && values.length);
      for (const entry of values) {
        entries++;
        assert.equal(typeof entry.word, "string");
        assert.equal(normalizeQuery(entry.word), headword);
        assert.equal(typeof entry.meaning, "string");
        if (!entry.meaning) blankGlosses++;
        for (const example of entry.examples || []) {
          assert.equal(typeof example.ko, "string");
          assert.equal(typeof example.mn, "string");
        }
      }
    }
  }
  assert.equal(headwords, info.headwordCount);
  assert.equal(entries, info.entryCount);
  assert.equal(entries, info.wordCount + info.idiomCount + info.proverbCount);
  assert.equal(blankGlosses, info.emptyGlossEntryCount);
});

test("real APK dictionary supports Mongolian meanings, homonyms and idioms", async () => {
  const lookup = createDictionaryLookup(async key => shards.get(key));
  assert.equal((await lookup("학교")).entries[0].meaning, "сургууль");
  const apple = await lookup("사과");
  assert.ok(apple.entries.some(entry => entry.meaning === "алим"));
  assert.ok(apple.entries.some(entry => entry.meaning.includes("уучлал")));
  const idiom = await lookup("일 년을 십 년같이");
  assert.equal(idiom.mode, "exact");
  assert.ok(idiom.entries.some(entry => entry.source === "idiom"));
  assert.ok((await lookup("학교에서 한국어를 공부합니다")).entries.some(entry => entry.word === "공부하다"));
});

test("real APK headwords survive website formatting and common inflections", async () => {
  const lookup = createDictionaryLookup(async key => shards.get(key));
  for (const query of ["학\u00ad교", "학\u200e교", "학\u2060교", "ᄒ\u200bᅡᆨ교"]) {
    const result = await lookup(query);
    assert.equal(result.mode, "exact", query);
    assert.equal(result.entries[0]?.word, "학교", query);
    assert.equal(result.entries[0]?.meaning, "сургууль", query);
  }
  for (const [query, lemma] of [["학교입니다", "학교"], ["먹었습니다", "먹다"], ["읽었습니다", "읽다"],
    ["갔어요", "가다"], ["봤어요", "보다"], ["갑니다", "가다"], ["됩니다", "되다"]]) {
    assert.ok((await lookup(query)).entries.some(entry => entry.word === lemma), `${query} → ${lemma}`);
  }
});
