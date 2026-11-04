#!/usr/bin/env node
// Apple Notes search, read and write for any AI tool. No delete.
// - No args: runs as an MCP server over stdio (Claude Code, Cursor, Codex, ...).
// - `search` / `get` / `folders` / `create` / `update` / `export` / `health`: CLI for agents that only have a shell.
// Zero dependencies. macOS only (talks to Notes through osascript/JXA).

import { execFile, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

const SERVER = { name: "apple-notes", version: "0.1.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const BACKUP_DIR = join(homedir(), ".apple-notes-mcp", "backups");

// Privacy: the user can hide notes from AI tools. A hidden note is never listed, read or edited.
// - Notes tagged #private (anywhere in the text).
// - Notes in folders named in APPLE_NOTES_EXCLUDE (comma-separated), including their subfolders.
const PRIVATE_TAG = /(^|[^\p{L}\p{N}_])#private(?![\p{L}\p{N}_-])/iu;
const EXCLUDE_RAW = (process.env.APPLE_NOTES_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// ---------- Notes access (JXA) ----------

function jxa(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script, ...args],
      { maxBuffer: 256 * 1024 * 1024, timeout: 120000 },
      (err, stdout, stderr) => {
        if (!err) return resolve(JSON.parse(stdout));
        const msg = String(stderr || err.message);
        if (/-1743|not allowed|Not authorized/i.test(msg)) {
          return reject(new Error("macOS blocked access to Notes. Open System Settings > Privacy & Security > Automation, and allow this app (your terminal, Cursor, or Codex) to control Notes."));
        }
        if (/-1728/.test(msg)) return reject(new Error(`No note found for "${args[0]}". Use search_notes to get a valid id.`));
        reject(new Error(msg.trim().replace(/^.*?execution error: (Error: )*/, "").replace(/ \(-?\d+\)$/, "")));
      });
  });
}

// Every account, every folder (full path, note count) and every note (title, folder, dates, plain text).
// Text is read in one batched call per folder, so this stays fast; it is needed to find #private notes.
// "Recently Deleted" is found by its name in the user's language, taken from Notes' own strings,
// and only at the top of an account, so a user folder with that name deeper down is not mistaken for it.
const INDEX_JXA = `
ObjC.import("Foundation");
function run() {
  const Notes = Application("Notes");
  const trashNames = ["Recently Deleted"];
  try {
    const b = $.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/NotesShared.framework");
    if (b) trashNames.push(b.localizedStringForKeyValueTable("Recently Deleted", "Recently Deleted", "Localizable").js);
  } catch (e) {}
  const accounts = [], folders = {};
  // A nested folder can also be listed at the top of its account, so collect each folder once
  // and build its path from its parent chain, not from the order it was reached in.
  function collect(f, account) {
    const id = f.id();
    if (folders[id]) return;
    folders[id] = { ref: f, id: id, name: f.name(), account: account, parent: f.container().id() };
    for (const sub of f.folders()) collect(sub, account);
  }
  const defaultAccount = Notes.defaultAccount().name();
  for (const a of Notes.accounts()) {
    accounts.push({ name: a.name(), default: a.name() === defaultAccount, default_folder: a.defaultFolder().id() });
    for (const f of a.folders()) collect(f, a.name());
  }
  const pathOf = (x) => folders[x.parent] ? pathOf(folders[x.parent]) + "/" + x.name : x.name;
  const outFolders = [], notes = [];
  for (const id in folders) {
    const x = folders[id], f = x.ref, path = pathOf(x);
    const trash = !folders[x.parent] && trashNames.indexOf(x.name) >= 0;
    const ids = f.notes.id(), titles = f.notes.name();
    const mod = f.notes.modificationDate(), cre = f.notes.creationDate();
    const locked = f.notes.passwordProtected(), text = f.notes.plaintext();
    outFolders.push({ id: id, name: x.name, path: path, account: x.account, notes: ids.length, trash: trash });
    for (let i = 0; i < ids.length; i++) {
      notes.push({ id: ids[i], title: titles[i], folder: path, account: x.account, locked: locked[i], trash: trash,
        modified: mod[i].toISOString(), created: cre[i].toISOString(), text: locked[i] ? "" : text[i] });
    }
  }
  return JSON.stringify({ trash_name: trashNames[trashNames.length - 1], accounts: accounts, folders: outFolders, notes: notes });
}`;

const GET_JXA = `
function run(argv) {
  const n = Application("Notes").notes.byId(argv[0]);
  const locked = n.passwordProtected();
  return JSON.stringify({ id: n.id(), title: n.name(), locked: locked, attachments: n.attachments.length,
    html: locked ? "" : n.body(), text: locked ? "" : n.plaintext(),
    modified: n.modificationDate().toISOString(), created: n.creationDate().toISOString() });
}`;

// argv: folder id (resolved by resolveFolder), body HTML.
const CREATE_JXA = `
function run(argv) {
  const target = Application("Notes").folders.byId(argv[0]);
  const n = Application("Notes").Note({ body: argv[1] });
  target.notes.push(n);
  return JSON.stringify({ id: n.id(), title: n.name() });
}`;

// Passing a file to Notes in any Apple Event lets sandboxed Notes read it until Notes quits.
// `exists` has no side effects; it may throw, but the access is granted either way.
const GRANT_JXA = `
function run(argv) {
  const Notes = Application("Notes");
  for (const f of argv) { try { Notes.exists(Path(f)); } catch (e) {} }
  return "true";
}`;

