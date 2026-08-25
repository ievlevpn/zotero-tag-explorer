// Self-check for the pure helpers: `node test.js`.
const assert = require("assert");
const { fuzzy, rank, tagCounts, matchTags, matchColls, countByCollection, renameInList, parseMarkup, matchText, neighbours, matchBooks, bookList, related, dupeClusters, nearMisses, clusterKey, withoutDismissed, groupByBook } = require("./bootstrap.js");

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

const e = (title, sort, ...tags) => ({ title, sort, tags, book: title.length, creator: "" });
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

// The four formats Zotero writes become nodes; everything else stays text.
assert.deepStrictEqual(parseMarkup("plain"), ["plain"]);
assert.deepStrictEqual(parseMarkup("a <b>bold</b> c"),
	["a ", { tag: "b", kids: ["bold"] }, " c"]);
assert.deepStrictEqual(parseMarkup("x<sub>1</sub><sup>2</sup>"),
	["x", { tag: "sub", kids: ["1"] }, { tag: "sup", kids: ["2"] }]);
assert.deepStrictEqual(parseMarkup("<b>outer <i>both</i></b>"),
	[{ tag: "b", kids: ["outer ", { tag: "i", kids: ["both"] }] }]);

// Maths, not markup: highlights are full of stray angle brackets.
assert.deepStrictEqual(parseMarkup("< H \u2264 1"), ["< H \u2264 1"]);
assert.deepStrictEqual(parseMarkup("<\u2026> \u043c\u0438\u0440"), ["<\u2026> \u043c\u0438\u0440"]);
assert.deepStrictEqual(parseMarkup("<p)=<p(x"), ["<p)=<p(x"]);
assert.deepStrictEqual(parseMarkup("<1>-'"), ["<1>-'"]);
assert.deepStrictEqual(parseMarkup("</b> alone"), ["</b>", " alone"]);   // closer with nothing open

// Malformed but survivable: an unclosed tag just runs to the end.
assert.deepStrictEqual(parseMarkup("<i>never closed"),
	[{ tag: "i", kids: ["never closed"] }]);

// Filtering inside a tag: every word must appear, order does not matter, and it
// looks in the highlight, the comment and the book title alike.
const hls = [
	{ text: "Late antiquity is not a twilight but a different noon.", comment: "refuse the language of decline", title: "Brown, Late Antiquity" },
	{ text: "The Middle Ages did not know itself as an age in the middle.", comment: "periodisation", title: "Le Goff, The Medieval Imagination" },
	{ text: "", comment: "", title: "Adorno, Negative Dialectics" },
];
assert.strictEqual(matchText(hls, "").length, 3);
assert.strictEqual(matchText(hls, "   ").length, 3);
assert.deepStrictEqual(matchText(hls, "twilight").map((r) => r.title), ["Brown, Late Antiquity"]);
assert.deepStrictEqual(matchText(hls, "decline").map((r) => r.title), ["Brown, Late Antiquity"]);  // comment
assert.deepStrictEqual(matchText(hls, "adorno").map((r) => r.title), ["Adorno, Negative Dialectics"]);  // title
assert.strictEqual(matchText(hls, "brown decline").length, 1);
assert.strictEqual(matchText(hls, "decline brown").length, 1);   // order does not matter
assert.strictEqual(matchText(hls, "MIDDLE ages").length, 1);     // case-insensitive
assert.strictEqual(matchText(hls, "twilight periodisation").length, 0);  // every word must hit

// The tag graph: who shares a highlight with whom, strongest link first.
const graph = [
	{ tags: ["Arendt", "labour", "work"] },
	{ tags: ["Arendt", "labour"] },
	{ tags: ["Arendt", "the public realm"] },
	{ tags: ["Weber", "iron cage"] },
];
assert.deepStrictEqual(neighbours(graph, "Arendt"),
	[{ tag: "labour", n: 2 }, { tag: "the public realm", n: 1 }, { tag: "work", n: 1 }]);
assert.deepStrictEqual(neighbours(graph, "Weber"), [{ tag: "iron cage", n: 1 }]);
assert.deepStrictEqual(neighbours(graph, "iron cage"), [{ tag: "Weber", n: 1 }]);
assert.deepStrictEqual(neighbours(graph, "nobody"), []);          // a tag with no company
assert.strictEqual(neighbours(graph, "Arendt", 1).length, 1);     // honours the limit

// --- duplicate tags ------------------------------------------------------
const tag = (t, n) => ({ tag: t, n });

const d = dupeClusters([
	tag("White noise", 3), tag("white noise", 1),
	tag("rough path", 2), tag("rough paths", 1),
	tag("limit theorem", 2), tag("Limit Theorems", 1),
	tag("!", 108), tag("?", 4), tag("\\", 1),            // punctuation is never folded away
	tag("condition D' (EVT)", 3), tag("condition D (EVT)", 2),
	tag("Кант", 18), tag("Конт", 2),                  // one letter, different philosophers
	tag("alone", 5),
]);
assert.deepStrictEqual(d.map((c) => [c.why, c.tags.map((t) => t.tag)]), [
	["capitalisation", ["White noise", "white noise"]],
	["singular and plural", ["limit theorem", "Limit Theorems"]],
	["singular and plural", ["rough path", "rough paths"]],
]);

// Spacing and NFC differences fold; the most used spelling leads.
const sp = dupeClusters([tag("rough  path", 1), tag("rough path", 9)]);
assert.deepStrictEqual(sp[0].tags.map((t) => t.tag), ["rough path", "rough  path"]);
assert.strictEqual(sp[0].why, "spacing");

// Near misses: long enough, and one side used once against an established one.
const near = nearMisses([
	tag("Берггольц, Ольга", 9), tag("Берргольц, Ольга", 1),   // a real typo
	tag("ref", 297), tag("rem", 1),                          // too short to judge
	tag("национализм", 9), tag("рационализм", 4),            // both established: not offered
	tag("White noise", 3), tag("white noise", 1),            // dupeClusters' job, not this one
]);
assert.deepStrictEqual(near.map((c) => c.tags.map((t) => t.tag)),
	[["Берггольц, Ольга", "Берргольц, Ольга"]]);

// Dismissing a cluster: identified by exactly which names are in it.
assert.strictEqual(clusterKey(["b", "a"]), clusterKey(["a", "b"]));          // order-free
assert.notStrictEqual(clusterKey(["a", "b"]), clusterKey(["a", "b", "c"]));  // a new member is new

const three = [
	{ why: "capitalisation", tags: [tag("White noise", 3), tag("white noise", 1)] },
	{ why: "one letter", tags: [tag("2-correlator", 6), tag("6-correlator", 1)] },
];
assert.strictEqual(withoutDismissed(three, []).length, 2);
assert.deepStrictEqual(
	withoutDismissed(three, [["6-correlator", "2-correlator"]]).map((c) => c.tags[0].tag),
	["White noise"]);
// A dismissed pair does not silence a bigger cluster that contains it.
assert.strictEqual(withoutDismissed(
	[{ why: "x", tags: [tag("a", 1), tag("b", 1), tag("c", 1)] }], [["a", "b"]]).length, 1);

// One block per book, highlights inside it in reading order.
const books = groupByBook(list);
assert.deepStrictEqual(books.map((b) => b.title), ["Being and Time", "Negative Dialectics"]);
assert.deepStrictEqual(books[0].rows.map((r) => r.sort), ["00001", "00002"]);

console.log("ok");
