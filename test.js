// Self-check for the pure helpers: `node test.js`.
const assert = require("assert");
const { fuzzy, rank, tagCounts, matchTags, matchColls, countByCollection, renameInList, groupByTitle } = require("./bootstrap.js");

assert.ok(fuzzy("", "anything"));
assert.ok(fuzzy("mdv", "medieval"));
assert.ok(!fuzzy("vdm", "medieval"));
assert.ok(fuzzy("хдг", "хайдеггер"));
assert.ok(!fuzzy("hdg", "хайдеггер"));   // literal characters: no transliteration

// Exact beats prefix beats substring beats scattered; no match is -1.
assert.strictEqual(rank("kant", "kant"), 0);
assert.strictEqual(rank("kant", "kantian ethics"), 1);
assert.strictEqual(rank("kant", "on kant"), 2);
assert.strictEqual(rank("kant", "kein anderer typ"), 3);
assert.strictEqual(rank("kant", "hegel"), -1);

const e = (title, sort, ...tags) => ({ title, sort, tags });
const list = [
	e("Being and Time", "00002", "хайдеггер", "take"),
	e("Being and Time", "00001", "хайдеггер"),
	e("Negative Dialectics", "00001", "адорно", "take"),
];

// Most used first; ties alphabetically.
assert.deepStrictEqual(tagCounts(list), [
	{ tag: "take", n: 2 },
	{ tag: "хайдеггер", n: 2 },
	{ tag: "адорно", n: 1 },
]);

// The tag you typed comes first even though the other one is more used.
const counts = [{ tag: "критика Хайдеггера", n: 29 }, { tag: "Хайдеггер", n: 3 }];
assert.deepStrictEqual(matchTags(counts, "хайдеггер").map((c) => c.tag),
	["Хайдеггер", "критика Хайдеггера"]);
// Both are subsequence matches, so the busier tag wins.
assert.deepStrictEqual(matchTags(counts, "хдг").map((c) => c.tag),
	["критика Хайдеггера", "Хайдеггер"]);
assert.strictEqual(matchTags(counts, "kant").length, 0);
assert.strictEqual(matchTags(counts, "  ").length, 2);   // blank query shows everything

// Collections match on their whole path, and the shallower one wins a tie.
const colls = [
	{ id: 1, path: "Philosophy" },
	{ id: 2, path: "Philosophy / Frankfurt School" },
	{ id: 3, path: "Physics" },
];
assert.deepStrictEqual(matchColls(colls, "phil").map((c) => c.id), [1, 2]);
assert.deepStrictEqual(matchColls(colls, "frankfurt").map((c) => c.id), [2]);
assert.deepStrictEqual(matchColls(colls, "phi f sch").map((c) => c.id), [2]);   // scattered
assert.deepStrictEqual(matchColls(colls, "").map((c) => c.id), [1, 2, 3]);
assert.strictEqual(matchColls(colls, "chemistry").length, 0);

// A highlight counts towards every collection its book sits in, ancestors included.
const counted = countByCollection([
	{ colls: new Set([1, 2]) },
	{ colls: new Set([1]) },
	{ colls: new Set() },
]);
assert.deepStrictEqual([...counted], [[1, 2], [2, 1]]);

// A rename onto an existing tag is a merge: a highlight that had both keeps one.
// Only the libraries actually renamed are touched.
const before = [
	{ libraryID: 1, tags: ["take", "ref"] },
	{ libraryID: 1, tags: ["take", "цитата"] },
	{ libraryID: 2, tags: ["take"] },
];
assert.deepStrictEqual(renameInList(before, "take", "ref", new Set([1])), [
	{ libraryID: 1, tags: ["ref"] },
	{ libraryID: 1, tags: ["цитата", "ref"] },
	{ libraryID: 2, tags: ["take"] },
]);

// One block per book, highlights inside it in reading order.
const books = groupByTitle(list);
assert.deepStrictEqual(books.map((b) => b.title), ["Being and Time", "Negative Dialectics"]);
assert.deepStrictEqual(books[0].rows.map((r) => r.sort), ["00001", "00002"]);

console.log("ok");