const SET_BODY_JXA = `
function run(argv) {
  const n = Application("Notes").notes.byId(argv[0]);
  n.body = argv[1];
  return JSON.stringify({ id: n.id(), title: n.name(), modified: n.modificationDate().toISOString() });
}`;

// A folder path is excluded when any folder on it is named in APPLE_NOTES_EXCLUDE.
const isExcluded = (path) => String(path).split("/").some((seg) => EXCLUDE_RAW.some((x) => norm(x) === norm(seg)));
const isPrivate = (text) => PRIVATE_TAG.test(String(text ?? ""));

// Each note gets `hidden` (tagged #private or in an excluded folder). Callers must skip hidden notes.
async function readIndex() {
  const index = await jxa(INDEX_JXA);
  for (const n of index.notes) {
    n.private = isPrivate(n.text);
    n.excluded = isExcluded(n.folder);
    n.hidden = n.private || n.excluded;
  }
  for (const f of index.folders) f.excluded = isExcluded(f.path);
  return index;
}

const readNote = (id) => jxa(GET_JXA, [id]);

// The index entry for one note, refusing notes the AI tool must not touch.
function visibleNote(index, id) {
  const meta = index.notes.find((x) => x.id === id);
  if (!meta) throw new Error(`No note found for "${id}". Use search_notes to get a valid id.`);
  if (meta.hidden) throw new Error("This note is hidden from AI tools by its owner (#private tag or an excluded folder).");
  return meta;
}

// ---------- Title search ----------

const norm = (s) => String(s).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const words = (s) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Higher is better; 0 means no match.
// Order: exact > starts with > whole phrase at a word start > phrase anywhere > all words (any order, typos ok).
function scoreTitle(title, query) {
  const t = norm(title), q = norm(query);
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900;
  const at = t.indexOf(q);
  if (at > 0 && !/[\p{L}\p{N}]/u.test(t[at - 1])) return 800;
  if (at > 0) return 700;
  const tw = words(t);
  let total = 0;
  for (const qw of words(q)) {
    let best = 0;
    for (const w of tw) {
      if (w === qw) best = Math.max(best, 3);
      else if (w.startsWith(qw)) best = Math.max(best, 2.5);
      else if (w.includes(qw)) best = Math.max(best, 2);
      else if (qw.length >= 4 && editDistance(w, qw) <= (qw.length >= 7 ? 2 : 1)) best = Math.max(best, 1);
    }
    if (!best) return 0;
    total += best;
  }
  return 100 + Math.round((total / words(q).length) * 100);
}

// Index of the first occurrence of w that starts a word in t, or -1.
function wordStart(t, w) {
  for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) {
    if (!i || !/[\p{L}\p{N}]/u.test(t[i - 1])) return i;
  }
  return -1;
}

// Matches the query against a note's text. Always scores below any title match (title scores start at 100).
// Phrase first, then all words in any order. Words match at word starts, so "cat" finds "category" but not "concat".
// Returns a short snippet around the match so results stay small.
const SNIPPET = 160;
function matchText(text, query) {
  const body = String(text).replace(/\s+/g, " ").trim();
  const t = norm(body), q = norm(query);
  let at = wordStart(t, q), score = 60;
  if (at < 0) {
    const starts = words(q).map((w) => wordStart(t, w));
    if (!starts.length || starts.includes(-1)) return null;
    at = Math.min(...starts);
    score = 50;
  }
  // norm() keeps lengths close to the original, so this lands on or near the match.
  let from = Math.max(0, Math.min(at - 40, body.length - SNIPPET));
  const space = from > 0 ? body.indexOf(" ", from) : -1;
  if (space >= 0 && space < Math.min(from + 20, at)) from = space + 1; // start on a whole word
  const snippet = (from > 0 ? "…" : "") + body.slice(from, from + SNIPPET).trim() + (from + SNIPPET < body.length ? "…" : "");
  return { score, snippet };
}

async function searchNotes({ query = "", limit = 20, folder, include_deleted = false, search_text = true } = {}) {
  const withText = search_text && !!norm(query);
  const { notes } = await readIndex();
  const f = folder ? norm(folder) : null;
  const hits = [];
  for (const n of notes) {
    if (n.locked || n.hidden) continue; // locked and hidden notes stay private, titles included
    if (!include_deleted && n.trash) continue;
    if (f && !norm(n.folder).includes(f)) continue;
    const { locked, text, trash, private: _p, excluded, hidden, ...note } = n;
    const score = scoreTitle(n.title, query);
    if (score) hits.push(withText ? { ...note, matched_in: "title", score } : { ...note, score });
    else if (withText && text) {
      const hit = matchText(text, query);
      if (hit) hits.push({ ...note, matched_in: "text", snippet: hit.snippet, score: hit.score });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.modified.localeCompare(a.modified));
  return { total_matches: hits.length, results: hits.slice(0, Math.max(1, Math.min(limit, 200))) };
}

async function listFolders() {
  const { folders } = await readIndex();
  folders.sort((a, b) => a.account.localeCompare(b.account) || a.path.localeCompare(b.path));
  return { folders: folders.filter((f) => !f.excluded)
    .map(({ id, trash, excluded, ...f }) => (trash ? { ...f, read_only: true } : f)) };
}

// ---------- Note body: Apple Notes HTML -> Markdown ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// Notes often omits the closing ";" (e.g. "&lt"), so it is optional for the names we know.
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);?/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1))
    : ENTITIES[e.toLowerCase()]);

