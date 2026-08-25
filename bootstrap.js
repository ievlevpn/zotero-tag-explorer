/* Tag Explorer — a tiny Zotero plugin (bootstrapped, Zotero 10).
 *
 * Tools → Tag Explorer opens a window: fuzzy-search your tags on the left,
 * read the highlights and comments carrying that tag on the right, optionally
 * restricted to one collection.
 *
 * No storage of its own. Every tagged annotation in every library is read into
 * one flat array when the window opens, and every view is a scan over it.
 * ponytail: linear scans over ~10k annotations are microseconds; if the
 * library grows an order of magnitude, index tag → entries once instead.
 *
 * No build step: plain bootstrapped plugin. Zip the folder — see README.md.
 */

const TAG_CAP = 400;   // rows rendered per search — tags or books
const BOOK_TAGS = 24;  // tag chips shown on a book before "+N more"      // tag rows rendered per search — the rest are a count
const HL_CAP = 200;       // highlights rendered per tag before "show all"

let menuID = null;
let collectionMenuID = null;

let entries = [];         // every tagged annotation — see buildIndex()
let counts = [];          // [{ tag, n }] for the current scope, best first
let dismissed = [];       // [[name, name, …]] you have said are not duplicates
let libTags = [];         // [{ tag, n, libs }] every tag in the library, with how
                          // many items carry it — a merge moves items, not
                          // highlights, and reaches tags no annotation has
let dupes = [];           // clusters of the same tag spelled differently
let nears = [];           // one-letter neighbours worth a second look
let loading = null;       // the in-flight buildIndex(), or null
let win = null;           // the one explorer window
let scope = null;         // collection id the view is restricted to, or null
let axis = "tags";        // which list the left pane offers: "tags" | "books"
let relOpen = false;      // is the related-books list unfolded? remembered
                          // across books, since it is a density preference
let view = null;          // what the right pane shows:
                          //   { kind: "tag" | "book" | "find", value }

const DISMISS_PREF = "tagExplorer.notDuplicates";
const STATE_PREF = "tagExplorer.state";     // window geometry and where you were

const oops = (e) => Zotero.logError(e);

function safe(fn, fallback) {
	try { return fn(); } catch (e) { oops(e); return fallback; }
}

// Zotero's prefs outlive restarts and plugin upgrades, which is all this needs.
function loadDismissed() {
	const saved = safe(() => JSON.parse(Zotero.Prefs.get(DISMISS_PREF) || "[]"), []);
	dismissed = Array.isArray(saved) ? saved.filter(Array.isArray) : [];
}

function saveDismissed() {
	safe(() => Zotero.Prefs.set(DISMISS_PREF, JSON.stringify(dismissed)));
}

// Where the window was and what you were reading. A tool you dip into twenty
// times a day should not start from nothing each time.
let geometry = null;

function loadState() {
	const was = safe(() => JSON.parse(Zotero.Prefs.get(STATE_PREF) || "null"), null);
	if (!was) return;
	geometry = was.geometry || null;
	if (was.axis === "books" || was.axis === "tags") axis = was.axis;
	if (was.view && was.view.kind) view = was.view;
	if (typeof was.scope === "number") scope = was.scope;
}

function saveState(win) {
	safe(() => {
		if (win && !win.closed && win.outerWidth > 200) {
			geometry = { w: win.outerWidth, h: win.outerHeight, x: win.screenX, y: win.screenY };
		}
		Zotero.Prefs.set(STATE_PREF, JSON.stringify({ geometry, axis, view, scope }));
	});
}

// A window remembered on one screen can be off every screen on the next launch.
function features(main) {
	const g = geometry;
	if (!g || !(g.w > 200) || !(g.h > 200)) return "chrome,centerscreen,resizable,scrollbars,width=1000,height=740";
	let where = "centerscreen";
	const screen = safe(() => main.screen, null);
	if (screen && g.x > -g.w + 100 && g.y >= 0
		&& g.x < screen.availWidth - 100 && g.y < screen.availHeight - 100) {
		where = `screenX=${Math.round(g.x)},screenY=${Math.round(g.y)}`;
	}
	return `chrome,resizable,scrollbars,width=${Math.round(g.w)},height=${Math.round(g.h)},${where}`;
}


// --- pure helpers (test.js checks these) -----------------------------------

// Classic subsequence match: every character of the query appears in the text,
// in order, not necessarily adjacent. "mdv" finds "medieval".
function fuzzy(q, text) {
	if (!q) return true;
	let i = 0;
	for (let j = 0; j < text.length && i < q.length; j++) {
		if (text[j] === q[i]) i++;
	}
	return i === q.length;
}

// How well `text` answers `q`, smaller is better; -1 means it doesn't.
// Typing a tag's name should put that tag first, not the longer tag that
// happens to contain it: exact beats prefix beats substring beats scattered.
function rank(q, text) {
	if (!q) return 0;
	if (text === q) return 0;
	const at = text.indexOf(q);
	if (at === 0) return 1;
	if (at > 0) return 2;
	return fuzzy(q, text) ? 3 : -1;
}

function tagCounts(list) {
	const m = new Map();
	for (const e of list) for (const t of e.tags) m.set(t, (m.get(t) || 0) + 1);
	return [...m].map(([tag, n]) => ({ tag, n }))
		.sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}

// Rank a list against a query and drop what doesn't match. `key` says what to
// search, `tie` orders the equally good.
function matchBy(list, query, key, tie) {
	const q = query.trim().toLowerCase();
	if (!q) return list;
	return list.map((x) => ({ x, r: rank(q, key(x).toLowerCase()) }))
		.filter((y) => y.r >= 0)
		.sort((a, b) => a.r - b.r || tie(a.x, b.x))
		.map((y) => y.x);
}

const matchTags = (tags, q) =>
	matchBy(tags, q, (t) => t.tag, (a, b) => b.n - a.n || a.tag.localeCompare(b.tag));

// Collections are searched by their whole path, so "phil frank" finds
// "Philosophy / Frankfurt School". Shorter paths first: the shallower
// collection is the one you meant.
const matchColls = (colls, q) =>
	matchBy(colls, q, (c) => c.path, (a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));

const matchBooks = (books, q) =>
	matchBy(books, q, (b) => `${b.creator} ${b.title}`,
		(a, b) => b.n - a.n || a.title.localeCompare(b.title));

function countByCollection(list) {
	const m = new Map();
	for (const e of list) for (const id of e.colls) m.set(id, (m.get(id) || 0) + 1);
	return m;
}

// Mirror a finished rename in the index. Renaming onto a tag that already
// exists is a merge, in Zotero and here: a highlight carrying both ends up
// with one.
function renameInList(list, oldName, newName, libs) {
	for (const e of list) {
		if (!libs.has(e.libraryID)) continue;
		const at = e.tags.indexOf(oldName);
		if (at < 0) continue;
		e.tags.splice(at, 1);
		if (!e.tags.includes(newName)) e.tags.push(newName);
	}
	return list;
}

// Zotero's reader writes exactly four formats into annotation text, comments
// and item fields. Nothing else is markup: highlights are full of maths like
// "< H \u2264 1" and "<\u2026>", and a real HTML parser would swallow it. So only
// these tags, in pairs, are ever taken as markup — a lone "</b>" stays text.
const MARKUP = /<(\/?)(b|i|sub|sup)>/gi;

// -> a tree of strings and { tag, kids }, which markup() turns into elements.
function parseMarkup(str) {
	const root = { tag: null, kids: [] };
	const stack = [root];
	const put = (x) => { if (x) stack[stack.length - 1].kids.push(x); };
	let last = 0;
	for (const m of str.matchAll(MARKUP)) {
		put(str.slice(last, m.index));
		last = m.index + m[0].length;
		const tag = m[2].toLowerCase();
		if (!m[1]) {
			const node = { tag, kids: [] };
			put(node);
			stack.push(node);
		} else {
			let at = -1;
			for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { at = i; break; }
			if (at < 0) put(m[0]);      // a closer with nothing open: literal text
			else stack.length = at;     // closes it, and anything left open inside it
		}
	}
	put(str.slice(last));
	return root.kids;
}

