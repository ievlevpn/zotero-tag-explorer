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
const BOOK_TAGS = 24;  // tag chips shown on a book before "+N more"
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
let keyHandler = null;    // the document listener, so rebuilding replaces it
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

// The markup tags stripped, for anything that wants the words alone. The LaTeX
// stays: a formula's source is what you want on the clipboard.
const plain = (str) => str.replace(MARKUP, "");

// --- LaTeX ------------------------------------------------------------------

// A run of "math" longer than this is an unbalanced delimiter that swallowed
// the paragraph, not an equation.
const MATH_CAP = 400;

// Outside a maths library a "$" is a currency sign far more often than a
// delimiter — "paid $5 and $10" must not become an equation. So a $…$ run has
// to look like maths: a TeX command, a script or a group; or a single token; or
// something with no words in it. The \(…\) and \[…\] forms are unambiguous
// and skip the test.
function looksLikeMath(s) {
	if (/[\\^_{}]/.test(s)) return true;   // a command, a script, a group
	if (!/\s/.test(s)) return true;         // one token: "$n$", "$x+y$"
	return !/[a-z]{3,}/.test(s);            // prose has words; "$x + y$" has none
}

// Display environments that are written with no delimiters around them at all.
// LaTeX needs none — \begin{align*} is already display maths — so somebody
// pasting an equation out of a paper has no reason to add any.
const ENVS = /^\\begin\{(align|alignat|equation|eqnarray|gather|multline|split|flalign)(\*?)\}/;

// The cap catches a delimiter that never closed. An environment cannot be that
// — it was only taken because its own \end was found — so it may run as long
// as it likes.
const fitsAsMath = (tex) => tex.length <= MATH_CAP || ENVS.test(tex);

// A math run put back as source. Not necessarily the delimiters it was written
// with — \(x\) comes back as $x$ — but the same formula, and a reader can see
// where it starts and stops.
const delim = (run) => run.display ? "$$" + run.text + "$$" : "$" + run.text + "$";

// Split text into alternating plain and math runs. All four delimiter styles a
// person actually types turn up in annotations: $…$ and $$…$$ from anyone who
// writes TeX, \(…\) and \[…\] from anyone who has been told not to. A "$"
// escaped as "\$" is a literal dollar and never opens math, and an unbalanced
// delimiter is left exactly as found rather than swallowing the rest of the
// highlight.
function splitMath(text) {
	const s = text || "";
	const out = [];
	let plain = "";
	let i = 0;
	const flush = () => { if (plain) { out.push({ math: false, display: false, text: plain }); plain = ""; } };

	while (i < s.length) {
		const c = s[i];

		if (c === "\\") {
			// A bare environment is its own delimiter: take it whole, through to
			// the \end that closes it, and hand KaTeX the lot in display mode.
			const env = ENVS.exec(s.slice(i));
			if (env) {
				const tail = "\\end{" + env[1] + env[2] + "}";
				const end = s.indexOf(tail, i);
				if (end >= 0) {
					flush();
					out.push({ math: true, display: true, text: s.slice(i, end + tail.length) });
					i = end + tail.length;
					continue;
				}
			}
			const open = s[i + 1];
			const close = open === "(" ? "\\)" : open === "[" ? "\\]" : "";
			if (close) {
				const end = s.indexOf(close, i + 2);
				if (end < 0) { plain += s.slice(i); break; }   // unbalanced
				flush();
				out.push({ math: true, display: open === "[", text: s.slice(i + 2, end) });
				i = end + 2;
				continue;
			}
			plain += s.slice(i, i + 2);   // an escaped literal: \$ \% \\
			i += 2;
			continue;
		}

		if (c !== "$") { plain += s[i++]; continue; }

		const display = s[i + 1] === "$";
		const start = i;
		let j = i + (display ? 2 : 1);
		let body = "";
		let closed = false;
		let depth = 0;
		while (j < s.length) {
			if (s[j] === "\\" && j + 1 < s.length) { body += s.slice(j, j + 2); j += 2; continue; }
			const ch = s[j];
			// A "$" inside a group belongs to the formula, not to its delimiters:
			// "$$\tag{$\ast$}…$$" is one run, and closing at the first bare "$"
			// would leave \tag{ as the whole equation and shred the rest.
			if (ch === "{") depth++;
			else if (ch === "}") depth = Math.max(0, depth - 1);
			// Display maths is closed by "$$", never by a single "$".
			else if (ch === "$" && depth === 0 && (!display || s[j + 1] === "$")) { closed = true; break; }
			body += s[j++];
		}
		if (!closed) { plain += s.slice(start); break; }   // unbalanced
		if (!display && !looksLikeMath(body)) {
			// Not maths: keep the "$" and rescan from just after it, so the one
			// that closed this run is free to open a real one.
			plain += s[start];
			i = start + 1;
			continue;
		}
		flush();
		out.push({ math: true, display, text: body });
		i = j + (display ? 2 : 1);
	}
	flush();
	return out;
}

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
// A trailing "s" only folds off a word long enough for the singular to be a
// word: "APIs"/"API" is one tag written twice, but "vs"/"v" and "Ms"/"M" are
// two tags, and they were being offered pre-selected under "safe to merge".
const stem = (t) => { const s = loose(t); return s.length >= 4 ? s.replace(/s$/, "") : s; };

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

