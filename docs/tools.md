# Tools reference

| Tool                            | What it does                                         | Changes notes? |
| ------------------------------- | ---------------------------------------------------- | :------------: |
| [`search_notes`](#search_notes) | Finds notes by title and text in all accounts and folders |       No       |
| [`get_note`](#get_note)         | Reads one note as Markdown, plain text or HTML            |       No       |
| [`list_folders`](#list_folders) | Lists every folder and how many notes it holds            |       No       |
| [`create_note`](#create_note)   | Creates a new note from Markdown                          |      Yes       |
| [`update_note`](#update_note)   | Adds to the end of a note, or replaces its content        |      Yes       |
| [`health`](#health)             | Checks access to Notes and counts notes                   |       No       |

There is no delete tool, on purpose.

Notes you hide (tagged `#private`, or in a folder listed in `APPLE_NOTES_EXCLUDE`) are invisible to every tool. See [Keep notes away from your AI](../README.md#keep-notes-away-from-your-ai).

## `search_notes`

| Input             | Default | Description                                                  |
| ----------------- | ------- | ------------------------------------------------------------ |
| `query`           | `""`    | Words to find. Empty lists the most recent notes.            |
| `limit`           | `20`    | Maximum results (1–200).                                     |
| `folder`          | all     | Only folders whose path contains this text.                  |
| `search_text`     | `true`  | Also search the text inside notes. `false` for titles only.  |
| `include_deleted` | `false` | Also search *Recently Deleted*.                              |

Results come back best match first.
Title matches always come before text matches:

1. Exact title: `kubernetes` → *Kubernetes*
2. Title starts with the query: `kube` → *Kubernetes cheatsheet…*
3. The query appears as a phrase in the title
4. All words appear in the title, in any order, small typos allowed: `stagng deploy` → *Deploy steps for staging…*
5. The query appears as a phrase in the note's text
6. All words appear in the note's text, in any order

Text matches need each word to start a word in the note, so `cat` finds *category* but not *concat*.
Typos are allowed in titles only, because in long text they would match too much.

Case and accents are ignored. Equal matches are sorted newest first. Each result has an `id` for the other tools.
When the query is not empty, each result has `matched_in`, either `title` or `text`.
Text matches also have a `snippet`: about 160 characters around the match, so your AI can tell whether the note is worth opening without reading all of it.

Searching text is fast, because the plugin reads the text of a whole folder in one call to Notes.
On a library of about 270 notes, a search takes about half a second.
Locked notes never appear, and their contents are never shown to your AI.

## `get_note`

| Input    | Description                                             |
| -------- | ------------------------------------------------------- |
| `id`     | Note id from `search_notes`. Exact.                     |
| `title`  | Used when there is no `id`. Reads the best title match. If two or more notes match equally well, nothing is read: the error lists their ids, folders and dates, so your AI can pick one. |
| `format` | `markdown` (default), `text` or `html`                  |
| `max_images` | How many of the note's images to return, in order. Default `5`, maximum `20`, `0` for none. |

Markdown keeps headings, lists, bold, italic, code and tables.

**Images.** The note's images come back as real images that your AI can look at. In the text, `[image 1]`, `[image 2]` and so on mark where each one sits. Images past `max_images` are still marked in the text but not sent. So are HEIC and TIFF images, because AI tools cannot read those formats. Other attachments, such as PDFs, show as `[attachment]`.

## `list_folders`

Takes no input.
Returns every folder in every account, with:

| Field       | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `name`      | The folder's name. Pass this as `folder` to `create_note`.        |
| `path`      | Full path for nested folders, such as `Work/Clients`.             |
| `account`   | The account it belongs to, such as `iCloud`.                      |
| `notes`     | How many notes it holds.                                          |
| `read_only` | `true` for *Recently Deleted*, where nothing can be created.      |

## `create_note`

| Input     | Description                                                     |
| --------- | --------------------------------------------------------------- |
| `title`   | **Required.** Becomes the first line of the note.               |
| `content` | Body in Markdown. Can include [images](#adding-images).         |
| `folder`  | Folder name, or a full path such as `Work/Clients`. Default: your default Notes folder. |
| `account` | Account name, such as `iCloud`. Default: your default account.  |

If the folder name exists in more than one place, for example *Notes* in both iCloud and On My Mac, the note is not created. The error lists each match. Pass `account`, or the full path as `folder`.

## `update_note`

| Input     | Description                                                                          |
| --------- | ------------------------------------------------------------------------------------ |
| `id`      | **Required.** Note id from `search_notes`. A title is not accepted.                  |
| `content` | **Required.** Markdown to add, or the new body.                                      |
| `mode`    | `append` (default) adds to the end. `replace` replaces everything under the title.   |

Before each edit, the old note is saved to `~/.apple-notes-mcp/backups/`. To restore one, open the `.html` file in a browser and copy the content back into Notes.

## `health`

Takes no input. Call it when a search returns nothing that should exist, or when a call fails.
Every failure looks the same from outside, "no results", and `health` tells them apart.

| Field                     | Description                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| `ok`, `notes_access`      | Whether the plugin can reach Notes. On failure, `error` says what to fix.   |
| `accounts`                | Each account, with its folder and note counts, and which is the default.    |
| `notes`                   | Totals: `visible`, `locked`, `hidden_private_tag`, `hidden_excluded_folder`, `in_recently_deleted`. |
| `excluded_folders`        | The folder names in `APPLE_NOTES_EXCLUDE`.                                  |
| `unmatched_exclusions`    | Excluded names that match no folder. Usually a typo.                        |
| `recently_deleted_folder` | The name of *Recently Deleted* in your macOS language.                      |
| `version`, `node`, `backups` | Plugin version, Node.js version, and the backup folder.                  |

`health` never fails itself. A problem shows up in its result, not as an error.

## Adding images

Put each image on its own line, using Markdown image syntax and the image's full path:

```markdown
Here is the error:
![screenshot](/Users/me/Desktop/error.png)
```

- **Formats:** PNG, JPEG, GIF, HEIC and TIFF.
- **Paths:** use an absolute path. `~/` works too. Spaces and accents are fine. Wrap a path in `<…>` if it contains `)`.
- **Local files only.** URLs are refused, because the plugin makes no network calls.
- **Position:** each image appears exactly where its line is.

After the write, the plugin checks that Notes really imported each image. The result has `images_added`. If any failed, it also has `images_failed` and a `warning`.

The plugin gives Notes read access to exactly the image files you name, until Notes quits. Notes needs this because it is sandboxed.

After you add an image with `update_note`, the note has an attachment. So later `update_note` calls on that note are refused, by the [attachment rule](../README.md#safety). Put all text and images in one call, or use `create_note`.

## Supported Markdown

| Markdown                             | In Notes                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `# Heading`, `## Heading`            | Large and medium bold text                                                                   |
| `- item`, `1. item`                  | Bulleted and numbered lists                                                                  |
| `**bold**`, `_italic_`, `~~strike~~` | Same styles                                                                                  |
| `` `code` `` and fenced code blocks  | Monospaced text                                                                              |
| `[text](https://…)`                  | `text (https://…)`. Notes removes link targets added by scripts, so the URL is kept as text. |
| `- [ ] task`                         | Plain bullet. Notes checklists are not supported.                                            |
| `![caption](/path/to/image.png)`     | The image, at that spot. Must be on its own line. See [Adding images](#adding-images).       |

## Command line

Every tool is also a command. Output is JSON.

```bash
npx -y apple-notes-plugin search "launch plan" --limit 5
npx -y apple-notes-plugin search "" --folder Work                 # recent notes in "Work"
npx -y apple-notes-plugin search "invoice" --titles-only          # skip the text inside notes
npx -y apple-notes-plugin folders                                 # every folder, with note counts
npx -y apple-notes-plugin health                                  # access check and note counts
npx -y apple-notes-plugin get "launch plan"                       # best title match, as Markdown
npx -y apple-notes-plugin get "x-coredata://…/ICNote/p123" --format text
npx -y apple-notes-plugin create "Deploy checklist" --content "- run migrations
- tag the release"
npx -y apple-notes-plugin update "x-coredata://…/ICNote/p123" --content "- tell on-call"
npx -y apple-notes-plugin create "Bug 412" --content "![](/Users/me/Desktop/error.png)"
cat notes.md | npx -y apple-notes-plugin update "x-coredata://…" --mode replace --content -
```

`--content -` reads the Markdown from standard input. A terminal cannot show images, so `get` saves them to a temporary folder and lists the files in `image_files`. Use `--max-images N` to change how many. Run `npx -y apple-notes-plugin --help` to see every option.