// Filtering inside a tag is a different job from finding the tag: a subsequence
// match over 200 characters of prose matches nearly everything. Plain substrings,
// every word required, in any order, across the highlight, your comment and the
// book — so "brown decline" finds it and "decline brown" finds it too.
function matchText(rows, query) {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return rows;
	return rows.filter((r) => {
		const hay = (r.text + " " + r.comment + " " + r.title + " " + (r.creator || "")).toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

// The tags that share a highlight with this one, strongest link first. This is
// the whole lateral move: your tags already form a graph, nothing has ever
// shown it to you.
function neighbours(rows, tag, limit = 14) {
	const m = new Map();
	for (const e of rows) {
		if (!e.tags.includes(tag)) continue;
		for (const t of e.tags) if (t !== tag) m.set(t, (m.get(t) || 0) + 1);
	}
	return [...m].map(([t, n]) => ({ tag: t, n }))
		.sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
		.slice(0, limit);
}

// Split a plain string into runs, marking the parts that matched the filter.
// A mask rather than successive replacements: two search words can overlap in
// the text ("deep" and "epl" in "deeply"), and marking twice would nest.
function markRuns(str, words) {
	if (!str || !words.length) return str ? [str] : [];
	const low = str.toLowerCase();
	const hit = new Array(str.length).fill(false);
	for (const w of words) {
		if (!w) continue;
		for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) {
			for (let k = i; k < i + w.length; k++) hit[k] = true;
		}
	}
	const out = [];
	let start = 0;
	for (let i = 1; i <= str.length; i++) {
		if (i < str.length && hit[i] === hit[i - 1]) continue;
		const piece = str.slice(start, i);
		out.push(hit[start] ? { mark: piece } : piece);
		start = i;
	}
	return out;
}

// The markup tags stripped, for anything that wants the words alone.
const plain = (str) => str.replace(MARKUP, "");

// A highlight as something you can paste into what you are writing: the quote,
// where it came from, and what you said about it.
function asText(e) {
	const where = [e.creator, plain(e.title), e.page && "p. " + e.page].filter(Boolean).join(", ");
	return [
		e.text ? `\u201C${plain(e.text)}\u201D` : `[${e.type}]`,
		where && "\u2014 " + where,
		plain(e.comment),
	].filter(Boolean).join("\n");
}

// Highlights read as a book at a time, in reading order. Keyed on the book, not
// on its name: two different books can share a title, and merging them would be
// a quiet lie about where a highlight came from.
function groupByBook(list) {
	const out = [];
	const sorted = list.slice().sort((a, b) =>
		a.title.localeCompare(b.title) || (a.book - b.book) || String(a.sort).localeCompare(String(b.sort)));
	for (const e of sorted) {
		const last = out[out.length - 1];
		if (!last || last.book !== e.book) {
			out.push({ book: e.book, title: e.title, creator: e.creator, rows: [] });
		}
		out[out.length - 1].rows.push(e);
	}
	return out;
}

// --- duplicate tags ---------------------------------------------------------

// Only separators fold. Hyphens, dashes and underscores are how one writer
// spells a space ("machine learning" / "machine-learning", "Cameron-Martin" /
// "Cameron–Martin"), so those are the same tag. Everything else punctuation
// does is left alone, because it carries meaning — "condition D' (EVT)" is not
// "condition D (EVT)", "T^+ (regularity structures)" is not "T (regularity
// structures)" — and stripping it wholesale also collapses every
// punctuation-only tag ("!", "?", "\\") onto the empty string.
const squash = (t) => t.normalize("NFC").trim().replace(/\s+/g, " ");
const fold = (t) => squash(t).toLowerCase();
const loose = (t) => fold(t).replace(/[-\u2010-\u2015_]+/g, " ").replace(/\s+/g, " ").trim();
const stem = (t) => loose(t).replace(/s$/, "");

function why(tags) {
	if (new Set(tags.map((t) => t.toLowerCase())).size === 1) return "capitalisation";
	if (new Set(tags.map(fold)).size === 1) return "spacing";
	if (new Set(tags.map(loose)).size === 1) return "hyphenation";
	return "singular and plural";
}

// Tags that are the same tag written differently. Only the folds that cannot
// change meaning, so every cluster here is safe to merge.
function dupeClusters(counts) {
	const g = new Map();
	for (const c of counts) {
		const key = stem(c.tag);
		if (!key) continue;                       // a tag of pure punctuation is its own thing
		if (!g.has(key)) g.set(key, []);
		g.get(key).push(c);
	}
	return [...g.values()].filter((v) => v.length > 1)
		.map((v) => {
			const tags = v.slice().sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
			return { why: why(tags.map((t) => t.tag)), tags };
		})
		.sort((a, b) => sum(b.tags) - sum(a.tags) || a.tags[0].tag.localeCompare(b.tags[0].tag));
}

const sum = (tags) => tags.reduce((k, t) => k + t.n, 0);

// One typo apart — and almost always not a typo. Systematically named tags sit
// one letter from each other on purpose ("2-correlator"/"4-correlator",
// "XII век"/"XIV век", "Кант"/"Конт"), so two guards do the work: the names must
// be long enough that one letter is a small share of them, and one must be used
// once while the other is established. That turns 73 guesses into a handful.
function nearMisses(counts, minLength = 8, established = 3) {
	const by = new Map();
	for (const c of counts) by.set(c.tag, c.n);
	const buckets = new Map();
	const add = (k, t) => {
		if (!buckets.has(k)) buckets.set(k, new Set());
		buckets.get(k).add(t);
	};
	for (const c of counts) {
		if (c.tag.length < minLength) continue;
		const low = fold(c.tag);
		add(low, c.tag);
		for (let i = 0; i < low.length; i++) add(low.slice(0, i) + "\u0000" + low.slice(i + 1), c.tag);
	}
	const out = new Map();
	for (const set of buckets.values()) {
		if (set.size < 2) continue;
		const list = [...set];
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const a = list[i], b = list[j];
				if (Math.abs(a.length - b.length) > 1) continue;
				if (stem(a) === stem(b)) continue;          // dupeClusters already has it
				const lo = Math.min(by.get(a), by.get(b));
				const hi = Math.max(by.get(a), by.get(b));
				if (lo !== 1 || hi < established) continue;
				const key = [a, b].sort().join("\u0000");
				if (!out.has(key)) {
					out.set(key, { why: "one letter", tags: [{ tag: a, n: by.get(a) }, { tag: b, n: by.get(b) }]
						.sort((x, y) => y.n - x.n) });
				}
			}
		}
	}
	return [...out.values()]
		.sort((a, b) => sum(b.tags) - sum(a.tags) || a.tags[0].tag.localeCompare(b.tags[0].tag));
}

// A cluster is identified by exactly which names are in it. Add a fourth
// spelling later and it is a new cluster, worth asking about again.
const clusterKey = (names) => names.slice().sort().join("\u0000");
const namesOf = (c) => c.tags.map((t) => t.tag);

function withoutDismissed(clusters, dismissed) {
	const skip = new Set(dismissed.map(clusterKey));
	return clusters.filter((c) => !skip.has(clusterKey(namesOf(c))));
}

// The second axis: every book with highlights here, most marked first.
function bookList(rows) {
	const m = new Map();
	for (const e of rows) {
		let b = m.get(e.book);
		if (!b) m.set(e.book, b = { book: e.book, title: e.title, creator: e.creator, n: 0 });
		b.n++;
	}
	return [...m.values()].sort((a, b) => b.n - a.n || a.title.localeCompare(b.title));
}

// Books sharing tags with this one, most shared first. Raw counts, deliberately:
// in a real library almost every tag lives in one or two books, so only a
// handful span enough of them to distort this — weighting them down would cost
// code and change nothing.
function related(rows, book, limit = 8) {
	const byBook = new Map();
	for (const e of rows) {
		let b = byBook.get(e.book);
		if (!b) byBook.set(e.book, b = { book: e.book, title: e.title, creator: e.creator, tags: new Set() });
		for (const t of e.tags) b.tags.add(t);
	}
	const mine = byBook.get(book);
	if (!mine) return [];
	const out = [];
	for (const b of byBook.values()) {
		if (b.book === book) continue;
		let shared = 0;
		for (const t of b.tags) if (mine.tags.has(t)) shared++;
		if (shared) out.push({ book: b.book, title: b.title, creator: b.creator, shared });
	}
	return out.sort((a, b) => b.shared - a.shared || a.title.localeCompare(b.title)).slice(0, limit);
}

// --- the index -------------------------------------------------------------