// --- KaTeX -----------------------------------------------------------------

// Formulas are typeset by KaTeX, bundled with the plugin. It is loaded once
// into a plain object rather than into the explorer window: that is the target
// loadSubScript is happiest with — it is how Zotero loads plugin bootstraps —
// and it means KaTeX never needs a `document` of its own, since renderToString
// gives back markup which is then parsed into the pane.
let rootURI = null;    // plugin root, set at startup
let katexLib = null;   // the library, once loaded
let katexCSS = null;   // its stylesheet, with the font URLs made absolute
let katexError = "";   // why it is missing, if it is

// A replaced .xpi keeps its old entry in the platform's zip cache, so the first
// read out of the new one fails with "Error opening input stream". Reinstalling
// the same version is when this bites, since nothing else about the file
// changed. Dropping the stale entry is what the add-on manager itself does
// after it swaps a file in. Harmless when the plugin runs from a directory.
function flushPluginCache() {
	safe(() => {
		const jar = Services.io.newURI(rootURI)
			.QueryInterface(Components.interfaces.nsIJARURI).JARFile
			.QueryInterface(Components.interfaces.nsIFileURL).file;
		Services.obs.notifyObservers(jar, "flush-cache-entry");
	});
}

async function loadKatex() {
	if (katexLib || katexError || !rootURI) return;
	// Two goes: a first failure is usually the stale cache entry above, and the
	// read after flushing it succeeds.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			// Hand the bundle the CommonJS hooks its UMD header checks for
			// first: seeing `module` and `exports` as objects, it assigns to
			// module.exports. That is deterministic. The other branch assigns to
			// `globalThis`, and under loadSubScript the target object is only on
			// the scope chain — the global stays whatever compartment the script
			// was compiled in, so the library would land somewhere we never look.
			const scope = { module: { exports: {} } };
			scope.exports = scope.module.exports;
			Services.scriptloader.loadSubScript(rootURI + "katex.min.js", scope, "UTF-8");
			const lib = typeof scope.module.exports.renderToString === "function"
				? scope.module.exports : scope.katex;
			if (!lib || typeof lib.renderToString !== "function") {
				throw new Error("katex.min.js ran but exported no renderToString");
			}
			const css = await Zotero.File.getResourceAsync(rootURI + "katex.min.css");
			// The stylesheet is inlined, so its relative font URLs would resolve
			// against about:blank. Absolute against the plugin root instead.
			katexCSS = css.replace(/url\(fonts\//g, "url(" + rootURI + "fonts/");
			katexLib = lib;
			return;
		}
		catch (e) {
			if (attempt === 0) { flushPluginCache(); continue; }
			oops(e);
			katexError = (e && e.message) || String(e);
		}
	}
}

// KaTeX's own stylesheet, put back after build() clears the head.
function ensureKatexCSS(doc) {
	if (!katexCSS) return;
	safe(() => {
		if (doc.getElementById("katex-css")) return;
		const style = el(doc, "style", null, katexCSS);
		style.id = "katex-css";
		(doc.head || doc.documentElement).append(style);
	});
}

// KaTeX's output is markup we generated ourselves from `tex` with trust:false,
// so it is parsed straight in rather than sanitized — trust:false is what keeps
// \href and friends out of it.
function katexFragment(doc, html) {
	return safe(() => {
		const parsed = new doc.defaultView.DOMParser().parseFromString(html, "text/html");
		const frag = doc.createDocumentFragment();
		for (const n of [...parsed.body.childNodes]) frag.append(doc.importNode(n, true));
		return frag;
	}, null);
}

