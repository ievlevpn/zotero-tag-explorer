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

const TAG_CAP = 400;      // tag rows rendered per search — the rest are a count
const HL_CAP = 200;       // highlights rendered per tag before "show all"

let menuID = null;
let collectionMenuID = null;

let entries = [];         // every tagged annotation — see buildIndex()
let counts = [];          // [{ tag, n }] for the current scope, best first
let loading = null;       // the in-flight buildIndex(), or null
let win = null;           // the one explorer window
let scope = null;         // collection id the view is restricted to, or null
let selected = null;      // the tag whose highlights are shown
let finding = null;       // a search over every highlight, instead of a tag

const oops = (e) => Zotero.logError(e);

function safe(fn, fallback) {
	try { return fn(); } catch (e) { oops(e); return fallback; }
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
		const hay = (r.text + " " + r.comment + " " + r.title).toLowerCase();
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

// Highlights read as a book at a time: same title together, in reading order.
function groupByTitle(list) {
	const out = [];
	for (const e of list.slice().sort((a, b) =>
		a.title.localeCompare(b.title) || String(a.sort).localeCompare(String(b.sort)))) {
		if (!out.length || out[out.length - 1].title !== e.title) out.push({ title: e.title, rows: [] });
		out[out.length - 1].rows.push(e);
	}
	return out;
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
			title: safe(() => top.getDisplayTitle(), "") || "(untitled)",
			colls: collsOf.get(top.id),
		});
	}
	entries = out;
}

const inScope = (e) => !scope || e.colls.has(scope);