// Every collection an item sits in, plus their ancestors: a highlight in a
// sub-collection belongs to the project above it too.
function collectionsOf(item) {
	const out = new Set();
	for (const id of safe(() => item.getCollections(), [])) {
		let c = Zotero.Collections.get(id);
		while (c && !out.has(c.id)) {   // stop at the first ancestor already in
			out.add(c.id);
			c = c.parentID ? Zotero.Collections.get(c.parentID) : null;
		}
	}
	return out;
}

// Zotero inlines these ids into the SQL it runs, and Zotero.DB writes every
// statement to the debug log in full. Ten thousand ids in one statement is a
// 58 KB line, and the debug viewer lays out one paragraph per line with no
// byte limit — enough to hang Zotero the moment you open it. Small statements
// instead, which also lets the event loop breathe between them.
const CHUNK = 500;

async function loadItems(ids, dataTypes) {
	const out = [];
	for (let i = 0; i < ids.length; i += CHUNK) {
		const part = (await Zotero.Items.getAsync(ids.slice(i, i + CHUNK))).filter(Boolean);
		await Zotero.Items.loadDataTypes(part, dataTypes);
		out.push(...part);
	}
	return out;
}

// One row per tagged annotation. The SQL only picks the ids — going through
// the item API for everything else keeps this out of Zotero's schema.
async function buildIndex() {
	const ids = await Zotero.DB.columnQueryAsync(
		"SELECT DISTINCT a.itemID FROM itemAnnotations a JOIN itemTags t ON t.itemID = a.itemID");
	const anns = (await loadItems(ids, ["annotation", "tags"])).filter((a) => !a.deleted);

	// The attachment holds the annotation; its parent is the book.
	const parents = await loadItems([...new Set(anns.map((a) => a.parentID).filter(Boolean))]);
	const tops = await loadItems([...new Set(parents.map((p) => p.parentID).filter(Boolean))]);

	const collsOf = new Map();   // top item id → its collections, worked out once
	const out = [];
	for (const a of anns) {
		const top = safe(() => a.topLevelItem, null);
		if (!top || top.deleted) continue;
		if (!collsOf.has(top.id)) collsOf.set(top.id, collectionsOf(top));
		out.push({
			id: a.id,
			libraryID: a.libraryID,
			tags: safe(() => a.getTags().map((t) => t.tag), []),
			type: a.annotationType,
			color: a.annotationColor || "#888888",
			text: (a.annotationText || "").trim(),
			comment: (a.annotationComment || "").trim(),
			page: a.annotationPageLabel || "",
			sort: a.annotationSortIndex || "",
			book: top.id,
			title: safe(() => top.getDisplayTitle(), "") || "(untitled)",
			// Titles do not carry the author, so without this you cannot search
			// for "brown" and you cannot tell two editions apart in a list.
			creator: safe(() => top.getField("firstCreator"), "") || "",
			colls: collsOf.get(top.id),
		});
	}
	entries = out;
	await loadLibraryTags();
}

const inScope = (e) => !scope || e.colls.has(scope);

// Duplicate hunting looks at the whole library, not at the annotation index:
// renaming a tag moves every item carrying it, so a pair like "Entropy"/"entropy"
// that lives only on books is exactly as much a duplicate as one on highlights.
async function loadLibraryTags() {
	const rows = await Zotero.DB.queryAsync(
		"SELECT t.name AS tag, i.libraryID AS lib, COUNT(*) AS n "
		+ "FROM itemTags it JOIN tags t ON t.tagID = it.tagID "
		+ "JOIN items i ON i.itemID = it.itemID "
		+ "LEFT JOIN deletedItems d ON d.itemID = it.itemID "
		+ "WHERE d.itemID IS NULL GROUP BY t.name, i.libraryID");
	const m = new Map();
	for (const r of rows) {
		let t = m.get(r.tag);
		if (!t) m.set(r.tag, t = { tag: r.tag, n: 0, libs: new Set() });
		t.n += r.n;
		t.libs.add(r.lib);
	}
	libTags = [...m.values()];
}

function rescope() {
	counts = tagCounts(entries.filter(inScope));
	// Here rather than in the render: this runs on a scope change or a merge,
	// not on every keystroke.
	dupes = withoutDismissed(dupeClusters(libTags), dismissed);
	nears = withoutDismissed(nearMisses(libTags), dismissed);
	if (!view) return;
	// A view that the new scope has emptied is not a view any more.
	if (view.kind === "tag" && !counts.some((c) => c.tag === view.value)) view = null;
	if (view.kind === "book") {
		const rows = entries.filter((e) => inScope(e) && e.book === view.value);
		if (!rows.length) view = null;
		else if (view.tag && !rows.some((e) => e.tags.includes(view.tag))) {
			view = { kind: "book", value: view.value };
		}
	}
}

// --- the window ------------------------------------------------------------