// One formula, typeset into `parent`.
function mathInto(doc, parent, tex, display) {
	// throwOnError keeps one bad formula from taking out the card: KaTeX renders
	// what it can and marks the rest in place.
	const html = safe(() => katexLib.renderToString(tex, {
		displayMode: !!display, throwOnError: false, strict: false, trust: false,
	}), null);
	const frag = html && katexFragment(doc, html);
	// It refused outright: the source reads better than nothing.
	parent.append(frag || tex);
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
	// An annotation is in the trash when its attachment or the book above it is,
	// without a row of its own — so all three levels are checked. And the whole
	// index waits on this: a query that fails costs the duplicates panel, not
	// the window.
	const rows = await Zotero.DB.queryAsync(
		"SELECT t.name AS tag, i.libraryID AS lib, COUNT(*) AS n "
		+ "FROM itemTags it JOIN tags t ON t.tagID = it.tagID "
		+ "JOIN items i ON i.itemID = it.itemID "
		+ "LEFT JOIN itemAnnotations an ON an.itemID = it.itemID "
		+ "LEFT JOIN itemAttachments att ON att.itemID = an.parentItemID "
		+ "LEFT JOIN deletedItems d ON d.itemID = it.itemID "
		+ "LEFT JOIN deletedItems da ON da.itemID = an.parentItemID "
		+ "LEFT JOIN deletedItems dt ON dt.itemID = att.parentItemID "
		+ "WHERE d.itemID IS NULL AND da.itemID IS NULL AND dt.itemID IS NULL "
		+ "GROUP BY t.name, i.libraryID").catch((e) => { oops(e); return []; });
	const m = new Map();
	for (const r of rows) {
		let t = m.get(r.tag);
		if (!t) m.set(r.tag, t = { tag: r.tag, n: 0, libs: new Set() });
		t.n += r.n;
		t.libs.add(r.lib);
	}
	libTags = [...m.values()];
	recountDupes();
}

// Every library a tag is used in. The annotation index only knows the ones with
// highlights, and a rename moves items: a tag sitting on books in a group
// library is still that tag, and leaving it behind is a half-done rename.
function libsOf(tag) {
	const known = libTags.find((x) => x.tag === tag);
	if (known && known.libs.size) return known.libs;
	return new Set(entries.filter((e) => e.tags.includes(tag)).map((e) => e.libraryID));
}

// Around 100ms over a real library, so it runs when the tags or the dismissals
// change — not on every collection change and every press of Back, which is
// where it used to sit.
function recountDupes() {
	dupes = withoutDismissed(dupeClusters(libTags), dismissed);
	nears = withoutDismissed(nearMisses(libTags), dismissed);
}

