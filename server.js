#!/usr/bin/env node
// Apple Notes search, read and write for any AI tool. No delete.
// - No args: runs as an MCP server over stdio (Claude Code, Cursor, Codex, ...).
// - `search` / `get` / `create` / `update`: CLI for agents that only have a shell.
// Zero dependencies. macOS only (talks to Notes through osascript/JXA).

import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER = { name: "apple-notes", version: "0.1.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TRASH = "Recently Deleted";
const BACKUP_DIR = join(homedir(), ".apple-notes-mcp", "backups");

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

// Every note with title, folder, account and dates, plus every folder with its note count.
// argv[0] === "text" also reads each unlocked note's plain text, one batched call per folder.
const INDEX_JXA = `
function run(argv) {
  const Notes = Application("Notes");
  const withText = argv[0] === "text";
  const out = [], seen = {}, folders = {};
  function walk(folder, account, path) {
    const name = path ? path + "/" + folder.name() : folder.name();
    const ids = folder.notes.id(), titles = folder.notes.name();
    const mod = folder.notes.modificationDate(), cre = folder.notes.creationDate();
    const locked = folder.notes.passwordProtected();
    const text = withText ? folder.notes.plaintext() : null;
    const fid = folder.id();
    if (!folders[fid] || name.length > folders[fid].path.length) {
      folders[fid] = { name: folder.name(), path: name, account: account, notes: ids.length };
    }
    for (let i = 0; i < ids.length; i++) {
      if (seen[ids[i]]) continue;
      seen[ids[i]] = 1;
      const note = { id: ids[i], title: titles[i], folder: name, account: account, locked: locked[i],
        modified: mod[i].toISOString(), created: cre[i].toISOString() };
      if (withText && !locked[i]) note.text = text[i];
      out.push(note);
    }
    for (const sub of folder.folders()) walk(sub, account, name);
  }
  for (const a of Notes.accounts()) for (const f of a.folders()) walk(f, a.name(), "");
  return JSON.stringify({ notes: out, folders: Object.values(folders) });
}`;

const GET_JXA = `
function run(argv) {
  const n = Application("Notes").notes.byId(argv[0]);
  const locked = n.passwordProtected();
  return JSON.stringify({ id: n.id(), title: n.name(), locked: locked, attachments: n.attachments.length,
    html: locked ? "" : n.body(), text: locked ? "" : n.plaintext(),
    modified: n.modificationDate().toISOString(), created: n.creationDate().toISOString() });
}`;

// argv: folder name ("" = default), account name ("" = any / default), body HTML.
const CREATE_JXA = `
function run(argv) {
  const Notes = Application("Notes");
  const folderName = argv[0].toLowerCase(), accountName = argv[1].toLowerCase();
  const accounts = Notes.accounts().filter(a => !accountName || a.name().toLowerCase() === accountName);
  if (!accounts.length) throw new Error("Account not found: " + argv[1] + ". Accounts: " + Notes.accounts().map(a => a.name()).join(", "));
  let target = null, targetAccount = null, names = [];
  function walk(f, a) {
    names.push(a.name() + "/" + f.name());
    if (!target && f.name().toLowerCase() === folderName && f.name() !== "${TRASH}") { target = f; targetAccount = a; }
    for (const sub of f.folders()) walk(sub, a);
  }
  if (folderName) for (const a of accounts) for (const f of a.folders()) walk(f, a);
  else { targetAccount = accountName ? accounts[0] : Notes.defaultAccount(); target = targetAccount.defaultFolder(); }
  if (!target) throw new Error("Folder not found: " + argv[0] + ". Folders: " + names.join(", "));
  const n = Notes.Note({ body: argv[2] });
  target.notes.push(n);
  return JSON.stringify({ id: n.id(), title: n.name(), folder: target.name(), account: targetAccount.name() });
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

const readIndex = (withText = false) => jxa(INDEX_JXA, [withText ? "text" : ""]);
const listNotes = async () => (await readIndex()).notes;
const readNote = (id) => jxa(GET_JXA, [id]);

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
  const { notes } = await readIndex(withText);
  const f = folder ? norm(folder) : null;
  const hits = [];
  for (const n of notes) {
    if (n.locked) continue; // locked notes stay private, titles included
    if (!include_deleted && n.folder === TRASH) continue;
    if (f && !norm(n.folder).includes(f)) continue;
    const { locked, text, ...note } = n;
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
  return { folders: folders.map((f) => (f.name === TRASH ? { ...f, read_only: true } : f)) };
}

// ---------- Note body: Apple Notes HTML -> Markdown ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// Notes often omits the closing ";" (e.g. "&lt"), so it is optional for the names we know.
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);?/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1))
    : ENTITIES[e.toLowerCase()]);

function htmlToMarkdown(html) {
  let s = String(html).replace(/[\r\n]/g, ""); // Notes marks lines with <div>/<br>; raw newlines mean nothing
  let img = 0; // numbered so the AI can match each [image N] to the N-th image get_note returns
  s = s.replace(/<img\b[^>]*>/gi, () => `[image ${++img}]`).replace(/<object\b[\s\S]*?<\/object>/gi, "[attachment]");
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
  s = s.replace(/<tr\b[^>]*>/gi, "\n|").replace(/<\/td>/gi, " |").replace(/<td\b[^>]*>/gi, " ");
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

async function getNote({ id, title, format = "markdown", max_images = 5 } = {}) {
  if (!id && !title) throw new Error("Pass `id` (from search_notes) or `title`.");
  let match = null;
  if (!id) {
    const { results } = await searchNotes({ query: title, limit: 5, search_text: false });
    if (!results.length) throw new Error(`No note title matches "${title}".`);
    [match] = results;
    id = match.id;
  }
  const n = await readNote(id);
  if (n.locked) throw new Error("This note is locked. Locked notes cannot be read.");
  const meta = match ?? (await listNotes()).find((x) => x.id === id) ?? {};
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

async function createNote({ title, content = "", folder = "", account = "" } = {}) {
  if (!String(title ?? "").trim()) throw new Error("`title` is required.");
  const body = noteBody(title.trim(), content);
  return writeWithImages(body, () => jxa(CREATE_JXA, [folder, account, body]));
}

async function updateNote({ id, content, mode = "append" } = {}) {
  if (!id) throw new Error("Pass `id` from search_notes. Updates need an exact id, not a title.");
  if (!String(content ?? "").trim()) throw new Error("`content` is required.");
  if (!["append", "replace"].includes(mode)) throw new Error("`mode` must be append or replace.");
  const [n, all] = await Promise.all([readNote(id), listNotes()]);
  if (all.find((x) => x.id === id)?.folder === TRASH) throw new Error("This note is in Recently Deleted. It cannot be edited.");
  if (n.locked) throw new Error("This note is locked. Unlock it in Notes first.");
  if (n.attachments) {
    throw new Error(`This note has ${n.attachments} attachment(s). Editing would remove them, because Notes rewrites the whole body. Create a new note instead, or edit this one in Notes.`);
  }
  const body = mode === "append" ? `${n.html}\n${markdownToHtml(content)}` : noteBody(n.title, content);
  mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id.split("/").pop()}.html`);
  writeFileSync(backup, n.html);
  return { ...(await writeWithImages(body, () => jxa(SET_BODY_JXA, [id, body]))), mode, backup };
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
        title: { type: "string", description: "Used when id is not given; reads the best title match." },
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
        folder: { type: "string", description: "Exact folder name (case-insensitive). Default: the default Notes folder." },
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
];

const HANDLERS = { search_notes: searchNotes, get_note: getNote, list_folders: listFolders, create_note: createNote, update_note: updateNote };

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize": {
      const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return { protocolVersion: v, capabilities: { tools: {} }, serverInfo: SERVER,
        instructions: "Find notes with search_notes (titles and text), then read one with get_note using the returned id. list_folders shows where notes live. Write with create_note or update_note (needs the id). Notes cannot be deleted." };
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
  apple-notes-plugin create <title> [--content MARKDOWN] [--folder NAME] [--account NAME]
  apple-notes-plugin update <id> --content MARKDOWN [--mode append|replace]

Search matches titles first, then note text. --content - reads Markdown from stdin.
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