const CSS = `
/* The page is built from system colours, and they only follow the app's theme
 * when the document says it handles both. Zotero's own HTML views do the same. */
:root { color-scheme: light dark; }
body { margin:0; height:100vh; display:flex; flex-direction:column;
	font:13px sans-serif; background:Canvas; color:CanvasText; }
.head { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid GrayText; }
.pick { position:relative; flex:1; min-width:0; }
.pick input { width:100%; box-sizing:border-box; font:13px sans-serif; background:Canvas; color:CanvasText;
	border:1px solid GrayText; border-radius:5px; padding:3px 6px; }
.drop { position:absolute; top:calc(100% + 3px); left:0; right:0; z-index:9; max-height:60vh; overflow:auto;
	background:Canvas; border:1px solid GrayText; border-radius:5px; box-shadow:0 4px 12px rgba(0,0,0,.35); }
.drop .row { display:flex; gap:8px; align-items:baseline; padding:3px 8px; cursor:pointer; }
.drop .row span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.drop .row b { color:GrayText; font-size:11px; font-weight:400; font-variant-numeric:tabular-nums; }
.drop .row.on { background:Highlight; color:HighlightText; }
.drop .row.on b { color:HighlightText; }
.head button { font:12px sans-serif; padding:3px 10px; border:1px solid GrayText;
	border-radius:5px; background:transparent; color:CanvasText; cursor:pointer; }
.head button:hover { background:Highlight; color:HighlightText; }
.head .n { color:GrayText; font-size:11px; white-space:nowrap; }
.head button.step { font:12px sans-serif; padding:3px 8px; min-width:28px; }
.head button.step:disabled { color:GrayText; border-color:color-mix(in srgb, GrayText 40%, Canvas);
	cursor:default; background:transparent; }
.tag.all, .tag.dup { color:GrayText; font-style:italic; }
.tag.all.on, .tag.dup.on { color:HighlightText; }
.sect { display:flex; align-items:baseline; gap:8px; margin:18px 0 2px; }
.sect h2 { font-size:12px; margin:0; }
.sect span { color:GrayText; font-size:11px; }
.sect button { font:11px sans-serif; padding:1px 9px; border:1px solid GrayText; border-radius:5px;
	background:transparent; color:CanvasText; cursor:pointer; }
.sect button:hover { background:Highlight; color:HighlightText; }
.dupe { border:1px solid color-mix(in srgb, GrayText 40%, Canvas); border-radius:6px;
	padding:7px 10px 8px; margin:8px 0; }
.dupe.maybe { border-style:dashed; }
.dupe .top { display:flex; align-items:center; gap:10px; }
.dupe .why { flex:1; min-width:0; color:GrayText; font-size:11px; }
.dupe.maybe .why { font-style:italic; }
.dupe button { font:11px sans-serif; padding:2px 10px; border:1px solid GrayText;
	border-radius:5px; background:transparent; color:CanvasText; cursor:pointer; white-space:nowrap; }
.dupe button:hover:not(:disabled) { background:Highlight; color:HighlightText; }
.dupe button:disabled { color:GrayText; border-color:color-mix(in srgb, GrayText 40%, Canvas); cursor:default; }
.dupe .opts { display:flex; flex-wrap:wrap; gap:6px 18px; margin-top:5px; }
.dupe label { display:flex; align-items:center; gap:6px; cursor:pointer; }
.dupe label b { font-weight:400; font-size:10px; color:GrayText;
	background:color-mix(in srgb, GrayText 20%, Canvas); border-radius:7px; padding:0 5px; }
.near { display:flex; flex-wrap:wrap; gap:5px; align-items:center; margin:8px 0 2px; }
.near > span { color:GrayText; font-size:11px; margin-right:2px; }
.near i { font-style:normal; font-size:12px; border:1px solid GrayText; border-radius:9px;
	padding:1px 4px 1px 8px; cursor:pointer; display:inline-flex; gap:5px; align-items:center; }
.near i b { font-weight:400; font-size:10px; color:GrayText; background:color-mix(in srgb, GrayText 20%, Canvas);
	border-radius:7px; padding:0 5px; }
.near i:hover { background:Highlight; color:HighlightText; border-color:HighlightText; }
.near i:hover b { color:HighlightText; }
.near i.on { background:Highlight; color:HighlightText; border-color:HighlightText; }
.near i.on b { color:HighlightText; }
.near button.out { font:11px sans-serif; padding:1px 8px; border:1px solid GrayText;
	border-radius:9px; background:transparent; color:GrayText; cursor:pointer; }
.near button.out:hover { background:Highlight; color:HighlightText; border-color:HighlightText; }
.cols { flex:1; min-height:0; display:flex; }
.left { width:290px; display:flex; flex-direction:column; border-right:1px solid GrayText; }
.axis { display:flex; margin:8px 8px 0; border:1px solid GrayText; border-radius:5px; overflow:hidden; }
.axis button { flex:1; font:12px sans-serif; padding:3px 0; border:0;
	background:transparent; color:CanvasText; cursor:pointer; }
.axis button.on { background:Highlight; color:HighlightText; }
.axis button:not(.on):hover { background:color-mix(in srgb, Highlight 25%, Canvas); }
.nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.nm i.who { font-style:normal; color:GrayText; }
.tag.on .nm i.who { color:HighlightText; }
.book .nm { color:CanvasText; font-size:13px; font-weight:700; cursor:pointer; }
.book .nm:hover { text-decoration:underline; }
.rel { margin:10px 0 2px; }
.relh { display:flex; gap:6px; align-items:center; color:GrayText; font-size:11px;
	margin-bottom:2px; cursor:pointer; user-select:none; width:fit-content; }
.relh:hover { color:CanvasText; }
.relh .caret { font-size:9px; width:8px; }
.relh b { font-weight:400; font-size:10px; padding:0 5px; border-radius:7px;
	background:color-mix(in srgb, GrayText 20%, Canvas); }
.rel .row { display:flex; gap:8px; align-items:baseline; padding:2px 6px; border-radius:4px; cursor:pointer; }
.rel .row b { color:GrayText; font-size:11px; font-weight:400; white-space:nowrap; }
.rel .row:hover { background:Highlight; color:HighlightText; }
.rel .row:hover b, .rel .row:hover i.who { color:HighlightText; }
.hunt { display:flex; gap:6px; margin:8px; }
.hunt input { flex:1; min-width:0; padding:5px 8px; font:13px sans-serif; background:Canvas; color:CanvasText;
	border:1px solid GrayText; border-radius:5px; }
.hunt button { display:flex; align-items:center; padding:0 9px; border:1px solid GrayText;
	border-radius:5px; background:transparent; color:CanvasText; cursor:pointer; }
.hunt button:hover { background:Highlight; color:HighlightText; }
.tags { flex:1; overflow:auto; padding:0 4px 8px; }
.tag { display:flex; gap:8px; align-items:baseline; padding:3px 6px; border-radius:4px; cursor:pointer; }
.tag span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tag b { color:GrayText; font-size:11px; font-variant-numeric:tabular-nums; font-weight:400; }
.tag:hover { background:color-mix(in srgb, Highlight 25%, Canvas); }
.tag.on { background:Highlight; color:HighlightText; }
.tag.on b { color:HighlightText; }
.right { flex:1; overflow:auto; padding:12px 16px; }
.right h1 { font-size:15px; margin:0 0 2px; min-width:0; overflow-wrap:anywhere; }
.right .title { display:flex; align-items:baseline; gap:8px; }
.right .title button { font:11px sans-serif; padding:2px 8px; border:1px solid GrayText;
	border-radius:5px; background:transparent; color:CanvasText; cursor:pointer; white-space:nowrap; }
.right .title button:hover { background:Highlight; color:HighlightText; }
.right .title input { flex:1; min-width:0; font:15px sans-serif; font-weight:700; padding:2px 6px;
	background:Canvas; color:CanvasText; border:1px solid GrayText; border-radius:5px; }
.right .title .n { color:GrayText; font-size:11px; white-space:nowrap; }
.right .title .warn { flex:1; min-width:0; color:#c0392b; font-size:11px; }
@media (prefers-color-scheme: dark) { .right .title .warn { color:#ff8a7a; } }
.err { color:#c0392b; padding:6px 0; }
.right .sub { color:GrayText; font-size:11px; margin-bottom:14px; }
.right .find { display:flex; align-items:center; gap:8px; margin:4px 0 14px; }
.right .find input { flex:1; min-width:0; max-width:320px; font:12px sans-serif; padding:3px 7px;
	background:Canvas; color:CanvasText; border:1px solid GrayText; border-radius:5px; }
.right .find span { color:GrayText; font-size:11px; white-space:nowrap; }
.book { margin:18px 0 6px; padding-bottom:3px; border-bottom:1px solid GrayText;
	font-weight:700; display:flex; justify-content:space-between; gap:8px; }
.book .n { color:GrayText; font-weight:400; font-size:11px; white-space:nowrap; }
.hl { position:relative; border-left:4px solid var(--c); padding:5px 8px; margin:6px 0;
	border-radius:0 4px 4px 0; cursor:pointer; background:color-mix(in srgb, var(--c) 10%, Canvas); }
/* bottom right, and quiet: no border, no fill of its own — it inherits the
 * card's background so it can sit over the meta line without a box round it */
.hl .copy { position:absolute; bottom:2px; right:4px; opacity:0; font:10px sans-serif;
	line-height:1.7; padding:0 4px; border:0; border-radius:4px; background:inherit;
	color:GrayText; cursor:pointer; }
.hl:hover .copy { opacity:0.7; }
.hl .copy:hover, .hl .copy:focus { opacity:1; color:CanvasText; }
.hl:hover { background:color-mix(in srgb, var(--c) 22%, Canvas); }
.hl .t { white-space:pre-wrap; }
/* the UA default is a yellow block with black text, which is unreadable on a
 * dark card and fights the annotation's own colour */
mark { background:color-mix(in srgb, Highlight 50%, Canvas); color:inherit;
	border-radius:2px; padding:0 1px; }
.hl .c { white-space:pre-wrap; margin-top:5px; padding-left:8px; border-left:2px solid GrayText;
	color:CanvasText; }
.hl .m { margin-top:5px; color:GrayText; font-size:11px; display:flex; flex-wrap:wrap; gap:5px;
	align-items:center; padding-right:46px; }   /* room for the copy button */
.hl .m i { font-style:normal; border:1px solid GrayText; border-radius:9px; padding:0 6px; cursor:pointer; }
.hl .m i:hover { background:Highlight; color:HighlightText; }
.empty { color:GrayText; padding:30px 0; text-align:center; }
.more { display:block; margin:14px auto; font:12px sans-serif; padding:4px 12px;
	border:1px solid GrayText; border-radius:5px; background:transparent; color:CanvasText; cursor:pointer; }
`;

function el(doc, tag, cls, text) {
	const n = doc.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
}

// The tag names come from MARKUP's whitelist, so this cannot build anything but
// b/i/sub/sup — no innerHTML, nothing else gets through.
function markup(doc, str, words) {
	const frag = doc.createDocumentFragment();
	const put = (nodes, into) => {
		for (const n of nodes) {
			if (typeof n === "string") {
				for (const run of markRuns(n, words || [])) {
					into.append(typeof run === "string" ? run : el(doc, "mark", null, run.mark));
				}
				continue;
			}
			const box = doc.createElement(n.tag);
			put(n.kids, box);
			into.append(box);
		}
	};
	put(parseMarkup(str), frag);
	return frag;
}

// Same, as a fresh element.
function marked(doc, tag, cls, str, words) {
	const node = el(doc, tag, cls);
	node.append(markup(doc, str, words));
	return node;
}

// Drawn rather than typed: the die characters (U+2680..2685) are absent from
// plenty of system font stacks and come out as an empty box.
function dieIcon(doc) {
	const ns = "http://www.w3.org/2000/svg";
	const node = (tag, attrs) => {
		const n = doc.createElementNS(ns, tag);
		for (const k in attrs) n.setAttribute(k, String(attrs[k]));
		return n;
	};
	const icon = node("svg", { viewBox: "0 0 16 16", width: 13, height: 13, fill: "currentColor" });
	icon.append(node("rect", {
		x: 1.6, y: 1.6, width: 12.8, height: 12.8, rx: 3,
		fill: "none", stroke: "currentColor", "stroke-width": 1.4,
	}));
	for (const [cx, cy] of [[5.2, 5.2], [8, 8], [10.8, 10.8]]) {
		icon.append(node("circle", { cx, cy, r: 1.3 }));
	}
	return icon;
}