function rescope() {
	counts = tagCounts(entries.filter(inScope));
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
/* KaTeX's stylesheet is injected after this one, so these have to out-specify
 * it rather than merely follow it. Its default 1.21em is tuned for Computer
 * Modern beside a sans body; next to this one it reads oversized. */
.hl .katex, .right h1 .katex, .book .katex { font-size:1.06em; }
/* A long equation scrolls in its own strip rather than widening the card. */
.hl .katex-display { margin:.7em 0; padding:.15em 0; overflow-x:auto; overflow-y:hidden; }
/* A book title is one line with an ellipsis; a display block inside it is not. */
.book .katex-display, .nm .katex-display { display:inline; margin:0; }
/* KaTeX marks what it could not parse with inline red; !important is what it
 * takes to override that. Muted rather than alarming: the source is still
 * readable underneath, and half-written LaTeX in a comment is normal. */
.katex-error { color:color-mix(in srgb, CanvasText 60%, Canvas) !important;
	border-bottom:1px dotted color-mix(in srgb, CanvasText 40%, Canvas);
	font-family:ui-monospace, monospace; font-size:.92em; }
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
	const text = (s, into) => {
		for (const run of markRuns(s, words || [])) {
			into.append(typeof run === "string" ? run : el(doc, "mark", null, run.mark));
		}
	};
	const put = (nodes, into) => {
		for (const n of nodes) {
			if (typeof n === "string") {
				// Without KaTeX nothing is a formula and this is the pane it has
				// always been: source, marks and all.
				if (!katexLib) { text(n, into); continue; }
				for (const run of splitMath(n)) {
					// The filter matches the source, so a hit inside a formula
					// would mean marking KaTeX's own spans. The typeset formula
					// wins: it is the thing you are here to read.
					if (run.math && fitsAsMath(run.text)) mathInto(doc, into, run.text, run.display);
					// Too long to be an equation. splitMath dropped the
					// delimiters on the way past, so put a pair back rather than
					// show a formula that has quietly lost its "$".
					else text(run.math ? delim(run) : run.text, into);
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
	ensureKatexCSS(doc);   // after ours, so the overrides in CSS out-specify it
	doc.body.replaceChildren();

	// build() runs again on Refresh, and once more when the first index load
	// lands, so without this the document collects a handler per build. Every
	// copy fires: Escape peeled a layer in one and closed the window in the
	// next, Alt+arrow stepped twice, and the dead ones pinned old DOM alive.
	// The new one goes on at the bottom, once what it reaches for exists: on
	// the loading path below, `search` and `hlQuery` are still in the dead
	// zone, and every key press threw instead of closing the window.
	if (keyHandler) doc.removeEventListener("keydown", keyHandler);
	keyHandler = null;

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
		if (loading) return;          // a second click would race the first rebuild
		entries = [];
		loading = reindex();
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
					const shown = book.rows.slice(0, room);
					const head = el(doc, "div", "book");
					const name = bookName(book);
					name.title = "Show this book";
					name.addEventListener("click", () => jumpToBook(book.book));
					// The last book under the cap gets cut off, and a bare total
					// over two cards reads as a bug.
					head.append(name, el(doc, "span", "n", shown.length < book.rows.length
						? `${shown.length} of ${book.rows.length}` : `${book.rows.length}`));
					list.append(head);
					for (const e of shown) list.append(card(e));
					room -= shown.length;
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
			const relRows = el(doc, "div");
			relRows.hidden = !relOpen;
			head.addEventListener("click", () => {
				relOpen = !relOpen;
				relRows.hidden = !relOpen;
				caret.textContent = relOpen ? "\u25BE" : "\u25B8";
			});
			box.append(head, relRows);
			for (const r of rel) {
				const row = el(doc, "div", "row");
				row.title = "Show this book";
				row.append(bookName(r), el(doc, "b", null,
					`${r.shared} shared tag${r.shared === 1 ? "" : "s"}`));
				row.addEventListener("click", () => jumpToBook(r.book));
				relRows.append(row);
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
			recountDupes();
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
		go.addEventListener("click", () => keep && mergeCluster(c, keep));

		const no = el(doc, "button", null, "Not duplicates");
		no.title = "Never suggest these again";
		no.addEventListener("click", () => {
			dismissed.push(namesOf(c));
			saveDismissed();
			recountDupes();
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
	async function mergeCluster(c, keep) {
		let failed = null;
		for (const t of c.tags) {
			if (t.tag === keep) continue;
			const libs = libsOf(t.tag);
			try {
				for (const lib of libs) await Zotero.Tags.rename(lib, t.tag, keep);
			} catch (e) {
				oops(e);
				failed = e;
				break;      // the spellings before this one did move: repaint, then say so
			}
			renameInList(entries, t.tag, keep, libs);
		}
		await loadLibraryTags();
		rescope();
		countLabel.textContent = summary();
		renderLeft();
		renderRight();
		if (failed) right.prepend(el(doc, "div", "err", `Could not merge: ${failed.message}`));
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
		const libs = libsOf(tag);
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
		await loadLibraryTags();   // or the duplicates panel still offers the old name
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
			w.setTimeout(() => { if (!w.closed) copy.textContent = "Copy"; }, 1200);
		});
		box.append(copy);
		box.addEventListener("click", () => safe(() => {
			// Dragging across the words to copy them by hand ends in a click on
			// the card, and opening the reader was not what that meant.
			const sel = w.getSelection();
			if (sel && !sel.isCollapsed) return;
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

	const typing = (e) => /^(input|textarea)$/i.test(e.target.tagName || "");
	keyHandler = (e) => {
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
	};
	doc.addEventListener("keydown", keyHandler);

	setScope(scope);
	search.focus();
}

// --- plugin lifecycle ------------------------------------------------------

// Not async, and nothing here waits on I/O: Zotero awaits every plugin's
// startup() in sequence inside its own init, so anything slow here delays the
// launch. The index is built the first time the window is opened.
function startup({ id, rootURI: uri }) {
	rootURI = uri;
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

// KaTeX rides along with the first index build, so the one "Reading your
// annotations…" screen covers both. It is a no-op on every build after.
const reindex = () =>
	Promise.all([buildIndex(), loadKatex()]).catch(oops).finally(() => { loading = null; });

function openWith(collection) {
	if (!entries.length && !loading) loading = reindex();
	open(collection);
}

function onMainWindowLoad({ window }) {
	safe(() => window.MozXULElement.insertFTLIfNeeded("tag-explorer.ftl"));
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
	module.exports = { fuzzy, rank, tagCounts, matchTags, matchColls, countByCollection, renameInList, parseMarkup, markRuns, matchText, neighbours, matchBooks, bookList, related, dupeClusters, nearMisses, clusterKey, withoutDismissed, plain, asText, groupByBook, splitMath, looksLikeMath, fitsAsMath };
}
