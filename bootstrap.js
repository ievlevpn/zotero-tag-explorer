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

// One row per tagged annotation. The SQL only picks the ids — going through
// the item API for everything else keeps this out of Zotero's schema.
async function buildIndex() {
	const ids = await Zotero.DB.columnQueryAsync(
		"SELECT DISTINCT a.itemID FROM itemAnnotations a JOIN itemTags t ON t.itemID = a.itemID");
	const anns = (await Zotero.Items.getAsync(ids)).filter((a) => a && !a.deleted);
	await Zotero.Items.loadDataTypes(anns, ["annotation", "tags"]);

	// The attachment holds the annotation; its parent is the book. Load both in
	// bulk — one round trip beats ten thousand lazy ones.
	const parents = await Zotero.Items.getAsync(
		[...new Set(anns.map((a) => a.parentID).filter(Boolean))]);
	await Zotero.Items.loadDataTypes(parents);
	const tops = await Zotero.Items.getAsync(
		[...new Set(parents.map((p) => p.parentID).filter(Boolean))]);
	await Zotero.Items.loadDataTypes(tops);

	const collsOf = new Map();   // top item id → its collections, worked out once
	const out = [];
	for (const a of anns) {
		const top = safe(() => a.topLevelItem, null);
		if (!top || top.deleted) continue;
		if (!collsOf.has(top.id)) collsOf.set(top.id, collectionsOf(top));
		out.push({
			id: a.id,
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
.right h1 { font-size:15px; margin:0 0 2px; }
.right .sub { color:GrayText; font-size:11px; margin-bottom:14px; }
.book { margin:18px 0 6px; padding-bottom:3px; border-bottom:1px solid GrayText;
	font-weight:700; display:flex; justify-content:space-between; gap:8px; }
.book span { color:GrayText; font-weight:400; font-size:11px; white-space:nowrap; }
.hl { border-left:4px solid var(--c); padding:5px 8px; margin:6px 0; border-radius:0 4px 4px 0;
	cursor:pointer; background:color-mix(in srgb, var(--c) 10%, Canvas); }
.hl:hover { background:color-mix(in srgb, var(--c) 22%, Canvas); }
.hl .t { white-space:pre-wrap; }
.hl .c { white-space:pre-wrap; margin-top:5px; padding-left:8px; border-left:2px solid GrayText;
	color:CanvasText; font-style:italic; }
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
	doc.addEventListener("keydown", (e) => { if (e.key === "Escape") w.close(); });

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

	const combo = el(doc, "div", "pick");
	const scopeBox = doc.createElement("input");
	scopeBox.type = "text";
	scopeBox.placeholder = "All collections";
	scopeBox.title = "Restrict everything to one collection";
	const drop = el(doc, "div", "drop");
	drop.hidden = true;
	combo.append(scopeBox, drop);
	head.append(combo, countLabel, refresh);

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
		renderTags();
		renderHighlights();
	}

	// Focusing empties the box so typing starts a fresh search; leaving without
	// choosing puts the current collection back.
	scopeBox.addEventListener("focus", () => { scopeBox.value = ""; showDrop(); });
	scopeBox.addEventListener("input", showDrop);
	scopeBox.addEventListener("blur", () => { drop.hidden = true; scopeBox.value = scopeLabel(); });
	scopeBox.addEventListener("keydown", (ev) => {
		if (ev.key === "Escape") return scopeBox.blur();
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

	function pick(tag) {
		selected = tag;
		renderTags();
		renderHighlights();
		right.scrollTop = 0;
	}

	function renderTags() {
		visible = matchTags(counts, search.value);
		tags.replaceChildren();
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

	function renderHighlights() {
		right.replaceChildren();
		if (!selected) {
			right.append(el(doc, "div", "empty", "Pick a tag."));
			return;
		}
		const rows = entries.filter((e) => inScope(e) && e.tags.includes(selected));
		right.append(el(doc, "h1", null, selected));
		right.append(el(doc, "div", "sub",
			`${rows.length} highlight${rows.length === 1 ? "" : "s"}` + (scope ? " in this collection" : "")));

		let cap = HL_CAP;
		const list = el(doc, "div");
		right.append(list);
		const paint = () => {
			list.replaceChildren();
			let left_ = cap;
			for (const book of groupByTitle(rows)) {
				if (left_ <= 0) break;
				const head = el(doc, "div", "book");
				head.append(el(doc, "b", null, book.title),
					el(doc, "span", null, `${book.rows.length}`));
				list.append(head);
				for (const e of book.rows.slice(0, left_)) list.append(card(e));
				left_ -= book.rows.length;
			}
			if (rows.length > cap) {
				const more = el(doc, "button", "more", `Show all ${rows.length}`);
				more.addEventListener("click", () => { cap = rows.length; paint(); });
				list.append(more);
			}
		};
		paint();
	}

	function card(e) {
		const box = el(doc, "div", "hl");
		box.style.setProperty("--c", e.color);
		box.title = "Open in the reader";
		if (e.text) box.append(el(doc, "div", "t", e.text));
		else box.append(el(doc, "div", "t", `[${e.type}]`));
		if (e.comment) box.append(el(doc, "div", "c", e.comment));

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
	module.exports = { fuzzy, rank, tagCounts, matchTags, matchColls, countByCollection, groupByTitle };
}