function open(collection) {
	const main = Zotero.getMainWindow();
	if (!main) return;
	if (collection) scope = collection.id;
	if (win && !win.closed) {
		win.focus();
		return safe(() => build(win));
	}
	// about:blank rather than a packaged XHTML: opened from a chrome window it
	// inherits chrome privileges, and the whole document is built here anyway.
	win = main.openDialog("about:blank", "tag-explorer", features(main));
	if (!win) return;
	win.addEventListener("unload", () => saveState(win));
	const go = () => safe(() => build(win));
	if (win.document.readyState === "complete") go();
	else win.addEventListener("load", go, { once: true });
}

// Every collection in every library, flattened depth-first and carrying the
// path that makes it searchable: "Philosophy / Frankfurt School".
function flatCollections() {
	const out = [];
	const libs = safe(() => Zotero.Libraries.getAll(), []);
	for (const lib of libs) {
		const walk = (c, prefix) => {
			const path = prefix ? prefix + " / " + c.name : c.name;
			out.push({ id: c.id, path });
			for (const kid of safe(() => c.getChildCollections(), [])) walk(kid, path);
		};
		// A library name only earns a place in the path when there are several.
		const root = libs.length > 1 ? lib.name : "";
		for (const c of safe(() => Zotero.Collections.getByLibrary(lib.libraryID), [])) walk(c, root);
	}
	return out;
}

