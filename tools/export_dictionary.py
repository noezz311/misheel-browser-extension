"""Export the supplied Android app's offline Korean/Mongolian dictionary.

Standard-library-only reader for this APK's unencrypted Realm file-format 20.
It follows live Realm roots and typed links, rather than scraping string blocks.
The original APK is never modified. This is a deliberately scoped reader, not a
general replacement for Realm: unsupported storage forms fail explicitly.

Realm format references (upstream Apache-2.0 source, accessed 2026-10-12):
https://github.com/realm/realm-core/blob/master/src/realm/node_header.hpp
https://github.com/realm/realm-core/blob/master/src/realm/cluster_tree.cpp
https://github.com/realm/realm-core/blob/master/src/realm/array_key.hpp
https://github.com/realm/realm-core/blob/master/src/realm/array_string_short.hpp
https://github.com/realm/realm-core/blob/master/src/realm/array_blobs_small.hpp
"""
from pathlib import Path
import argparse
import collections
import hashlib
import json
import re
import struct
import unicodedata
import zipfile


class RealmReader:
    def __init__(self, data):
        self.data = data
        assert data[16:20] == b"T-DB", "Not an unencrypted Realm database"
        assert data[20] == 20 and data[21] == 20, "Only this APK's Realm format 20 is supported"

    def header(self, ref):
        assert ref > 0 and ref % 8 == 0 and ref + 8 <= len(self.data), ref
        h = self.data[ref:ref + 8]
        assert h[:4] == b"AAAA", (ref, h.hex())
        flags = h[4]
        return {"ref": ref, "width": (1 << (flags & 7)) >> 1,
                "size": int.from_bytes(h[5:8], "big"), "wtype": (flags >> 3) & 3,
                "inner": bool(flags & 128), "refs": bool(flags & 64), "context": bool(flags & 32)}

    def array(self, ref, unsigned=False):
        h = self.header(ref)
        width, size = h["width"], h["size"]
        assert h["wtype"] == 0, h
        start = ref + 8
        if not width:
            return [0] * size
        if width < 8:
            return [(self.data[start + i * width // 8] >> (i * width % 8)) & ((1 << width) - 1)
                    for i in range(size)]
        format = {8: "b", 16: "h", 32: "i", 64: "q"}[width]
        if unsigned:
            format = format.upper()
        return list(struct.unpack_from("<" + format * size,
                                       self.data, start))

    def strings(self, ref):
        h = self.header(ref)
        if not h["refs"]:
            assert h["wtype"] == 1, h
            w = h["width"]
            if not w:
                return [None] * h["size"]
            result = []
            for i in range(h["size"]):
                pos = ref + 8 + i * w
                length = w - 1 - self.data[pos + w - 1]
                result.append(None if length < 0 else self.data[pos:pos+length].decode("utf-8"))
            return result
        refs = self.array(ref)
        if not h["context"]:
            offsets = self.array(refs[0])
            nulls = self.array(refs[2]) if len(refs) > 2 and refs[2] else [0] * len(offsets)
            blob = refs[1] + 8
            result = []
            previous = 0
            for end, null in zip(offsets, nulls):
                result.append(None if null else self.data[blob+previous:blob+end-1].decode("utf-8"))
                previous = end
            return result
        result = []
        for child in refs:
            if not child:
                result.append(None)
            else:
                ch = self.header(child)
                result.append(self.data[child+8:child+8+ch["size"]-1].decode("utf-8"))
        return result

    def tables(self):
        assert self.data[16:20] == b"T-DB"
        top_ref = struct.unpack_from("<Q", self.data, 8 if self.data[23] & 1 else 0)[0]
        top = self.array(top_ref)
        names = self.strings(top[0])
        refs = self.array(top[1])
        tables = {}
        for name, ref in zip(names, refs):
            if ref & 1:
                continue
            table_top = self.array(ref)
            spec_top = self.array(table_top[0])
            tables[name] = {"ref": ref, "top": table_top, "spec": spec_top,
                            "names": self.strings(spec_top[1]), "types": self.array(spec_top[0]),
                            "attrs": self.array(spec_top[2]),
                            "keys": self.array(spec_top[5]) if len(spec_top) > 5 else []}
        return tables

    def links(self, ref):
        if not ref:
            return []
        assert not self.header(ref)["inner"], "Unsupported inner list node"
        return self.array(ref)

    def clusters(self, ref, offset=0):
        h = self.header(ref)
        arr = self.array(ref)
        if h["inner"]:
            offsets = self.array(arr[0], unsigned=True) if arr[0] else [i << ((arr[1] >> 1) * 8)
                                                                     for i in range(len(arr) - 3)]
            for child, child_offset in zip(arr[3:], offsets):
                yield from self.clusters(child, offset + child_offset)
        else:
            keys = list(range(arr[0] >> 1)) if arr[0] & 1 else self.array(arr[0], unsigned=True)
            yield [key + offset for key in keys], arr[1:]

    def rows(self, table, field_names):
        columns = []
        for name in field_names:
            spec_index = table["names"].index(name)
            leaf_index = table["keys"][spec_index] & 0xffff
            columns.append((name, spec_index, leaf_index))
        for keys, refs in self.clusters(table["top"][2]):
            values = {}
            for name, spec_index, leaf_index in columns:
                ref = refs[leaf_index]
                col_type = table["types"][spec_index]
                values[name] = self.strings(ref) if col_type == 2 else self.array(ref)
                assert len(values[name]) == len(keys), (name, len(keys),len(values[name]))
            for row, key in enumerate(keys):
                yield {"_key": key, **{name: values[name][row] for name in field_names}}


def clean(value):
    """The Android data uses the literal string 'null' for missing strings."""
    return "" if value in (None, "null") else value


def normalize_key(value):
    """Match extension/dictionary.mjs normalizeQuery without altering display text."""
    value = unicodedata.normalize("NFC", value)
    value = re.sub("[\u200b-\u200d\ufeff]", "", value)
    value = re.sub(r"\s+", " ", value).strip()
    while value and unicodedata.category(value[0])[0] in "PS":
        value = value[1:]
    while value and unicodedata.category(value[-1])[0] in "PS":
        value = value[:-1]
    return value.strip()


def shard_name(word):
    code = ord(word[0])
    return str((code - 0xac00) // 588) if 0xac00 <= code <= 0xd7a3 else "other"


def make_entry(word, definitions, *, entry_id, source, pronunciation="", word_type=""):
    definitions = sorted(definitions, key=lambda row: (row["index"], row["_key"]))
    meanings = [clean(row["definition"]) for row in definitions]
    # Keep empty senses and their explanations in the exported examples. Blank
    # dictionary glosses remain blank rather than inventing a translation.
    if len(meanings) == 1:
        meaning = meanings[0]
    else:
        meaning = "\n".join(f"{i + 1}. {text}" for i, text in enumerate(meanings) if text)
    entry = {"word": word, "meaning": meaning, "id": str(entry_id), "source": source}
    if clean(pronunciation):
        entry["pronunciation"] = clean(pronunciation)
    if clean(word_type):
        entry["wordType"] = clean(word_type)
    examples = [{"ko": clean(row["exampleKR"]), "mn": clean(row["exampleMN"]),
                 "sense": row["index"] + 1, "kind": "definition"} for row in definitions
                if clean(row["exampleKR"]) or clean(row["exampleMN"])]
    if examples:
        entry["examples"] = examples
    return entry


def export_dictionary(apk, output):
    with zipfile.ZipFile(apk) as archive:
        data = archive.read("assets/realm/default.realm")
    reader = RealmReader(data)
    tables = reader.tables()
    words = list(reader.rows(tables["class_Word"], ["wordId", "word", "spelling", "wordType", "definitions"]))
    definitions = {row["_key"]: row for row in reader.rows(tables["class_Definition"],
                    ["mainWord", "definition", "exampleKR", "exampleMN", "index"])}
    words_by_key = {row["_key"]: row for row in words}
    assert len(words_by_key) == len(words), "Duplicate Word object key"
    assert all(row["mainWord"] - 1 in words_by_key for row in definitions.values()), "Orphan definition link"
    grouped = collections.defaultdict(list)
    for row in definitions.values():
        # Realm ArrayKey<1> stores nullable to-one links as ObjKey + 1.
        grouped[row["mainWord"] - 1].append(row)

    entries = []
    seen_definitions = set()
    for word in sorted(words, key=lambda row: int(row["wordId"])):
        linked = reader.links(word["definitions"])
        expected = {row["_key"] for row in grouped[word["_key"]]}
        assert len(linked) == len(set(linked)) and set(linked) == expected, "Word/Definition links disagree"
        assert linked, f"Word {word['wordId']} has no definitions"
        seen_definitions.update(linked)
        entries.append(make_entry(word["word"], [definitions[key] for key in linked],
                    entry_id=word["wordId"], source="word", pronunciation=word["spelling"], word_type=word["wordType"]))
    assert seen_definitions == set(definitions), "Some definitions were not exported"

    # Idiom/proverb meanings live in the distinct Define table; list ObjKeys are
    # stored without the +1 adjustment used by nullable to-one links.
    phrase_definitions = {row["_key"]: row for row in reader.rows(tables["class_Define"],
                                                ["definition", "exampleKR", "exampleMN", "index"])}
    phrase_counts = {}
    seen_phrase_definitions = set()
    for table_name, id_field, word_field, source in [
        ("class_Idiom", "idiomId", "mainIdiom", "idiom"),
        ("class_Proverb", "proverbId", "mainProverb", "proverb")]:
        phrases = list(reader.rows(tables[table_name], [id_field, word_field, "definitions"]))
        phrase_counts[source] = len(phrases)
        for phrase in sorted(phrases, key=lambda row: int(row[id_field])):
            linked = reader.links(phrase["definitions"])
            assert linked and all(key in phrase_definitions for key in linked), "Missing phrase meaning"
            seen_phrase_definitions.update(linked)
            entries.append(make_entry(phrase[word_field], [phrase_definitions[key] for key in linked],
                              entry_id=phrase[id_field], source=source))
    assert seen_phrase_definitions == set(phrase_definitions), "Some phrase definitions were not exported"

    shards = {str(i): collections.defaultdict(list) for i in range(19)}
    shards["other"] = collections.defaultdict(list)
    for entry in entries:
        key = normalize_key(entry["word"])
        assert key, "A headword normalized to an empty key"
        shards[shard_name(key)][key].append(entry)
    output.mkdir(parents=True, exist_ok=True)
    shard_dir = output / "shards"
    shard_dir.mkdir(exist_ok=True)
    for name, shard in shards.items():
        text = json.dumps(dict(sorted(shard.items())), ensure_ascii=False, separators=(",", ":")) + "\n"
        (shard_dir / f"{name}.json").write_text(text, encoding="utf-8", newline="\n")

    translated_contexts = list(reader.rows(tables["class_Translation"], ["context", "translation"]))
    assert all(not clean(row["translation"]) for row in translated_contexts), "Review newly translated usage contexts"
    metadata = {
        "formatVersion": 1,
        "source": "User-supplied Misheel Korean-Mongolian Android APK",
        "sourceApk": apk.name,
        "sourceApkSha256": hashlib.sha256(apk.read_bytes()).hexdigest(),
        "sourceAsset": "assets/realm/default.realm",
        "sourceAssetSha256": hashlib.sha256(data).hexdigest(),
        "realmFileFormatVersion": 20,
        "sourceLanguage": "ko", "targetLanguage": "mn",
        "entryCount": len(entries), "wordCount": len(words),
        "headwordCount": sum(len(shard) for shard in shards.values()),
        "definitionCount": len(definitions),
        "idiomCount": phrase_counts["idiom"], "proverbCount": phrase_counts["proverb"],
        "phraseDefinitionCount": len(phrase_definitions),
        "emptyGlossEntryCount": sum(not entry["meaning"] for entry in entries),
        "shards": list(shards),
        "exampleKind": "definition-explanations",
        "notes": [
            "All Word, Definition, Idiom, Proverb and Define records are retained; Word links are verified in both directions.",
            "exampleKR/exampleMN are bilingual definition explanations, not translated usage sentences.",
            "Blank dictionary glosses are preserved; their available Korean/Mongolian explanations are retained.",
            f"{len(translated_contexts)} usage contexts have no Mongolian translations in the supplied APK and are excluded.",
            "Android fonts, tracking SDKs, credentials, history tables and server endpoints are excluded.",
            "Keys use NFC, collapse whitespace and trim outer punctuation/symbols; entry.word preserves the original spelling.",
        ],
    }
    (output / "index.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return metadata


def main():
    parser = argparse.ArgumentParser()
    workspace = Path(__file__).resolve().parent.parent
    parser.add_argument("--apk", type=Path, help="Android APK containing assets/realm/default.realm")
    parser.add_argument("--output", type=Path, default=workspace / "extension" / "data")
    args = parser.parse_args()
    apk = args.apk
    if apk is None:
        apks = list(workspace.glob("*.apk"))
        parser.error("Supply --apk when the workspace does not contain exactly one APK") if len(apks) != 1 else None
        apk = apks[0]
    metadata = export_dictionary(apk.resolve(), args.output.resolve())
    print(json.dumps({key: metadata[key] for key in ["entryCount", "wordCount", "headwordCount", "definitionCount",
                        "idiomCount", "proverbCount", "phraseDefinitionCount", "emptyGlossEntryCount"]}))
    print(f"Exported dictionary to {args.output.resolve()}")


if __name__ == "__main__":
    main()
