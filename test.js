// Self-check for the pure helpers: `node test.js`.
const assert = require("assert");
const { fuzzy, rank, tagCounts, matchTags, groupByTitle } = require("./bootstrap.js");

assert.ok(fuzzy("", "anything"));
assert.ok(fuzzy("mdv", "medieval"));
assert.ok(!fuzzy("vdm", "medieval"));

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

// One block per book, highlights inside it in reading order.
const books = groupByTitle(list);
assert.deepStrictEqual(books.map((b) => b.title), ["Being and Time", "Negative Dialectics"]);
assert.deepStrictEqual(books[0].rows.map((r) => r.sort), ["00001", "00002"]);

console.log("ok");