function build(w) {
	const doc = w.document;
	doc.title = "Tag Explorer";
	doc.head.replaceChildren(el(doc, "style", null, CSS));
	doc.body.replaceChildren();
	const typing = (e) => /^(input|textarea)$/i.test(e.target.tagName || "");

	doc.addEventListener("keydown", (e) => {
		// Escape peels one layer at a time. Closing the window on the first
		// press threw away everything you had narrowed down.
		if (e.key === "Escape") {
			if (hlQuery) { hlQuery = ""; return renderRight(); }
			if (search.value) { search.value = ""; return renderLeft(); }
			return w.close();
		}
		if ((e.key === "/" && !typing(e)) || (e.key === "f" && (e.metaKey || e.ctrlKey))) {
			e.preventDefault();
			search.focus();
			return search.select();
		}
		if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
		e.preventDefault();
		step(e.key === "ArrowLeft" ? -1 : 1);
	});

	if (!entries.length && loading) {
		doc.body.append(el(doc, "div", "empty", "Reading your annotations…"));
		loading.then(() => { if (w && !w.closed) safe(() => build(w)); }).catch(oops);
		return;
	}
	rescope();

	// head: collection scope, totals, refresh
	const head = el(doc, "div", "head");
	const summary = () => `${counts.length} tags \u00B7 ${entries.filter(inScope).length} highlights`;
	const countLabel = el(doc, "span", "n", "");
	const refresh = el(doc, "button", null, "Refresh");
	refresh.addEventListener("click", () => {
		entries = [];
		loading = buildIndex().catch(oops).finally(() => { loading = null; });
		build(w);
	});

	// A plain <select> is unusable here: its dropdown is a native popup, and one
	// does not open inside a chrome about:blank window — the control just sits
	// there. This is the same search-and-list the tags get, in a box under an input.
	const colls = flatCollections();
	const collN = countByCollection(entries);
	if (scope !== null && !colls.some((c) => c.id === scope)) scope = null;   // collection went away

	// Wandering is the point, so getting back has to be free.
	const back = el(doc, "button", "step", "\u2190");
	const fwd = el(doc, "button", "step", "\u2192");
	back.title = "Back (Alt+\u2190)";
	fwd.title = "Forward (Alt+\u2192)";
	back.addEventListener("click", () => step(-1));
	fwd.addEventListener("click", () => step(1));

	const combo = el(doc, "div", "pick");
	const scopeBox = doc.createElement("input");
	scopeBox.type = "text";
	scopeBox.placeholder = "All collections";
	scopeBox.title = "Restrict everything to one collection";
	const drop = el(doc, "div", "drop");
	drop.hidden = true;
	combo.append(scopeBox, drop);
	head.append(back, fwd, combo, countLabel, refresh);

	const ALL = { id: null, path: "All collections" };
	let dropRows = [];
	let at = 0;

	const scopeLabel = () => (scope === null ? "" : (colls.find((c) => c.id === scope) || ALL).path);

	function paintDrop() {
		drop.replaceChildren();
		for (const [i, r] of dropRows.entries()) {
			const row = el(doc, "div", "row" + (i === at ? " on" : ""));
			row.append(el(doc, "span", null, r.path),
				el(doc, "b", null, String(r.id === null ? entries.length : collN.get(r.id) || 0)));
			// mousedown, not click: the input's blur would have hidden the list first.
			row.addEventListener("mousedown", (ev) => { ev.preventDefault(); setScope(r.id); scopeBox.blur(); });
			drop.append(row);
		}
		drop.hidden = !dropRows.length;
	}

	function showDrop() {
		dropRows = [ALL, ...matchColls(colls, scopeBox.value)].slice(0, 300);
		at = 0;
		paintDrop();
	}

	function setScope(id) {
		scope = id;
		scopeBox.value = scopeLabel();
		drop.hidden = true;
		rescope();
		countLabel.textContent = summary();
		push();
		renderLeft();
		renderRight();
	}

	// Focusing empties the box so typing starts a fresh search; leaving without
	// choosing puts the current collection back.
	scopeBox.addEventListener("focus", () => { scopeBox.value = ""; showDrop(); });
	scopeBox.addEventListener("input", showDrop);
	scopeBox.addEventListener("blur", () => { drop.hidden = true; scopeBox.value = scopeLabel(); });
	scopeBox.addEventListener("keydown", (ev) => {
		if (ev.key === "Escape") { ev.stopPropagation(); return scopeBox.blur(); }
		if (drop.hidden || !dropRows.length) return;
		if (ev.key === "Enter") { ev.preventDefault(); setScope(dropRows[at].id); return scopeBox.blur(); }
		if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
		ev.preventDefault();
		at = Math.max(0, Math.min(dropRows.length - 1, at + (ev.key === "ArrowDown" ? 1 : -1)));
		paintDrop();
		const on = drop.querySelector(".row.on");
		if (on) on.scrollIntoView({ block: "nearest" });
	});

	// left: search + tag list; right: the highlights
	const search = doc.createElement("input");
	search.type = "search";
	const listBox = el(doc, "div", "tags");
	const left = el(doc, "div", "left");

	// Two ways in. The panes keep their jobs — left picks, right reads — and
	// only the source of the list changes.
	const tabBtn = {};
	const tabs = el(doc, "div", "axis");
	for (const [id, label] of [["tags", "Tags"], ["books", "Books"]]) {
		const t = el(doc, "button", null, label);
		t.addEventListener("click", () => setAxis(id));
		tabBtn[id] = t;
		tabs.append(t);
	}
	// Two thirds of the tags in a well-used library have been used exactly once,
	// which puts them past the end of every sorted list. A die is the only thing
	// that ever surfaces them. It draws from what is listed, so a search and a
	// collection both narrow the roll.
	const die = el(doc, "button");
	die.append(dieIcon(doc));
	die.title = "Show a random tag from this list";
	die.addEventListener("click", () => {
		if (!visible.length) return;
		pickOne(visible[Math.floor(Math.random() * visible.length)]);
		const on = listBox.querySelector(".tag.on");
		if (on) on.scrollIntoView({ block: "nearest" });
	});
	const hunt = el(doc, "div", "hunt");
	hunt.append(search, die);
	left.append(tabs, hunt, listBox);
	const right = el(doc, "div", "right");
	const cols = el(doc, "div", "cols");
	cols.append(left, right);
	doc.body.append(head, cols);

	let visible = [];   // whatever the left list currently offers — tags or books
	let hlQuery = "";   // the filter over the highlights on the right
	let showDismissed = false;
	let trail = [];     // where you have been: { scope, axis, view, q }
	let hIndex = -1;

	const isTag = (t) => !!view && view.kind === "tag" && view.value === t;
	// The words to mark: the global search is its own filter, so both boxes feed
	// the same highlighting.
	const marks = () => {
		const q = view && view.kind === "find" ? view.value : hlQuery;
		return q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
	};
	// The tag currently doing the narrowing, whichever axis you are on.
	const activeTag = () => (!view ? null
		: view.kind === "tag" ? view.value
		: view.kind === "book" ? (view.tag || null) : null);
	const isBook = (b) => !!view && view.kind === "book" && view.value === b;

	// --- where you are, and how to get back ---------------------------------

	function paintNav() {
		back.disabled = hIndex <= 0;
		fwd.disabled = hIndex >= trail.length - 1;
	}

	const same = (a, b) => (!a && !b)
		|| (!!a && !!b && a.kind === b.kind && a.value === b.value
			&& (a.tag || null) === (b.tag || null));

	function push() {
		const now = { scope, axis, view, q: search.value };
		const last = trail[hIndex];
		if (last && last.scope === now.scope && last.axis === now.axis && same(last.view, now.view)) {
			return paintNav();
		}
		trail = trail.slice(0, hIndex + 1);
		trail.push(now);
		hIndex = trail.length - 1;
		paintNav();
	}

	function step(d) {
		const next = hIndex + d;
		if (next < 0 || next >= trail.length) return;
		hIndex = next;
		const was = trail[hIndex];
		scope = was.scope;
		axis = was.axis;
		view = was.view;
		search.value = was.q;
		hlQuery = "";
		scopeBox.value = scopeLabel();
		rescope();
		countLabel.textContent = summary();
		renderLeft();
		renderRight();
		paintNav();
	}

	// --- moving about --------------------------------------------------------

	function show(next) {
		view = next;
		hlQuery = "";
		push();
		renderLeft();
		renderRight();
		right.scrollTop = 0;
	}

	const pickTag = (tag) => show({ kind: "tag", value: tag });
	const pickBook = (book) => show({ kind: "book", value: book });
	const find = (query) => show({ kind: "find", value: query });
	const pickOne = (x) => (axis === "tags" ? pickTag(x.tag) : pickBook(x.book));

	// Arriving from somewhere else — a chip, a related book — means landing on
	// the other axis with a clean search box.
	function jumpToTag(tag) { axis = "tags"; search.value = ""; pickTag(tag); }

	// Within a book, picking a tag narrows this book rather than leaving it —
	// clicking the same one again widens back out.
	const narrow = (tag) =>
		show({ kind: "book", value: view.value, tag: view.tag === tag ? null : tag });
	const chipPick = (tag) => (view && view.kind === "book" ? narrow(tag) : jumpToTag(tag));
	function jumpToBook(book) { axis = "books"; search.value = ""; pickBook(book); }

	function setAxis(id) {
		if (axis === id) return;
		axis = id;
		search.value = "";
		push();
		renderLeft();
	}

	// --- the left pane -------------------------------------------------------

	function renderLeft() {
		for (const id of Object.keys(tabBtn)) tabBtn[id].className = axis === id ? "on" : "";
		search.placeholder = axis === "tags" ? "Search tags\u2026" : "Search books\u2026";
		listBox.replaceChildren();
		if (axis === "books") renderBookRows();
		else renderTagRows();
	}

	function overflow(shown, total) {
		if (total > shown) {
			listBox.append(el(doc, "div", "empty", `…and ${total - shown} more — keep typing`));
		}
	}

	function renderTagRows() {
		const q = search.value.trim();
		visible = matchTags(counts, search.value);
		// A browsing affordance, so it stays out of the way once you are typing.
		if (!q && (dupes.length || nears.length)) {
			const row = el(doc, "div", "tag dup" + (view && view.kind === "dupes" ? " on" : ""));
			row.append(el(doc, "span", null, "possible duplicates"),
				el(doc, "b", null, String(dupes.length + nears.length)));
			row.addEventListener("click", () => show({ kind: "dupes" }));
			listBox.append(row);
		}
		// Pinned above the matches, and deliberately not one of them: the tag
		// vocabulary is not the only way in, and when most tags have been used
		// once it is often not the way at all.
		if (q) {
			const row = el(doc, "div", "tag all"
				+ (view && view.kind === "find" && view.value === q ? " on" : ""));
			row.append(el(doc, "span", null, `Search every highlight for \u201C${q}\u201D`));
			row.addEventListener("click", () => find(q));
			listBox.append(row);
		}
		if (!visible.length) {
			listBox.append(el(doc, "div", "empty", counts.length ? "No tags match." : "No tagged highlights here."));
			return;
		}
		for (const c of visible.slice(0, TAG_CAP)) {
			const row = el(doc, "div", "tag" + (isTag(c.tag) ? " on" : ""));
			row.append(el(doc, "span", null, c.tag), el(doc, "b", null, String(c.n)));
			row.addEventListener("click", () => pickTag(c.tag));
			listBox.append(row);
		}
		overflow(TAG_CAP, visible.length);
	}

	function renderBookRows() {
		const all = bookList(entries.filter(inScope));
		visible = matchBooks(all, search.value);
		if (!visible.length) {
			listBox.append(el(doc, "div", "empty", all.length ? "No books match." : "Nothing here."));
			return;
		}
		for (const b of visible.slice(0, TAG_CAP)) {
			const row = el(doc, "div", "tag" + (isBook(b.book) ? " on" : ""));
			row.append(bookName(b), el(doc, "b", null, String(b.n)));
			row.addEventListener("click", () => pickBook(b.book));
			listBox.append(row);
		}
		overflow(TAG_CAP, visible.length);
	}

	// Author first, then the title — the way a shelf reads.
	function bookName(b) {
		const name = el(doc, "span", "nm");
		if (b.creator) name.append(el(doc, "i", "who", b.creator + " "));
		name.append(markup(doc, b.title, marks()));
		return name;
	}

	// --- the right pane ------------------------------------------------------

	// One grouped-or-flat, capped list of cards, repaintable in place so that
	// typing in a filter never rebuilds the box you are typing into.
	function listOf(rows, flat) {
		let cap = HL_CAP;
		const list = el(doc, "div");
		const paint = () => {
			list.replaceChildren();
			if (!rows.length) {
				list.append(el(doc, "div", "empty", "Nothing matches."));
				return;
			}
			if (flat) {
				// One book already: its own name over every card would be noise.
				const ordered = rows.slice().sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
				for (const e of ordered.slice(0, cap)) list.append(card(e));
			} else {
				let room = cap;
				for (const book of groupByBook(rows)) {
					if (room <= 0) break;
					const head = el(doc, "div", "book");
					const name = bookName(book);
					name.title = "Show this book";
					name.addEventListener("click", () => jumpToBook(book.book));
					head.append(name, el(doc, "span", "n", `${book.rows.length}`));
					list.append(head);
					for (const e of book.rows.slice(0, room)) list.append(card(e));
					room -= book.rows.length;
				}
			}
			if (rows.length > cap) {
				const more = el(doc, "button", "more", `Show all ${rows.length}`);
				more.addEventListener("click", () => { cap = rows.length; paint(); });
				list.append(more);
			}
		};
		paint();
		return { list, show: (next) => { rows = next; cap = HL_CAP; paint(); } };
	}

	// The filter box and the list it drives, shared by the tag and book views.
	function filtered(rows, flat) {
		const bar = el(doc, "div", "find");
		const box = doc.createElement("input");
		box.type = "text";
		box.placeholder = "Filter these highlights\u2026";
		box.value = hlQuery;
		const count = el(doc, "span");
		bar.append(box, count);

		const list = listOf(matchText(rows, hlQuery), flat);
		const sync = () => {
			const shown = matchText(rows, hlQuery);
			count.textContent = (hlQuery ? `${shown.length} of ${rows.length}` : String(rows.length))
				+ ` highlight${rows.length === 1 ? "" : "s"}` + (scope ? " in this collection" : "");
			list.show(shown);
		};
		sync();

		box.addEventListener("input", () => { hlQuery = box.value; sync(); });
		box.addEventListener("keydown", (ev) => {
			if (ev.key !== "Escape" || !box.value) return;   // empty: let the layering take over
			ev.stopPropagation();
			ev.preventDefault();
			box.value = "";
			hlQuery = "";
			sync();
		});
		return [bar, list.list];
	}

	// A row of clickable tag chips with their counts.
	function chips(label, items, onPick, extra) {
		const strip = el(doc, "div", "near");
		strip.append(el(doc, "span", null, label));
		for (const it of items) {
			const chip = el(doc, "i", activeTag() === it.tag ? "on" : null, it.tag);
			chip.append(el(doc, "b", null, String(it.n)));
			chip.addEventListener("click", () => onPick(it.tag));
			strip.append(chip);
		}
		if (extra) strip.append(el(doc, "span", null, extra));
		return strip;
	}

	function renderRight() {
		right.replaceChildren();
		if (!view) {
			right.append(el(doc, "div", "empty", "Pick a tag or a book."));
			return;
		}
		if (view.kind === "dupes") return renderDupes();
		if (view.kind === "find") return renderFound();
		if (view.kind === "book") return renderBook();
		return renderTag();
	}

	function renderTag() {
		const scoped = entries.filter(inScope);
		const rows = scoped.filter((e) => e.tags.includes(view.value));

		const title = el(doc, "div", "title");
		const rename = el(doc, "button", null, "Rename");
		rename.title = "Rename this tag everywhere it is used";
		rename.addEventListener("click", () => startRename(title));
		title.append(el(doc, "h1", null, view.value), rename);
		right.append(title);

		const near = neighbours(scoped, view.value);
		if (near.length) right.append(chips("appears with", near, jumpToTag));

		right.append(...filtered(rows, false));
	}

	function renderBook() {
		const scoped = entries.filter(inScope);
		const rows = scoped.filter((e) => e.book === view.value);
		if (!rows.length) {
			right.append(el(doc, "div", "empty", "Nothing from this book here."));
			return;
		}
		const b = rows[0];

		const title = el(doc, "div", "title");
		title.append(marked(doc, "h1", null, b.title));
		right.append(title);
		if (b.creator) right.append(el(doc, "div", "sub", b.creator));

		const picked = view.tag || null;
		const mine = tagCounts(rows);
		if (mine.length) {
			const strip = chips("tagged", mine.slice(0, BOOK_TAGS), narrow,
				mine.length > BOOK_TAGS ? `+${mine.length - BOOK_TAGS} more` : null);
			// Narrowing keeps you in the book, so offer the door out explicitly
			// rather than making every chip click take it.
			if (picked) {
				const out = el(doc, "button", "out", `see \u201C${picked}\u201D across all books`);
				out.addEventListener("click", () => jumpToTag(picked));
				strip.append(out);
			}
			right.append(strip);
		}

		// Folded by default: the reading pane is for reading, and eight titles
		// between you and the first highlight is a wall. The count keeps it
		// advertised, and the fold stays as you left it from book to book.
		const rel = related(scoped, view.value);
		if (rel.length) {
			const box = el(doc, "div", "rel");
			const caret = el(doc, "span", "caret", relOpen ? "\u25BE" : "\u25B8");
			const head = el(doc, "div", "relh");
			head.append(caret, el(doc, "span", null, "related books"),
				el(doc, "b", null, String(rel.length)));
			const rows = el(doc, "div");
			rows.hidden = !relOpen;
			head.addEventListener("click", () => {
				relOpen = !relOpen;
				rows.hidden = !relOpen;
				caret.textContent = relOpen ? "\u25BE" : "\u25B8";
			});
			box.append(head, rows);
			for (const r of rel) {
				const row = el(doc, "div", "row");
				row.title = "Show this book";
				row.append(bookName(r), el(doc, "b", null,
					`${r.shared} shared tag${r.shared === 1 ? "" : "s"}`));
				row.addEventListener("click", () => jumpToBook(r.book));
				rows.append(row);
			}
			right.append(box);
		}

		right.append(...filtered(picked ? rows.filter((e) => e.tags.includes(picked)) : rows, true));
	}

	// Every highlight, not just one tag's. The cards carry their tags, so a hit
	// is also a way into the tag that would have found it.
	function renderFound() {
		const rows = matchText(entries.filter(inScope), view.value);
		const title = el(doc, "div", "title");
		title.append(el(doc, "h1", null, `\u201C${view.value}\u201D`));
		right.append(title);
		right.append(el(doc, "div", "sub",
			`${rows.length} highlight${rows.length === 1 ? "" : "s"} anywhere in your library`
			+ (scope ? ", in this collection" : "")));
		right.append(listOf(rows, false).list);
	}

	function renderDupes() {
		const title = el(doc, "div", "title");
		title.append(el(doc, "h1", null, "Possible duplicates"));
		right.append(title);
		const merges = dupes.reduce((k, c) => k + c.tags.length - 1, 0);
		right.append(el(doc, "div", "sub", dupes.length || nears.length
			? `${dupes.length} cluster${dupes.length === 1 ? "" : "s"} \u00B7 ${merges} merge${merges === 1 ? "" : "s"}`
				+ ` \u00B7 from ${libTags.length} tags across the whole library`
			: `nothing left to merge among ${libTags.length} tags`));

		if (dupes.length) {
			right.append(section("Same tag, spelled differently", "safe to merge"));
			for (const c of dupes) right.append(dupeBlock(c, false));
		}
		if (nears.length) {
			right.append(section("Near misses",
				"check before merging \u2014 some of these are meant to differ"));
			for (const c of nears) right.append(dupeBlock(c, true));
		}
		if (dismissed.length) {
			// Dismissing has to be undoable, or it is a door that only shuts.
			const foot = section(`${dismissed.length} marked not duplicates`, "");
			const toggle = el(doc, "button", null, showDismissed ? "hide" : "show");
			toggle.addEventListener("click", () => { showDismissed = !showDismissed; renderRight(); });
			foot.append(toggle);
			right.append(foot);
			if (showDismissed) for (const names of dismissed) right.append(dismissedBlock(names));
		}
	}

	function dismissedBlock(names) {
		const box = el(doc, "div", "dupe maybe");
		const undo = el(doc, "button", null, "Suggest again");
		undo.addEventListener("click", () => {
			const key = clusterKey(names);
			dismissed = dismissed.filter((d) => clusterKey(d) !== key);
			saveDismissed();
			rescope();
			renderLeft();
			renderRight();
		});
		const top = el(doc, "div", "top");
		top.append(el(doc, "span", "why", "not duplicates"), undo);
		const opts = el(doc, "div", "opts");
		for (const n of names) opts.append(el(doc, "label", null, n));
		box.append(top, opts);
		return box;
	}

	function section(head, note) {
		const box = el(doc, "div", "sect");
		box.append(el(doc, "h2", null, head), el(doc, "span", null, note));
		return box;
	}

	let groupN = 0;

	// One cluster: which spelling survives, and the button that does it. The
	// safe ones arrive with the most-used spelling chosen; the near misses
	// arrive with nothing chosen, so the merge cannot happen by reflex.
	function dupeBlock(c, maybe) {
		const box = el(doc, "div", "dupe" + (maybe ? " maybe" : ""));
		const go = el(doc, "button", null, maybe ? "Merge\u2026" : "Merge");
		let keep = maybe ? null : c.tags[0].tag;
		go.disabled = !keep;
		go.addEventListener("click", () => keep && mergeCluster(c, keep, box));

		const no = el(doc, "button", null, "Not duplicates");
		no.title = "Never suggest these again";
		no.addEventListener("click", () => {
			dismissed.push(namesOf(c));
			saveDismissed();
			rescope();
			renderLeft();
			renderRight();
		});

		const top = el(doc, "div", "top");
		top.append(el(doc, "span", "why",
			(maybe ? "worth a look \u2014 " : "") + "differ by " + c.why), no, go);
		box.append(top);

		const opts = el(doc, "div", "opts");
		const group = "dupe" + (groupN++);
		for (const [i, t] of c.tags.entries()) {
			const lab = el(doc, "label");
			const radio = doc.createElement("input");
			radio.type = "radio";
			radio.name = group;
			radio.checked = !maybe && i === 0;
			radio.addEventListener("change", () => { keep = t.tag; go.disabled = false; });
			lab.append(radio, el(doc, "span", null, t.tag), el(doc, "b", null, String(t.n)));
			opts.append(lab);
		}
		box.append(opts);
		return box;
	}

	// Every other spelling renamed onto the survivor. No merge warning here —
	// absorbing them is the whole point, and the counts are on screen.
	async function mergeCluster(c, keep, box) {
		for (const t of c.tags) {
			if (t.tag === keep) continue;
			const known = libTags.find((x) => x.tag === t.tag);
			const libs = known ? known.libs : new Set();
			try {
				for (const lib of libs) await Zotero.Tags.rename(lib, t.tag, keep);
			} catch (e) {
				oops(e);
				return box.append(el(doc, "div", "err", `Could not merge: ${e.message}`));
			}
			renameInList(entries, t.tag, keep, libs);
		}
		await loadLibraryTags();
		rescope();
		countLabel.textContent = summary();
		renderLeft();
		renderRight();
	}

	function startRename(title) {
		const tag = view.value;
		const box = doc.createElement("input");
		box.type = "text";
		box.value = tag;
		let done = false;
		const cancel = () => { if (!done) { done = true; renderRight(); } };
		box.addEventListener("blur", cancel);
		box.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") { ev.stopPropagation(); ev.preventDefault(); return cancel(); }
			if (ev.key !== "Enter") return;
			ev.preventDefault();
			done = true;
			doRename(tag, box.value.trim());
		});
		title.replaceChildren(box, el(doc, "span", "n",
			"Enter renames it everywhere in the library \u00B7 Esc cancels"));
		box.focus();
		box.select();
	}

	// How many items already carry `name` in the libraries this rename touches.
	// The tags table is library-wide and a name can sit in it unused, so the
	// count comes from what is actually tagged, not from the name existing.
	async function countTagged(name, libs) {
		try {
			const id = Zotero.Tags.getID(name);
			if (!id) return 0;
			let n = 0;
			for (const lib of libs) n += (await Zotero.Tags.getTagItems(lib, id)).length;
			return n;
		} catch (e) {
			oops(e);
			// Fail towards warning: our own index still knows the highlights.
			return entries.filter((x) => x.tags.includes(name)).length;
		}
	}

	// Renaming onto a name that is already in use is a merge, and Zotero does it
	// without asking. Say so first, and make it a separate, deliberate click.
	function warnMerge(tag, next, n) {
		const title = right.querySelector(".title");
		if (!title) return;
		const merge = el(doc, "button", null, "Merge");
		merge.addEventListener("click", () => doRename(tag, next, true));
		const cancel = el(doc, "button", null, "Cancel");
		cancel.addEventListener("click", () => renderRight());
		title.replaceChildren(
			el(doc, "h1", null, next),
			el(doc, "span", "warn",
				`already exists on ${n} item${n === 1 ? "" : "s"}. `
				+ `Renaming \u201C${tag}\u201D to it merges the two everywhere in the library, `
				+ `and cannot be undone.`),
			merge, cancel);
		title.addEventListener("keydown", (ev) => {
			if (ev.key !== "Escape") return;
			ev.stopPropagation();          // or the document handler closes the window
			ev.preventDefault();
			renderRight();
		});
		merge.focus();
	}

	// Zotero's own rename: every item in the library that carries the tag moves,
	// the tag's colour follows it, and the change syncs. Which means it is not
	// limited to annotations, or to the collection currently in scope.
	async function doRename(tag, next, merging) {
		if (!next || next === tag) return renderRight();
		const libs = new Set(entries.filter((e) => e.tags.includes(tag)).map((e) => e.libraryID));
		if (!merging) {
			const n = await countTagged(next, libs);
			if (n) return warnMerge(tag, next, n);
		}
		try {
			for (const lib of libs) await Zotero.Tags.rename(lib, tag, next);
		} catch (e) {
			oops(e);
			renderRight();
			return right.prepend(el(doc, "div", "err", `Could not rename: ${e.message}`));
		}
		renameInList(entries, tag, next, libs);
		view = { kind: "tag", value: next };
		for (const t of trail) if (t.view && t.view.kind === "tag" && t.view.value === tag) t.view = view;
		rescope();
		countLabel.textContent = summary();
		renderLeft();
		renderRight();
	}

	function card(e) {
		const box = el(doc, "div", "hl");
		box.style.setProperty("--c", e.color);
		box.title = "Open in the reader";
		if (e.text) box.append(marked(doc, "div", "t", e.text, marks()));
		else box.append(el(doc, "div", "t", `[${e.type}]`));
		if (e.comment) box.append(marked(doc, "div", "c", e.comment, marks()));

		const meta = el(doc, "div", "m");
		if (e.page) meta.append(el(doc, "span", null, "p. " + e.page));
		for (const t of e.tags) {
			if (t === activeTag()) continue;
			const chip = el(doc, "i", null, t);
			chip.title = view && view.kind === "book" ? "Show only this tag in this book" : "Show this tag";
			chip.addEventListener("click", (ev) => { ev.stopPropagation(); chipPick(t); });
			meta.append(chip);
		}
		if (meta.childNodes.length) box.append(meta);

		const copy = el(doc, "button", "copy", "Copy");
		copy.title = "Copy the quote, where it is from, and your comment";
		copy.addEventListener("click", (ev) => {
			ev.stopPropagation();                 // not a request to open the reader
			safe(() => Zotero.Utilities.Internal.copyTextToClipboard(asText(e)));
			copy.textContent = "Copied";
			w.setTimeout(() => { copy.textContent = "Copy"; }, 1200);
		});
		box.append(copy);
		box.addEventListener("click", () => safe(() => {
			const main = Zotero.getMainWindow();
			const item = Zotero.Items.get(e.id);
			if (!main || !item) return;
			main.focus();
			main.ZoteroPane.viewItems([item]);   // opens the reader on the annotation
		}));
		return box;
	}

	search.addEventListener("input", renderLeft);
	search.addEventListener("keydown", (ev) => {
		if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Enter") return;
		if (!visible.length) return;
		ev.preventDefault();
		const cur = visible.findIndex((x) => (axis === "tags" ? isTag(x.tag) : isBook(x.book)));
		if (ev.key === "Enter") return pickOne(visible[cur < 0 ? 0 : cur]);
		const next = Math.max(0, Math.min(visible.length - 1, cur + (ev.key === "ArrowDown" ? 1 : -1)));
		pickOne(visible[next]);
		const on = listBox.querySelector(".tag.on");
		if (on) on.scrollIntoView({ block: "nearest" });
	});

	setScope(scope);
	search.focus();
}

