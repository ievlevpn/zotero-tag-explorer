# Tag Explorer

A Zotero 10 plugin for reading your own marginalia by tag.

**Tools → Tag Explorer…** opens a window:

- every tag you have put on a highlight, most used first, with a fuzzy search
  box (`hdg` finds `Хайдеггер`; exact matches sort above prefixes above
  substrings above scattered ones);
- the highlights carrying the selected tag on the right, grouped by book, in
  reading order, in their own highlight colour, with your comments;
- a collection box at the top to restrict everything to one project —
  fuzzy-searchable over the full path (`phil frank` finds *Philosophy /
  Frankfurt School*), showing how many highlights each holds,
  sub-collections included;
- the other tags on a highlight are chips: click one to jump to it;
- click a highlight to open the reader on it.

Right-clicking a collection in the library offers **Explore Tags in This
Collection…**, which opens the same window already restricted.

`↓` `↑` `Enter` move through the tag list from the search box, and through
the collection list from the collection box. `Esc` closes.

## Install

Download `tag-explorer.xpi` from the
[latest release](https://github.com/ievlevpn/zotero-tag-explorer/releases/latest),
then Zotero → Tools → Plugins → ⚙ → *Install Plugin From File…*

## Hacking

No build step. The whole plugin is `bootstrap.js`.

	zip -r tag-explorer.xpi manifest.json bootstrap.js locale icons

and install that. `node test.js` checks the pure helpers; `./release.sh` cuts
a release (bump `version` in `manifest.json` first).

## How it works

Nothing is stored. Opening the window reads every tagged annotation in every
library into one array (one SQL query for the ids, the Zotero item API for
everything else) and each view is a scan over it. About ten thousand tagged
highlights load in a second or so and every keystroke after that is instant.
The index is built once per session — **Refresh** rebuilds it after you tag
something new.