// Notes wraps each table in <object>. Keep tables; any other <object> is a file attachment.
const unwrapObjects = (s) => s.replace(/<object\b[^>]*>([\s\S]*?)<\/object>/gi, (_, inner) => /<table\b/i.test(inner) ? inner : "[attachment]");

function htmlToMarkdown(html) {
  let s = String(html).replace(/[\r\n]/g, ""); // Notes marks lines with <div>/<br>; raw newlines mean nothing
  let img = 0; // numbered so the AI can match each [image N] to the N-th image get_note returns
  s = unwrapObjects(s.replace(/<img\b[^>]*>/gi, () => `[image ${++img}]`));
  // Notes stores Title/Heading as bold text with a font size, and code as Courier.
  s = s.replace(/<div>\s*<b>\s*<span style="font-size: (\d+)px">([\s\S]*?)<\/span>\s*<\/b>\s*(?:<br>)?\s*<\/div>/gi, (m, px, t) =>
    +px >= 24 ? `<h1>${t}</h1>` : +px >= 18 ? `<h2>${t}</h2>` : m);
  s = s.replace(/<font face="Courier">([\s\S]*?)<\/font>/gi, (_, t) => "`" + t.replace(/<[^>]+>/g, "") + "`");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) =>
    `\n${"#".repeat(+l)} ${t.replace(/<[^>]+>/g, "").trim()}\n`);
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => `[${t.replace(/<[^>]+>/g, "")}](${h})`);
  s = s.replace(/<\/?(b|strong)\b[^>]*>/gi, "**").replace(/<\/?(i|em)\b[^>]*>/gi, "_").replace(/<\/?(strike|s|del)\b[^>]*>/gi, "~~");
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => inner.replace(/<li\b[^>]*>/gi, "\n1. "));
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<table\b[\s\S]*?<\/table>/gi, (t) => { // one Markdown row per <tr>; Notes puts a <div> in each cell
    const rows = [...t.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(([r]) => [...r.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(([, c]) => decode(c.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")));
    const cols = Math.max(1, ...rows.map((r) => r.length)), line = (r) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
    return rows.length ? `\n${[line(rows[0]), line(Array(cols).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n` : "";
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|ul|ol|table|tr)>/gi, "\n");
  s = decode(s.replace(/<[^>]+>/g, ""));
  s = s.replace(/\*\*(\s*)\*\*/g, "$1").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Images in note order, matching [image N]. Notes embeds them as data URIs; other sources yield null.
// Notes sometimes writes "base64,(null)" when it cannot export an image, so require real base64.
const noteImages = (html) => [...String(html).matchAll(/<img\b[^>]*>/gi)].map(([tag]) => {
  const m = tag.match(/src="data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)"/i);
  return m ? { mimeType: m[1], data: m[2].replace(/\s/g, "") } : null;
});

// Finds one note by id or by title and reads it, refusing hidden, locked and ambiguous notes.
async function readVisibleNote({ id, title }) {
  if (!id && !title) throw new Error("Pass `id` (from search_notes) or `title`.");
  if (!id) {
    const { results } = await searchNotes({ query: title, limit: 5, search_text: false });
    if (!results.length) throw new Error(`No note title matches "${title}".`);
    // Two equally good matches: reading either could be the wrong note, so ask for an id.
    const tied = results.filter((r) => r.score === results[0].score);
    if (tied.length > 1) {
      throw new Error(`${tied.length} notes match "${title}" equally well. Pass one of these ids: ` +
        tied.map((r) => `${r.id} ("${r.title}" in ${r.account}/${r.folder}, modified ${r.modified.slice(0, 10)})`).join("; "));
    }
    id = results[0].id;
  }
  const meta = visibleNote(await readIndex(), id);
  const n = await readNote(id);
  if (n.locked) throw new Error("This note is locked. Locked notes cannot be read.");
  if (isPrivate(n.text)) throw new Error("This note is hidden from AI tools by its owner (#private tag or an excluded folder).");
  return { meta, n };
}

async function getNote({ id, title, format = "markdown", max_images = 5 } = {}) {
  const { meta, n } = await readVisibleNote({ id, title });
  const content = format === "text" ? n.text : format === "html" ? n.html : htmlToMarkdown(n.html);
  // html already carries the images inline, so they are not sent twice.
  const all = format === "html" ? [] : noteImages(n.html);
  const images = all.slice(0, Math.max(0, Math.min(+max_images, 20)))
    .map((im, i) => im && { ...im, number: i + 1 }).filter(Boolean);
  return { id: n.id, title: n.title, folder: meta.folder, account: meta.account,
    created: n.created, modified: n.modified, attachments: n.attachments, format, content,
    images_total: all.length, images_included: images.map((im) => im.number), images };
}

// ---------- Writing: Markdown -> Apple Notes HTML ----------

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const inline = (s) => escapeHtml(s)
  .replace(/`([^`]+)`/g, "<tt>$1</tt>")
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)") // Notes drops href, so keep the URL as text
  .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<b>${a ?? b}</b>`)
  .replace(/(^|[^*\w])[*_]([^*_]+)[*_](?=[^*\w]|$)/g, "$1<i>$2</i>")
  .replace(/~~(.+?)~~/g, "<strike>$1</strike>");

// Notes imports an <img> as a real picture only from a file:// URL; a data: URL becomes a file icon.
// Notes is sandboxed, so it can read the file only after it is passed to Notes as a file reference
// in an Apple Event (GRANT_JXA). Without that, the image is an empty gray box.
const IMAGE_EXT = /\.(png|jpe?g|gif|heic|tiff?)$/i;
function imageTag(src) {
  if (/^[a-z]+:\/\//i.test(src)) throw new Error(`Image "${src}": only local files are supported, not URLs.`);
  const file = src.replace(/^~(?=\/)/, homedir());
  if (!isAbsolute(file)) throw new Error(`Image "${src}": use an absolute path, such as /Users/me/Desktop/photo.png.`);
  if (!IMAGE_EXT.test(file)) throw new Error(`Image "${src}": use a PNG, JPEG, GIF, HEIC or TIFF file.`);
  if (!existsSync(file)) throw new Error(`Image "${src}": file not found.`);
  return `<div><img src="${pathToFileURL(realpathSync(file)).href}"></div>`;
}

const imageFiles = (html) => [...html.matchAll(/<img src="(file:[^"]+)"/g)].map((m) => fileURLToPath(m[1]));

// Writes HTML that may contain local images: grant Notes read access to exactly those files,
// write, then wait until Notes has imported them and report any that failed ("(null)" to scripts).
async function writeWithImages(html, write) {
  const files = imageFiles(html);
  if (files.length) await jxa(GRANT_JXA, files);
  const note = await write();
  if (!files.length) return note;
  for (let i = 0; ; i++) {
    const tags = (await readNote(note.id)).html.match(/<img\b[^>]*>/gi) ?? [];
    const failed = tags.filter((t) => !/base64,[A-Za-z0-9+/]/.test(t)).length;
    if (!failed || i === 4) {
      return failed
        ? { ...note, images_added: tags.length - failed, images_failed: failed, warning: `${failed} image(s) did not import and show as empty boxes in Notes.` }
        : { ...note, images_added: tags.length };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function markdownToHtml(md) {
  const out = [];
  let list = null, code = false;
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const line of String(md).replace(/\r/g, "").split("\n")) {
    let m;
    if (/^\s*```/.test(line)) { closeList(); code = !code; }
    else if (code) out.push(`<div><tt>${escapeHtml(line) || "<br>"}</tt></div>`);
    else if ((m = line.match(/^\s*!\[[^\]]*\]\(\s*<?(.+?)>?\s*\)\s*$/))) { closeList(); out.push(imageTag(m[1])); }
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const l = Math.min(m[1].length, 3);
      out.push(`<div><h${l}>${inline(m[2])}</h${l}></div>`);
    } else if ((m = line.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/))) {
      const kind = m[1] ? "ol" : "ul";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(m[2])}</li>`);
    } else {
      closeList();
      out.push(line.trim() ? `<div>${inline(line)}</div>` : "<div><br></div>");
    }
  }
  closeList();
  return out.join("\n");
}

// Notes takes a note's title from its first line, so the title always goes first.
// Drop a leading heading in the content that repeats the title.
function noteBody(title, content = "") {
  const lines = String(content).replace(/^\s*\n/, "").split("\n");
  if (norm(lines[0]?.replace(/^#+\s*/, "") ?? "") === norm(title)) lines.shift();
  return `<div><h1>${inline(title)}</h1></div>\n${markdownToHtml(lines.join("\n"))}`;
}

// Picks exactly one folder to write into. `folder` is a name or a full path such as Work/Clients.
// The same name in two places is refused rather than guessed. Recently Deleted and excluded folders are never picked.
function resolveFolder(index, folder, account) {
  const accounts = index.accounts.filter((a) => !account || norm(a.name) === norm(account));
  if (!accounts.length) throw new Error(`Account not found: ${account}. Accounts: ${index.accounts.map((a) => a.name).join(", ")}`);
  const usable = index.folders.filter((f) => !f.trash && !f.excluded && accounts.some((a) => a.name === f.account));
  let matches;
  if (!folder) {
    const a = account ? accounts[0] : index.accounts.find((x) => x.default) ?? accounts[0];
    matches = usable.filter((f) => f.id === a.default_folder);
    if (!matches.length) throw new Error(`The default folder of ${a.name} is excluded. Pass a folder.`);
  } else {
    const want = norm(folder).replace(/^\/+|\/+$/g, "");
    matches = usable.filter((f) => norm(f.path) === want);
    if (!matches.length) matches = usable.filter((f) => norm(f.name) === want);
    if (!matches.length) {
      const trash = index.folders.some((f) => f.trash && norm(f.name) === want);
      throw new Error(trash ? `Nothing can be created in ${folder}.`
        : `Folder not found: ${folder}. Folders: ${usable.map((f) => `${f.account}/${f.path}`).join(", ")}`);
    }
  }
  if (matches.length > 1) {
    throw new Error(`${matches.length} folders are named "${folder}": ${matches.map((f) => `${f.account}/${f.path}`).join(", ")}. Pass \`account\`, or the full path as \`folder\`.`);
  }
  return matches[0];
}

async function createNote({ title, content = "", folder = "", account = "" } = {}) {
  if (!String(title ?? "").trim()) throw new Error("`title` is required.");
  const target = resolveFolder(await readIndex(), folder, account);
  const body = noteBody(title.trim(), content);
  return writeWithImages(body, async () =>
    ({ ...(await jxa(CREATE_JXA, [target.id, body])), folder: target.path, account: target.account }));
}

async function updateNote({ id, content, mode = "append" } = {}) {
  if (!id) throw new Error("Pass `id` from search_notes. Updates need an exact id, not a title.");
  if (!String(content ?? "").trim()) throw new Error("`content` is required.");
  if (!["append", "replace"].includes(mode)) throw new Error("`mode` must be append or replace.");
  const [n, index] = await Promise.all([readNote(id), readIndex()]);
  if (visibleNote(index, id).trash) throw new Error("This note is in Recently Deleted. It cannot be edited.");
  if (n.locked) throw new Error("This note is locked. Unlock it in Notes first.");
  if (isPrivate(n.text)) throw new Error("This note is hidden from AI tools by its owner (#private tag or an excluded folder).");
  if (n.attachments) {
    throw new Error(`This note has ${n.attachments} attachment(s). Editing would remove them, because Notes rewrites the whole body. Create a new note instead, or edit this one in Notes.`);
  }
  const body = mode === "append" ? `${n.html}\n${markdownToHtml(content)}` : noteBody(n.title, content);
  mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id.split("/").pop()}.html`);
  writeFileSync(backup, n.html);
  return { ...(await writeWithImages(body, () => jxa(SET_BODY_JXA, [id, body]))), mode, backup };
}

// Tells "nothing matched" apart from "no access", "wrong account" and "hidden by the privacy settings".
// Never throws: a failure is reported in the result, because that is what the caller needs to see.
async function health() {
  const out = { ok: false, version: SERVER.version, node: process.version, backups: BACKUP_DIR,
    excluded_folders: EXCLUDE_RAW, private_tag: "#private" };
  try {
    const index = await readIndex();
    const count = (pred) => index.notes.filter(pred).length;
    Object.assign(out, {
      ok: true,
      notes_access: "ok",
      recently_deleted_folder: index.trash_name,
      accounts: index.accounts.map((a) => ({ name: a.name, default: a.default,
        folders: index.folders.filter((f) => f.account === a.name).length,
        notes: count((n) => n.account === a.name) })),
      notes: { total: index.notes.length, visible: count((n) => !n.locked && !n.hidden && !n.trash),
        locked: count((n) => n.locked), hidden_private_tag: count((n) => n.private),
        hidden_excluded_folder: count((n) => n.excluded), in_recently_deleted: count((n) => n.trash) },
      unmatched_exclusions: EXCLUDE_RAW.filter((x) => !index.folders.some((f) => norm(f.name) === norm(x))),
    });
  } catch (e) {
    out.notes_access = "failed";
    out.error = e.message;
  }
  return out;
}

// ---------- Export: Apple Notes HTML -> Word .docx ----------
// Notes exports only PDF, and macOS's textutil drops images from .docx. So the .docx is built here:
// it is a zip of a few XML files, written with Node's built-in zlib.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimal zip: each file deflated, then the central directory. Dates are fixed at 1980-01-01.
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const packed = deflateRawSync(data), nameBuf = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, packed);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const xml = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// One image from a note, ready for Word: PNG, JPEG or GIF with its size in pixels.
// Other formats (TIFF, HEIC) are converted to PNG with sips, which is built into macOS. null if it fails.
function docxImage(mime, base64) {
  const dir = mkdtempSync(join(tmpdir(), "apple-notes-export-"));
  try {
    let file = join(dir, "image"), ext = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif" }[mime.toLowerCase()];
    writeFileSync(file, Buffer.from(base64, "base64"));
    if (!ext) {
      execFileSync("sips", ["-s", "format", "png", file, "--out", join(dir, "image.png")], { stdio: "ignore" });
      file = join(dir, "image.png");
      ext = "png";
    }
    const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]).toString();
    const w = +info.match(/pixelWidth: (\d+)/)?.[1], h = +info.match(/pixelHeight: (\d+)/)?.[1];
    return w && h ? { data: readFileSync(file), ext, w, h } : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PAGE_TEXT_WIDTH = 9026; // A4 width minus 1-inch margins, in twentieths of a point
const MAX_IMAGE_EMU = 5486400; // 6 inches; Word sizes drawings in EMU (914400 per inch, 9525 per pixel)

// Converts the HTML that Notes stores into the body of a Word document.
// Handles what Notes writes: lines (<div>, <br>), headings, bold, italic, underline, strikethrough,
// monospaced text, font sizes, links, bulleted and numbered lists (nested), tables and images.
function htmlToDocx(html) {
  const rels = [], media = [], lists = [], body = [], listStack = [], tagStack = [];
  const fmt = { b: 0, i: 0, u: 0, s: 0, code: 0, size: 0, link: null };
  let para = null, table = null, row = null, cell = null, images = 0, failed = 0;
  const rel = (type, target, external) => {
    const id = `rId${rels.length + 3}`; // rId1 and rId2 are styles and numbering
    rels.push({ id, type, target, external });
    return id;
  };
  const target = () => cell ?? body;
  const newPara = (extra = {}) => ({ runs: [], ...extra });
  const flush = () => {
    if (para && (para.runs.length || para.blank)) target().push(paraXml(para));
    para = null;
  };
  const ensurePara = () => (para ??= newPara());

  function runXml(r) {
    if (r.br) return "<w:r><w:br/></w:r>";
    if (r.drawing) return r.drawing;
    const p = [];
    if (r.code) p.push('<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Menlo"/>');
    if (r.b) p.push("<w:b/>");
    if (r.i) p.push("<w:i/>");
    if (r.s) p.push("<w:strike/>");
    if (r.link) p.push('<w:color w:val="0563C1"/>');
    if (r.size) p.push(`<w:sz w:val="${Math.round(r.size * 1.5)}"/>`); // px -> half-points
    if (r.u || r.link) p.push('<w:u w:val="single"/>');
    return `<w:r>${p.length ? `<w:rPr>${p.join("")}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(r.text)}</w:t></w:r>`;
  }
  function paraXml(p) {
    const pr = [];
    if (p.style) pr.push(`<w:pStyle w:val="${p.style}"/>`);
    if (p.list) pr.push(`<w:numPr><w:ilvl w:val="${p.list.level}"/><w:numId w:val="${p.list.num}"/></w:numPr>`);
    let out = "", i = 0;
    while (i < p.runs.length) { // consecutive runs of one link share one <w:hyperlink>
      const link = p.runs[i].link;
      let j = i;
      while (j < p.runs.length && p.runs[j].link === link) j++;
      const runs = p.runs.slice(i, j).map(runXml).join("");
      out += link ? `<w:hyperlink r:id="${link}">${runs}</w:hyperlink>` : runs;
      i = j;
    }
    return `<w:p>${pr.length ? `<w:pPr>${pr.join("")}</w:pPr>` : ""}${out}</w:p>`;
  }
  function imageXml(img) {
    let cx = img.w * 9525, cy = img.h * 9525;
    if (cx > MAX_IMAGE_EMU) { cy = Math.round(cy * MAX_IMAGE_EMU / cx); cx = MAX_IMAGE_EMU; }
    const n = media.length + 1, name = `image${n}.${img.ext}`;
    media.push([`word/media/${name}`, img.data]);
    const rid = rel("image", `media/${name}`);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${n}" name="Picture ${n}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
  function tableXml(t) {
    const cols = Math.max(1, ...t.rows.map((r) => r.length)), w = Math.floor(PAGE_TEXT_WIDTH / cols);
    const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>`;
    const rows = t.rows.map((r) => `<w:tr>${Array.from({ length: cols }, (_, i) =>
      `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${(r[i] ?? []).join("") || "<w:p/>"}</w:tc>`).join("")}</w:tr>`);
    return `<w:tbl><w:tblPr><w:tblW w:w="${w * cols}" w:type="dxa"/><w:tblBorders>` +
      ["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("") +
      `</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${w}"/>`.repeat(cols)}</w:tblGrid>` +
      `${rows.join("")}</w:tbl><w:p/>`;
  }

  const src = unwrapObjects(String(html).replace(/[\r\n]/g, ""));
  for (const token of src.split(/(<[^>]+>)/)) {
    if (!token) continue;
    if (token[0] !== "<") {
      const p = ensurePara();
      if (p.pendingBreak) { p.runs.push({ br: true }); p.pendingBreak = false; }
      p.runs.push({ text: decode(token), ...fmt });
      continue;
    }
    const m = token.match(/^<(\/?)([a-z0-9]+)\b([^>]*)>$/i);
    if (!m) continue;
    const close = !!m[1], tag = m[2].toLowerCase(), attrs = m[3];
    if (tag === "div" || tag === "p") {
      if (close) { if (para && !para.runs.length && para.sawBreak) para.blank = true; flush(); }
      else if (!para || para.runs.length) { flush(); para = newPara(); }
    } else if (tag === "br") {
      const p = ensurePara();
      p.sawBreak = true;
      if (p.runs.length) p.pendingBreak = true;
    } else if (/^h[1-6]$/.test(tag)) {
      if (close) flush();
      else {
        if (para?.runs.length) flush();
        ensurePara().style = `Heading${Math.min(+tag[1], 3)}`;
      }
    } else if (tag === "ul" || tag === "ol") {
      flush();
      if (close) listStack.pop();
      else {
        lists.push({ ordered: tag === "ol", level: Math.min(listStack.length, 8) });
        listStack.push(lists.length);
      }
    } else if (tag === "li") {
      flush();
      if (!close && listStack.length) para = newPara({ list: { num: listStack.at(-1), level: lists[listStack.at(-1) - 1].level } });
    } else if (tag === "table") {
      flush();
      if (close) { if (table) body.push(tableXml(table)); table = null; } else table = { rows: [] };
    } else if (tag === "tr") {
      if (close) { if (table && row) table.rows.push(row); row = null; } else row = [];
    } else if (tag === "td" || tag === "th") {
      if (close) { flush(); if (row && cell) row.push(cell); cell = null; } else { flush(); cell = []; }
    } else if (tag === "img") {
      const d = attrs.match(/src="data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)"/i);
      const img = d && docxImage(d[1], d[2].replace(/\s/g, ""));
      images++;
      flush();
      if (img) target().push(paraXml({ runs: [{ drawing: imageXml(img) }] }));
      else { failed++; target().push(paraXml({ runs: [{ text: `[image ${images} could not be exported]` }] })); }
    } else if (["b", "strong", "i", "em", "u", "strike", "s", "del", "tt", "code"].includes(tag)) {
      const key = { strong: "b", em: "i", strike: "s", del: "s", tt: "code" }[tag] ?? tag;
      fmt[key] = Math.max(0, fmt[key] + (close ? -1 : 1));
    } else if (tag === "a") {
      const href = attrs.match(/href="([^"]*)"/i)?.[1];
      fmt.link = !close && href && /^(https?|mailto):/i.test(href) ? rel("hyperlink", decode(href), true) : null;
    } else if (tag === "span" || tag === "font") {
      if (close) {
        const prev = tagStack.pop();
        if (prev) { fmt.code -= prev.code; fmt.size = prev.size; }
      } else {
        const code = /face="[^"]*courier/i.test(attrs) ? 1 : 0, px = attrs.match(/font-size:\s*(\d+)px/i)?.[1];
        tagStack.push({ code, size: fmt.size });
        fmt.code += code;
        if (px) fmt.size = +px;
      }
    }
  }
  flush();
  return { body: body.join(""), rels, media, lists, images, failed };
}

function buildDocx(title, html) {
  const d = htmlToDocx(html);
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const levels = (ordered) => Array.from({ length: 9 }, (_, i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? "decimal" : "bullet"}"/>` +
    `<w:lvlText w:val="${ordered ? `%${i + 1}.` : "•"}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("");
  // One definition per list, so every numbered list starts at 1 in every app, not only in Word.
  const numbering = `${head}<w:numbering ${W}>` +
    d.lists.map((l, i) => `<w:abstractNum w:abstractNumId="${i + 1}">${levels(l.ordered)}</w:abstractNum>`).join("") +
    d.lists.map((_, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i + 1}"/></w:num>`).join("") +
    "</w:numbering>";
  const heading = (n, size) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
    `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/>` +
    `<w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `${head}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/>` +
    `</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    heading(1, 36) + heading(2, 28) + heading(3, 24) + "</w:styles>";
  const document = `${head}<w:document ${W} xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${d.body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const docRels = `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>` +
    d.rels.map((r) => `<Relationship Id="${r.id}" Type="${R}/${r.type}" Target="${xml(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("") +
    "</Relationships>";
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const core = `${head}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xml(title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const ct = "application/vnd.openxmlformats-officedocument.wordprocessingml";
  const types = `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>' +
    `<Override PartName="/word/document.xml" ContentType="${ct}.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="${ct}.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="${ct}.numbering+xml"/>` +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
  const pkgRels = `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    "</Relationships>";
  const file = zip([["[Content_Types].xml", types], ["_rels/.rels", pkgRels], ["docProps/core.xml", core],
    ["word/document.xml", document], ["word/styles.xml", styles], ["word/numbering.xml", numbering],
    ["word/_rels/document.xml.rels", docRels], ...d.media]);
  return { file, images: d.images, failed: d.failed };
}

// Where to save: a folder (the file is named after the note) or a full path ending in .docx.
// Never overwrites: a taken name in a folder gets " (2)", " (3)" and so on; a taken full path is refused.
function exportPath(to, title) {
  const path = String(to).replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(path)) throw new Error(`"${to}": use an absolute path, such as ~/Downloads.`);
  if (/\.docx$/i.test(path)) {
    if (existsSync(path)) throw new Error(`${path} already exists. Choose another name; files are never overwritten.`);
    return path;
  }
  if (!existsSync(path)) throw new Error(`Folder not found: ${path}`);
  const base = String(title).replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").replace(/^[\s.-]+/, "").trim().slice(0, 100) || "Note";
  for (let i = 1; ; i++) {
    const file = join(path, `${base}${i > 1 ? ` (${i})` : ""}.docx`);
    if (!existsSync(file)) return file;
  }
}

async function exportNote({ id, title, to = "~/Downloads" } = {}) {
  const { meta, n } = await readVisibleNote({ id, title });
  const path = exportPath(to, n.title);
  const { file, images, failed } = buildDocx(n.title, n.html);
  writeFileSync(path, file, { flag: "wx" });
  return { id: n.id, title: n.title, folder: meta.folder, account: meta.account, file: path, bytes: file.length,
    images_embedded: images - failed, ...(failed ? { images_failed: failed, warning: `${failed} image(s) could not be exported and are marked in the text.` } : {}) };
}

// ---------- MCP server (JSON-RPC 2.0, newline-delimited over stdio) ----------

const TOOLS = [
  {
    name: "search_notes",
    title: "Search Apple Notes",
    description: "Search Apple Notes across all accounts and folders, by title and by the text inside notes. Title matches always rank first: exact, prefix, phrase, then all words in any order with typo tolerance. Then notes whose text contains the phrase or all the words; these have matched_in=text and a short snippet. Empty query lists the most recently modified notes. Returns ids for get_note.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find. Case and accents are ignored." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
        folder: { type: "string", description: "Only notes in folders whose path contains this text." },
        search_text: { type: "boolean", default: true, description: "Also search the text inside notes. false searches titles only." },
        include_deleted: { type: "boolean", default: false, description: "Include notes in Recently Deleted." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_note",
    title: "Read an Apple Note",
    description: "Read one Apple Note. Pass `id` from search_notes (exact), or `title` (best title match). Returns Markdown by default, keeping headings, lists and links. Also returns the note's images (up to max_images) as image content, in order; [image N] in the text marks where image N sits.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Note id from search_notes." },
        title: { type: "string", description: "Used when id is not given; reads the best title match. Refused with a list of ids if two notes match equally well." },
        format: { type: "string", enum: ["markdown", "text", "html"], default: "markdown" },
        max_images: { type: "integer", minimum: 0, maximum: 20, default: 5, description: "How many of the note's images to return, in order. 0 for none." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_folders",
    title: "List Apple Notes folders",
    description: "List every Notes folder in every account, with its full path and how many notes it holds. Use a folder's name with create_note, or its path with search_notes. Recently Deleted is marked read_only.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "create_note",
    title: "Create an Apple Note",
    description: "Create a new Apple Note. Content is Markdown: headings, bullet and numbered lists, bold, italic, links, inline and fenced code. Checkboxes become plain bullets. To add an image, put ![caption](/absolute/path/to/file.png) on its own line (PNG, JPEG, GIF, HEIC or TIFF; local files only). Returns the new note's id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title. It becomes the first line." },
        content: { type: "string", description: "Note body in Markdown, without the title." },
        folder: { type: "string", description: "Folder name or full path such as Work/Clients (case-insensitive). If the name exists in more than one place, pass the path or account. Default: the default Notes folder." },
        account: { type: "string", description: "Account name, e.g. iCloud or On My Mac. Default: the default account." },
      },
      required: ["title"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "update_note",
    title: "Edit an Apple Note",
    description: "Add to or replace the content of an existing Apple Note. Needs the exact id from search_notes. mode=append (default) adds Markdown at the end; mode=replace replaces everything below the title. Images work as in create_note; after that the note has attachments, so later edits are refused. Refuses locked notes and notes with attachments (an edit would remove them). Saves the old HTML to a backup file first. Cannot delete notes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Note id from search_notes." },
        content: { type: "string", description: "Markdown to add, or the new body." },
        mode: { type: "string", enum: ["append", "replace"], default: "append" },
      },
      required: ["id", "content"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "export_note",
    title: "Export an Apple Note to Word",
    description: "Save one Apple Note as a Word .docx file on this Mac, with its images, headings, lists, tables, links and text styles. Notes itself can export only PDF. Pass `id` from search_notes, or `title`. The note is not changed. Existing files are never overwritten. Returns the file path.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Note id from search_notes." },
        title: { type: "string", description: "Used when id is not given; exports the best title match." },
        to: { type: "string", default: "~/Downloads", description: "Folder to save into (the file is named after the note), or a full path ending in .docx. Absolute path or ~/." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "health",
    title: "Check Apple Notes access",
    description: "Check that this plugin can reach Apple Notes. Call it when a search returns nothing that should exist, or when a call fails. Reports macOS permission status, accounts, note counts, and how many notes are hidden by the owner's privacy settings.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const HANDLERS = { search_notes: searchNotes, get_note: getNote, list_folders: listFolders, create_note: createNote, update_note: updateNote, export_note: exportNote, health };

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize": {
      const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return { protocolVersion: v, capabilities: { tools: {} }, serverInfo: SERVER,
        instructions: "Find notes with search_notes (titles and text), then read one with get_note using the returned id. list_folders shows where notes live. Write with create_note or update_note (needs the id). export_note saves a note as a Word file. Notes cannot be deleted. If a note you expect is missing, call health. The owner hides some notes on purpose (#private tag, excluded folders): never try to reach a hidden note another way, such as reading the Notes database or running osascript." };
    }
    case "ping": return {};
    case "tools/list": return { tools: TOOLS };
    case "tools/call": {
      const fn = HANDLERS[params.name];
      if (!fn) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
      try {
        const { images = [], ...result } = await fn(params.arguments ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) },
          ...images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }))] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined; // notification: no reply
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function serve() {
  const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    try {
      const result = await handle(msg);
      if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
    }
  });
}

// ---------- CLI ----------

const HELP = `Apple Notes for AI tools (macOS)

  apple-notes-plugin                     Run as an MCP server (stdio)
  apple-notes-plugin search [query] [--limit N] [--folder NAME] [--titles-only] [--deleted]
  apple-notes-plugin get <id-or-title> [--format markdown|text|html] [--max-images N]
  apple-notes-plugin folders
  apple-notes-plugin create <title> [--content MARKDOWN] [--folder NAME|PATH] [--account NAME]
  apple-notes-plugin update <id> --content MARKDOWN [--mode append|replace]
  apple-notes-plugin export <id-or-title> [--to FOLDER|FILE.docx]
  apple-notes-plugin health

Search matches titles first, then note text. --content - reads Markdown from stdin.
Notes tagged #private, and folders listed in APPLE_NOTES_EXCLUDE, are hidden.
No delete. Output is JSON.`;

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const flags = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--deleted") flags.include_deleted = true;
    else if (rest[i] === "--titles-only") flags.search_text = false;
    else if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i];
    else pos.push(rest[i]);
  }
  if (flags.content === "-") flags.content = readFileSync(0, "utf8");
  let out;
  if (cmd === "create") out = await createNote({ ...flags, title: pos.join(" ") });
  else if (cmd === "update") out = await updateNote({ ...flags, id: pos[0] });
  else if (cmd === "search") out = await searchNotes({ ...flags, query: pos.join(" "), limit: flags.limit ? +flags.limit : 20 });
  else if (cmd === "folders") out = await listFolders();
  else if (cmd === "health") out = await health();
  else if (cmd === "export") {
    const arg = pos.join(" ");
    out = await exportNote({ to: flags.to, ...(arg.startsWith("x-coredata://") ? { id: arg } : { title: arg }) });
  }
  else if (cmd === "get") {
    const arg = pos.join(" ");
    const { images, ...note } = await getNote({ format: flags.format, max_images: flags["max-images"] ?? 5,
      ...(arg.startsWith("x-coredata://") ? { id: arg } : { title: arg }) });
    // A shell can't show images, so save them and print the paths.
    const dir = join(tmpdir(), "apple-notes-mcp", note.id.split("/").pop());
    if (images.length) mkdirSync(dir, { recursive: true });
    note.image_files = images.map((im) => {
      const file = join(dir, `image-${im.number}.${im.mimeType.split("/")[1].replace("jpeg", "jpg").replace("+xml", "")}`);
      writeFileSync(file, Buffer.from(im.data, "base64"));
      return file;
    });
    out = note;
  } else { console.log(HELP); return; }
  console.log(JSON.stringify(out, null, 2));
}

const args = process.argv.slice(2);
if (args.length) cli(args).catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
else if (process.stdin.isTTY) console.log(HELP);
else serve();