function rescope() {
	counts = tagCounts(entries.filter(inScope));
	if (selected && !counts.some((c) => c.tag === selected)) selected = null;
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
.tag.all { color:GrayText; font-style:italic; }
.tag.all.on { color:HighlightText; }
.near { display:flex; flex-wrap:wrap; gap:5px; align-items:center; margin:8px 0 2px; }
.near > span { color:GrayText; font-size:11px; margin-right:2px; }
.near i { font-style:normal; font-size:12px; border:1px solid GrayText; border-radius:9px;
	padding:1px 4px 1px 8px; cursor:pointer; display:inline-flex; gap:5px; align-items:center; }
.near i b { font-weight:400; font-size:10px; color:GrayText; background:color-mix(in srgb, GrayText 20%, Canvas);
	border-radius:7px; padding:0 5px; }
.near i:hover { background:Highlight; color:HighlightText; border-color:HighlightText; }
.near i:hover b { color:HighlightText; }
.cols { flex:1; min-height:0; display:flex; }
.left { width:290px; display:flex; flex-direction:column; border-right:1px solid GrayText; }
.left input { margin:8px; padding:5px 8px; font:13px sans-serif; background:Canvas; color:CanvasText;
	border:1px solid GrayText; border-radius:5px; }
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
.err { color:#c0392b; padding:6px 0; }
.right .sub { color:GrayText; font-size:11px; margin-bottom:14px; }
.right .find { display:flex; align-items:center; gap:8px; margin:4px 0 14px; }
.right .find input { flex:1; min-width:0; max-width:320px; font:12px sans-serif; padding:3px 7px;
	background:Canvas; color:CanvasText; border:1px solid GrayText; border-radius:5px; }
.right .find span { color:GrayText; font-size:11px; white-space:nowrap; }
.book { margin:18px 0 6px; padding-bottom:3px; border-bottom:1px solid GrayText;
	font-weight:700; display:flex; justify-content:space-between; gap:8px; }
.book span { color:GrayText; font-weight:400; font-size:11px; white-space:nowrap; }
.hl { border-left:4px solid var(--c); padding:5px 8px; margin:6px 0; border-radius:0 4px 4px 0;
	cursor:pointer; background:color-mix(in srgb, var(--c) 10%, Canvas); }
.hl:hover { background:color-mix(in srgb, var(--c) 22%, Canvas); }
.hl .t { white-space:pre-wrap; }
.hl .c { white-space:pre-wrap; margin-top:5px; padding-left:8px; border-left:2px solid GrayText;
	color:CanvasText; }
.hl .m { margin-top:5px; color:GrayText; font-size:11px; display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
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
function markup(doc, str) {
	const frag = doc.createDocumentFragment();
	const put = (nodes, into) => {
		for (const n of nodes) {
			if (typeof n === "string") { into.append(n); continue; }
			const box = doc.createElement(n.tag);
			put(n.kids, box);
			into.append(box);
		}
	};
	put(parseMarkup(str), frag);
	return frag;
}

// Same, as a fresh element.
function marked(doc, tag, cls, str) {
	const node = el(doc, tag, cls);
	node.append(markup(doc, str));
	return node;
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
	win = main.openDialog("about:blank", "tag-explorer",
		"chrome,centerscreen,resizable,scrollbars,width=1000,height=740");
	if (!win) return;
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
	doc.addEventListener("keydown", (e) => {
		if (e.key === "Escape") return w.close();
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
		renderTags();
		renderHighlights();
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
	search.placeholder = "Search tags…";
	const tags = el(doc, "div", "tags");
	const left = el(doc, "div", "left");
	left.append(search, tags);
	const right = el(doc, "div", "right");
	const cols = el(doc, "div", "cols");
	cols.append(left, right);
	doc.body.append(head, cols);

	let visible = [];   // the tags currently listed, in order — for the arrow keys
	let hlQuery = "";   // the filter over the selected tag's highlights
	let trail = [];     // where you have been: { scope, selected, finding, q }
	let hIndex = -1;

	// --- where you are, and how to get back ---------------------------------

	function paintNav() {
		back.disabled = hIndex <= 0;
		fwd.disabled = hIndex >= trail.length - 1;
	}

	function push() {
		const now = { scope, selected, finding, q: search.value };
		const last = trail[hIndex];
		if (last && last.scope === now.scope && last.selected === now.selected
			&& last.finding === now.finding) return paintNav();
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
		selected = was.selected;
		finding = was.finding;
		search.value = was.q;
		hlQuery = "";
		scopeBox.value = scopeLabel();
		rescope();
		countLabel.textContent = summary();
		renderTags();
		renderHighlights();
		paintNav();
	}

	function pick(tag) {
		selected = tag;
		finding = null;
		hlQuery = "";
		push();
		renderTags();
		renderHighlights();
		right.scrollTop = 0;
	}

	function find(query) {
		finding = query;
		selected = null;
		hlQuery = "";
		push();
		renderTags();
		renderHighlights();
		right.scrollTop = 0;
	}

	// --- the tag list --------------------------------------------------------

	function renderTags() {
		const q = search.value.trim();
		visible = matchTags(counts, search.value);
		tags.replaceChildren();
		// Pinned above the matches, and deliberately not part of them: the tag
		// vocabulary is not the only way in, and when most tags have been used
		// once it is often not the way at all.
		if (q) {
			const row = el(doc, "div", "tag all" + (finding === q ? " on" : ""));
			row.append(el(doc, "span", null, `Search every highlight for \u201C${q}\u201D`));
			row.addEventListener("click", () => find(q));
			tags.append(row);
		}
		if (!visible.length) {
			tags.append(el(doc, "div", "empty", counts.length ? "No tags match." : "No tagged highlights here."));
			return;
		}
		for (const c of visible.slice(0, TAG_CAP)) {
			const row = el(doc, "div", "tag" + (c.tag === selected ? " on" : ""));
			row.append(el(doc, "span", null, c.tag), el(doc, "b", null, String(c.n)));
			row.addEventListener("click", () => pick(c.tag));
			tags.append(row);
		}
		if (visible.length > TAG_CAP) {
			tags.append(el(doc, "div", "empty", `…and ${visible.length - TAG_CAP} more — keep typing`));
		}
	}

	// --- the highlights ------------------------------------------------------

	// One grouped, capped list of cards, repaintable in place so that typing in
	// a filter never rebuilds the box you are typing into.
	function listOf(rows) {
		let cap = HL_CAP;
		const list = el(doc, "div");
		const paint = () => {
			list.replaceChildren();
			if (!rows.length) {
				list.append(el(doc, "div", "empty", "Nothing matches."));
				return;
			}
			let room = cap;
			for (const book of groupByTitle(rows)) {
				if (room <= 0) break;
				const head = el(doc, "div", "book");
				head.append(marked(doc, "b", null, book.title),
					el(doc, "span", null, `${book.rows.length}`));
				list.append(head);
				for (const e of book.rows.slice(0, room)) list.append(card(e));
				room -= book.rows.length;
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

	function renderHighlights() {
		right.replaceChildren();
		if (finding) return renderFound();
		if (!selected) {
			right.append(el(doc, "div", "empty", "Pick a tag, or search every highlight."));
			return;
		}
		const scoped = entries.filter(inScope);
		const rows = scoped.filter((e) => e.tags.includes(selected));

		const title = el(doc, "div", "title");
		const rename = el(doc, "button", null, "Rename");
		rename.title = "Rename this tag everywhere it is used";
		rename.addEventListener("click", () => startRename(title));
		title.append(el(doc, "h1", null, selected), rename);
		right.append(title);

		const near = neighbours(scoped, selected);
		if (near.length) {
			const strip = el(doc, "div", "near");
			strip.append(el(doc, "span", null, "appears with"));
			for (const n of near) {
				const chip = el(doc, "i", null, n.tag);
				chip.append(el(doc, "b", null, String(n.n)));
				chip.title = `${n.n} highlight${n.n === 1 ? "" : "s"} carry both`;
				chip.addEventListener("click", () => { search.value = ""; pick(n.tag); });
				strip.append(chip);
			}
			right.append(strip);
		}

		const bar = el(doc, "div", "find");
		const filter = doc.createElement("input");
		filter.type = "text";
		filter.placeholder = "Filter these highlights\u2026";
		filter.value = hlQuery;
		const count = el(doc, "span");
		bar.append(filter, count);
		right.append(bar);

		const view = listOf(matchText(rows, hlQuery));
		right.append(view.list);

		const sync = () => {
			const shown = matchText(rows, hlQuery);
			count.textContent = (hlQuery ? `${shown.length} of ${rows.length}` : String(rows.length))
				+ ` highlight${rows.length === 1 ? "" : "s"}` + (scope ? " in this collection" : "");
			view.show(shown);
		};
		sync();

		filter.addEventListener("input", () => { hlQuery = filter.value; sync(); });
		filter.addEventListener("keydown", (ev) => {
			if (ev.key !== "Escape") return;
			ev.stopPropagation();          // or the document handler closes the window
			ev.preventDefault();
			if (!filter.value) return filter.blur();
			filter.value = "";
			hlQuery = "";
			sync();
		});
	}

	// Every highlight, not just one tag's. The cards carry their tags, so a hit
	// is also a way into the tag that would have found it.
	function renderFound() {
		const rows = matchText(entries.filter(inScope), finding);
		const title = el(doc, "div", "title");
		title.append(el(doc, "h1", null, `\u201C${finding}\u201D`));
		right.append(title);
		right.append(el(doc, "div", "sub",
			`${rows.length} highlight${rows.length === 1 ? "" : "s"} anywhere in your library`
			+ (scope ? ", in this collection" : "")));
		right.append(listOf(rows).list);
	}

	function startRename(title) {
		const tag = selected;
		const box = doc.createElement("input");
		box.type = "text";
		box.value = tag;
		let done = false;
		const cancel = () => { if (!done) { done = true; renderHighlights(); } };
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

	// Zotero's own rename: every item in the library that carries the tag moves,
	// the tag's colour follows it, and the change syncs. Which means it is not
	// limited to annotations, or to the collection currently in scope.
	async function doRename(tag, next) {
		if (!next || next === tag) return renderHighlights();
		const libs = new Set(entries.filter((e) => e.tags.includes(tag)).map((e) => e.libraryID));
		try {
			for (const lib of libs) await Zotero.Tags.rename(lib, tag, next);
		} catch (e) {
			oops(e);
			renderHighlights();
			return right.prepend(el(doc, "div", "err", `Could not rename: ${e.message}`));
		}
		renameInList(entries, tag, next, libs);
		selected = next;
		for (const t of trail) if (t.selected === tag) t.selected = next;
		rescope();
		countLabel.textContent = summary();
		renderTags();
		renderHighlights();
	}

	function card(e) {
		const box = el(doc, "div", "hl");
		box.style.setProperty("--c", e.color);
		box.title = "Open in the reader";
		if (e.text) box.append(marked(doc, "div", "t", e.text));
		else box.append(el(doc, "div", "t", `[${e.type}]`));
		if (e.comment) box.append(marked(doc, "div", "c", e.comment));

		const meta = el(doc, "div", "m");
		if (e.page) meta.append(el(doc, "span", null, "p. " + e.page));
		for (const t of e.tags) {
			if (t === selected) continue;
			const chip = el(doc, "i", null, t);
			chip.title = "Show this tag";
			chip.addEventListener("click", (ev) => {
				ev.stopPropagation();
				search.value = "";
				pick(t);
			});
			meta.append(chip);
		}
		if (meta.childNodes.length) box.append(meta);
		box.addEventListener("click", () => safe(() => {
			const main = Zotero.getMainWindow();
			const item = Zotero.Items.get(e.id);
			if (!main || !item) return;
			main.focus();
			main.ZoteroPane.viewItems([item]);   // opens the reader on the annotation
		}));
		return box;
	}

	search.addEventListener("input", renderTags);
	search.addEventListener("keydown", (ev) => {
		if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Enter") return;
		if (!visible.length) return;
		ev.preventDefault();
		const at = visible.findIndex((c) => c.tag === selected);
		if (ev.key === "Enter") return pick(visible[at < 0 ? 0 : at].tag);
		const next = Math.max(0, Math.min(visible.length - 1, at + (ev.key === "ArrowDown" ? 1 : -1)));
		pick(visible[next].tag);
		const on = tags.querySelector(".tag.on");
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
	if (win && !win.closed) win.close();
	win = null;
	entries = [];
	counts = [];
	loading = null;
}

function install() {}
function uninstall() {}

// node-only: lets test.js import the pure helpers; no-op inside Zotero.
if (typeof module !== "undefined") {
	module.exports = { fuzzy, rank, tagCounts, matchTags, matchColls, countByCollection, renameInList, parseMarkup, matchText, neighbours, groupByTitle };
}
