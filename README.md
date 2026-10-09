# Claude Draft

**Write and revise temporary documents in Claude Code without putting draft files in your project.**

Claude Draft is a **Claude Code Mod (plugin)** that adds a document-centric editor for iterative prose writing. Create a draft, ask Claude to change just one paragraph, inspect the result, compare versions, undo, and copy or export the finished text when *you* decide.

> Status: **0.1.0 — initial implementation.** The domain model and a mocked Mod integration are tested. Live Claude Code load/UI testing is still required; see [Verification](#verification).

日本語: [使い方](#日本語ガイド)

## Why

A chat reply is a poor editing surface when you want to revise the *same* document many times. Creating a tracked project file for a one-off announcement, email, product description or note is unnecessary.

Claude Draft provides a temporary **Document → Revision** model. The document is what you select and operate on; tools are an implementation detail.

## Object-oriented UI (OOUI)

```
Draft Library
  ├── Document: Product introduction   [select]
  │     ├── Content                    [preview / ask Claude to edit]
  │     ├── Revisions                  [history / compare / restore]
  │     └── Actions                    [rename / undo / redo / copy / export / discard]
  └── Document: Follow-up email        [select]
```

- **Objects are primary:** each draft has an identity, title, content and revision history.
- **Actions are contextual:** actions apply to the selected document, not to an unspecified file.
- **One consistent editing model:** tool edits, chat requests and pane actions update the same document state.
- **Progressive disclosure:** preview first; diff, history, export and destructive actions are secondary.
- **Reversible by default:** revisions, Undo/Redo and restore; discarding requires explicit confirmation.
- **Explicit output boundary:** drafts are not project files. Only `Copy` or `Export` moves the content out.

The UI is a Claude Code pane and works in the interactive terminal and the Code tab of Claude Desktop. A command-only fallback is available for sessions without pane rendering.

## Installation

Requires Claude Code **2.1.287 or newer** (Mods support). Mod APIs are early access and may change with Claude Code versions.

For a one-session local trial, clone this repository and run:

```sh
claude --plugin-dir ./claude-draft
```

Or install from the repository marketplace:

```text
/plugin marketplace add YmSaki/claude-draft
/plugin install claude-draft@ym-claude-draft
```

Start a new session or run `/reload-plugins` after installing. In `/plugin` check that **claude-draft** is active.

## Quick start

```text
/draft new Product introduction
```

Then say something like:

```text
Write a 150-word introduction for my product into the active draft.
Make the second paragraph more concrete. Keep all other paragraphs unchanged.
Undo the last change.
```

Claude can call Claude Draft's `draft_read`, `draft_edit`, `draft_write` and `draft_undo` tools. `draft_edit` replaces **one unique exact passage** and refuses ambiguous or stale edits; it does not regenerate or rewrite unrelated paragraphs.

Open the pane at any time with `/draft`. Choose a document, see the current text and its version, or send a new editing request directly from the pane.

### User commands

| Command | What it does |
| --- | --- |
| `/draft` or `/draft list` | Open document picker and list drafts |
| `/draft new <title>` | Create a selected empty temporary document |
| `/draft open <id>` | Select a document and open its preview |
| `/draft show` | Show the complete selected document in chat output |
| `/draft history` | Open revision history |
| `/draft undo`, `/draft redo` | Move backward or forward in revisions |
| `/draft restore <version>` | Restore a saved version as a **new** revision |
| `/draft copy` | Copy the selected document's content to clipboard |
| `/draft save <relative/path.md>` | Explicitly export to a **new** `.md` or `.txt` file |
| `/draft discard confirm` | Permanently remove selected draft and its history |

For long text, the preview shows the first 9,000 characters; copying, `/draft show` and export use the full text. The pane also provides buttons for new, rename, copy, undo, redo, export and two-step discard; a document picker; a history tab; a changes tab; and an input for talking to Claude about the selected document.

### Model tools

The plugin registers `draft_list`, `draft_create`, `draft_read`, `draft_edit`, `draft_write`, `draft_rename`, `draft_history`, `draft_restore` and `draft_undo`. These are available to Claude as `mcp__claude-draft__draft_*`.

- `draft_edit`: one **unique exact match**, `oldText` → `newText`. Requires `expectedVersion` from `draft_read` to prevent stale edits. No substring guesswork or fuzzy replacements.
- `draft_write`: replace the **entire** body, with an expected version. Use for an empty draft or user-requested full rewrite, not for local edits.
- `draft_restore`: restore an earlier revision without deleting the current history.
- The model is **not** given an export or discard tool. Those boundaries belong to the person using the editor.

## Data, privacy and safety

- The plugin does **not** create draft files in the project directory. It stores document state per Claude Code session in Claude Code's **local plugin store**, which is persisted on disk under the user's Claude configuration and is **not encrypted by this plugin**. This supports hot reload and session resumption; it is not memory-only storage.
- Documents are not uploaded or sent to a custom server by this plugin; it makes no HTTP requests, starts no shell commands, and does not inspect the repository. Claude will still receive draft content when its own draft tools read that content, subject to the user's Claude Code setup.
- The user must explicitly copy, export or discard a document. The plugin does not automatically commit anything or overwrite tracked files.
- Export accepts only relative `.md`/`.txt` paths with no traversal or hidden path segments. It checks whether the destination exists before writing and refuses one already present. **The Mods file API does not offer an atomic create-only operation**: another process could create a file between this check and the write. Do not export into directories with untrusted concurrent writers.
- Revision history is bounded: at most **12 documents**, **12 revisions per document**, **96 KiB UTF-8 per document revision**, and **1 MiB of serialized state per session**. Earlier revisions drop off once the history limit is reached.
- Drafts from other sessions are eligible for cleanup **7 days after their last change**, when the plugin next starts. The cleanup is best-effort: it is not guaranteed to run if Claude Code is never started again. To remove sensitive content promptly, use `/draft discard confirm` for each document.
- Saved data with an invalid schema is **not silently reset**. The plugin refuses mutations and reports a recovery error instead of destroying existing drafts.

Mods run with the same permissions as Claude Code itself. **Review the source of any Mod before installing it**, especially in a sensitive environment.

## Verification

Run the local tests (no external dependencies needed):

```sh
npm test
```

The tests cover document identity, unique-match editing, stale version refusal, undo/redo, history restore, path validation, export behavior, UI actions, store recovery and model-tool orchestration using a mocked Mods runtime.

When Claude Code CLI is available, additionally run **on the target Claude version**:

```sh
claude plugin validate ./
claude plugin test ./
claude --plugin-dir ./
```

Interactively test `/draft new`, the pane's Document/Changes/History tabs, model edits, copy, export, discard and session resume on both terminal and Desktop if available. `claude plugin validate` and real engine UI tests **have not been run in the environment used to prepare this repository**.

## 日本語ガイド

Claude Codeで**プロジェクトに下書きファイルを増やさず**、チャットから文章を繰り返し推敲するプラグインです。

1. `/draft new お知らせ` で一時ドキュメントを作成します。
2. 「文章を作って」「2段落目をもっと具体的にして。他の段落はそのまま」などと指示します。
3. `/draft` でペインを開き、本文・変更箇所・履歴を確認します。
4. Undo/Redoや履歴復元で編集を戻せます。
5. 完成したら `/draft copy` か `/draft save お知らせ.md` で出力します。不要になったら `/draft discard confirm` で削除します。

本文と履歴はClaude Codeのローカルなプラグインストアに一時保存され、プロジェクトファイルやGitには自動で追加されません。ストアは暗号化されず、明示的に破棄するまで残り得る点に注意してください。

## License

Apache-2.0 — see [LICENSE](LICENSE).