// --- plugin lifecycle ------------------------------------------------------

// Not async, and nothing here waits on I/O: Zotero awaits every plugin's
// startup() in sequence inside its own init, so anything slow here delays the
// launch. The index is built the first time the window is opened.
function startup({ id }) {
	loadDismissed();
	loadState();
	menuID = Zotero.MenuManager.registerMenu({
		menuID: "tag-explorer",
		pluginID: id,
		target: "main/menubar/tools",
		menus: [{ menuType: "menuitem", l10nID: "tag-explorer-menu", onCommand: () => openWith(null) }],
	});
	collectionMenuID = Zotero.MenuManager.registerMenu({
		menuID: "tag-explorer-collection",
		pluginID: id,
		target: "main/library/collection",
		menus: [{
			menuType: "menuitem",
			l10nID: "tag-explorer-collection-menu",
			// The row you right-clicked comes in the menu's context.
			// ZoteroPane.getSelectedCollection() is gone in Zotero 10 — it throws.
			onCommand: (ev, ctx) => safe(() => {
				const row = ((ctx && ctx.collectionTreeRows) || [])[0];
				openWith(row && row.isCollection() ? row.ref : null);
			}),
		}],
	});
	for (const w of Zotero.getMainWindows()) onMainWindowLoad({ window: w });
}

function openWith(collection) {
	if (!entries.length && !loading) {
		loading = buildIndex().catch(oops).finally(() => { loading = null; });
	}
	open(collection);
}

function onMainWindowLoad({ window }) {
	window.MozXULElement.insertFTLIfNeeded("tag-explorer.ftl");
}

function onMainWindowUnload() {}

function shutdown() {
	if (menuID) Zotero.MenuManager.unregisterMenu(menuID);
	if (collectionMenuID) Zotero.MenuManager.unregisterMenu(collectionMenuID);
	menuID = collectionMenuID = null;
	if (win && !win.closed) { safe(() => saveState(win)); win.close(); }
	win = null;
	entries = [];
	counts = [];
	loading = null;
}

function install() {}
function uninstall() {}

// node-only: lets test.js import the pure helpers; no-op inside Zotero.
if (typeof module !== "undefined") {
	module.exports = { fuzzy, rank, tagCounts, matchTags, matchColls, countByCollection, renameInList, parseMarkup, markRuns, matchText, neighbours, matchBooks, bookList, related, dupeClusters, nearMisses, clusterKey, withoutDismissed, plain, asText, groupByBook };
}
