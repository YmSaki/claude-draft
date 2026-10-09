// Copyright 2026 claude-draft contributors. Apache-2.0.
// Claude Code Mod: a temporary, object-oriented document editor.
// No network access, shell execution, or automatic workspace file writes.
import {
  DraftError, emptyLibrary, validateLibrary, applyAction,
  getDraft, current, readDraft, listDrafts, historyOf, safeExportPath,
} from './draft-core.mjs';

const PANE = 'claude-draft';
const PREFIX = 'draft-session-v1:';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TOOL_PREFIX = 'mcp__claude-draft__';
const idArg = { type: 'string', description: 'Draft id from draft_list. Omit to use active draft.' };
const versionArg = { type: 'integer', minimum: 1, description: 'Current version from draft_read (guards against stale edits).' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = [
  {
    name: 'draft_list',
    description: 'List temporary draft documents in this Claude Code session. Use these documents when writing or revising text without creating project files.',
    inputSchema: schema({}),
  },
  {
    name: 'draft_create',
    description: 'Create a NEW temporary draft document and select it. For user-requested iterative writing, draft creation, copy revisions and other prose tasks without workspace files. Does not write project files. After creating, edit by calling draft_edit or draft_write.',
    inputSchema: schema({ title: { type: 'string' }, content: { type: 'string', description: 'Optional initial text (max 96 KiB).' } }),
  },
  {
    name: 'draft_read',
    description: 'Read the complete current text of a draft and its version. Always call this before an edit, especially if it has been revised in another turn.',
    inputSchema: schema({ id: idArg }),
  },
  {
    name: 'draft_edit',
    description: 'Safely edit ONE uniquely matching exact passage in a temporary draft, leaving everything else unchanged. No project file writes. If a passage occurs more than once, use a longer unique excerpt. Call draft_read first and pass expectedVersion.',
    inputSchema: schema({ id: idArg, oldText: { type: 'string' }, newText: { type: 'string' }, expectedVersion: versionArg, note: { type: 'string' } }, ['oldText', 'newText', 'expectedVersion']),
  },
  {
    name: 'draft_write',
    description: 'Replace the ENTIRE draft text with a new version. Use when the user explicitly requests a full rewrite or is first filling an empty draft; prefer draft_edit for partial changes. Does not write project files. Read first and pass expectedVersion.',
    inputSchema: schema({ id: idArg, content: { type: 'string' }, expectedVersion: versionArg, note: { type: 'string' } }, ['content', 'expectedVersion']),
  },
  {
    name: 'draft_rename',
    description: 'Change a temporary draft document title without changing its text.',
    inputSchema: schema({ id: idArg, title: { type: 'string' } }, ['title']),
  },
  {
    name: 'draft_history',
    description: 'List the saved versions of one temporary draft document. Versions can be restored via draft_restore.',
    inputSchema: schema({ id: idArg }),
  },
  {
    name: 'draft_restore',
    description: 'Restore text from a specific historical draft version, creating a new version (previous versions stay available). Do this only when the user asks.',
    inputSchema: schema({ id: idArg, version: { type: 'integer', minimum: 1 } }, ['version']),
  },
  {
    name: 'draft_undo',
    description: 'Undo or redo an editing action in the active temporary draft. Use when the user requests undo/redo.',
    inputSchema: schema({ id: idArg, direction: { type: 'string', enum: ['undo', 'redo'] } }, ['direction']),
  },
];

function errorMessage(error) {
  return error instanceof DraftError ? `${error.code}: ${error.message}` : `Draft operation failed: ${String(error?.message || error)}`;
}

export function register(on) {
  let library = emptyLibrary();
  let storeKey;
  let loadError = null;
  let queue = Promise.resolve();
  let tab = 'document';
  let form = '';
  let confirmId = null;
  let inspectedVersion = null;

  const redraw = ($) => $.ui.invalidate('ui.render');
  const requireReady = () => { if (loadError) throw loadError; if (!storeKey) throw new Error('Draft store has not been initialized.'); };
  const selected = () => library.activeId ? readDraft(library) : null;

  // Serializes writes within this session, and publishes state only after the store commit.
  function change($, action) {
    const run = queue.then(async () => {
      requireReady();
      const now = await $.clock.now();
      const { state, result } = applyAction(library, action, now, () => crypto.randomUUID());
      if (state.drafts.length === 0) await $.store.delete(storeKey);
      else await $.store.set(storeKey, state);
      library = state;
      inspectedVersion = null;
      redraw($);
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  async function load($) {
    storeKey = PREFIX + await $.session.id();
    const saved = await $.store.get(storeKey);
    if (saved !== undefined) {
      library = validateLibrary(saved);
    }
    // Best effort cleanup of drafts from expired sessions. Never search project files.
    const now = await $.clock.now();
    const keys = await $.store.keys();
    for (const key of keys.filter((x) => x.startsWith(PREFIX) && x !== storeKey).slice(0, 32)) {
      const old = await $.store.get(key);
      if (old && typeof old.updatedAt === 'number' && now - old.updatedAt > RETENTION_MS) {
        await $.store.delete(key);
      }
    }
  }

  async function openPane($) {
    await $.ui.open({ id: PANE, title: 'Drafts', focus: true, closeOnEscape: true, rows: 20 });
  }

  async function exportDraft($, pathInput) {
    requireReady();
    const path = safeExportPath(pathInput);
    const draft = selected();
    if (!draft) throw new DraftError('NO_ACTIVE_DRAFT', 'Select a document first.');
    if (await $.fs.exists(path)) throw new DraftError('FILE_EXISTS', `Refusing to overwrite ${path}. Choose a new filename.`);
    await $.fs.write(path, draft.content);
    return path;
  }

  function identify(ref) {
    if (!ref) return library.activeId;
    const byId = library.drafts.find((x) => x.id === ref);
    if (byId) return byId.id;
    const byTitle = library.drafts.filter((x) => x.title.toLocaleLowerCase() === ref.toLocaleLowerCase());
    if (byTitle.length === 1) return byTitle[0].id;
    if (byTitle.length > 1) throw new DraftError('AMBIGUOUS_TITLE', 'Several drafts have that title. Select a draft id.');
    throw new DraftError('NOT_FOUND', 'No matching draft. Run /draft list.');
  }

  on('session.start', async ($, e, next) => {
    try { await load($); } catch (error) { loadError = error; $.ui.log(`Draft recovery error: ${errorMessage(error)}`); }
    // Register tools even after a recovery error: calls return explicit errors instead of losing data.
    for (const t of tools) await $.tool.register(t);
    await $.command.register({ name: 'draft', description: 'Manage temporary text documents, versions and export', argumentHint: '[new|list|open|undo|redo|history|copy|save|discard]' });
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    if (!library.activeId || loadError) return next(e);
    const active = selected();
    return next({
      ...e,
      context: [...(e.context ?? []),
        `Claude Draft: Active temporary document id=${active.id}, title=${JSON.stringify(active.title)}, version=${active.version}. When the user refers to this document or asks for a prose revision, read it with mcp__claude-draft__draft_read and edit using draft_edit (exact unique passage) or draft_write (whole rewrite). Do not create project files. Saving/exporting a file requires the user's explicit /draft save action.`],
    });
  });

  const handlers = {
    draft_list: async () => ({ documents: listDrafts(library), activeId: library.activeId }),
    draft_create: ($, e) => change($, { type: 'create', title: e.title || 'Untitled draft', content: e.content ?? '' }),
    draft_read: async (_, e) => readDraft(library, e.id),
    draft_edit: ($, e) => change($, { type: 'edit', id: e.id, oldText: e.oldText, newText: e.newText, expectedVersion: e.expectedVersion, note: e.note }),
    draft_write: ($, e) => change($, { type: 'write', id: e.id, content: e.content, expectedVersion: e.expectedVersion, note: e.note }),
    draft_rename: ($, e) => change($, { type: 'rename', id: e.id, title: e.title }),
    draft_history: async (_, e) => historyOf(library, e.id),
    draft_restore: ($, e) => change($, { type: 'restore', id: e.id, version: e.version }),
    draft_undo: ($, e) => change($, { type: e.direction, id: e.id }),
  };
  for (const [name, handle] of Object.entries(handlers)) {
    on('tool.call', { tool: TOOL_PREFIX + name }, async ($, e) => {
      try {
        requireReady();
        const result = await handle($, e);
        return { result: JSON.stringify({ ok: true, ...result }) };
      } catch (error) {
        return { result: JSON.stringify({ ok: false, error: errorMessage(error) }) };
      }
    });
  }

  on('command.run', { command: 'draft' }, async ($, e) => {
    try {
      requireReady();
      const args = String(e.args || '').trim();
      const space = args.indexOf(' ');
      const command = (space < 0 ? args : args.slice(0, space)).toLocaleLowerCase();
      const rest = space < 0 ? '' : args.slice(space + 1).trim();
      if (!command || command === 'list') {
        await openPane($);
        return { text: listDrafts(library).length ? listDrafts(library).map((d) => `${d.active ? '* ' : '  '}${d.id} | ${d.title} | v${d.version}`).join('\n') : 'No drafts yet. Use /draft new <title>.' };
      }
      if (command === 'new') {
        const doc = await change($, { type: 'create', title: rest || 'Untitled draft' });
        tab = 'document'; form = '';
        await openPane($);
        return { text: `Created temporary draft '${doc.title}' (id ${doc.id}, v1). Ask Claude to write or edit it without creating workspace files.` };
      }
      if (command === 'open') {
        if (rest) await change($, { type: 'select', id: identify(rest) });
        await openPane($);
        return { text: selected() ? `Opened ${selected().title} (v${selected().version}).` : 'No active draft; create one with /draft new <title>.' };
      }
      if (command === 'show') {
        await openPane($);
        const d = selected();
        return { text: d ? `${d.title} (v${d.version})\n\n${d.content}` : 'No active draft.' };
      }
      if (command === 'undo' || command === 'redo') {
        const d = await change($, { type: command });
        return { text: `${d.title} is now at v${d.version}.` };
      }
      if (command === 'history') {
        await openPane($); tab = 'history'; redraw($);
        const h = historyOf(library);
        return { text: `${h.title}: ${h.revisions.map((v) => `v${v.version}${v.current ? ' (current)' : ''}`).join(', ')}` };
      }
      if (command === 'restore') {
        const v = Number(rest);
        if (!Number.isInteger(v)) throw new DraftError('INVALID_INPUT', 'Usage: /draft restore <version>');
        const d = await change($, { type: 'restore', version: v });
        return { text: `Restored ${d.title} from v${v} (now v${d.version}).` };
      }
      if (command === 'copy') {
        const d = selected(); if (!d) throw new DraftError('NO_ACTIVE_DRAFT', 'No active draft.');
        const copied = await $.ui.copy({ text: d.content });
        return { text: copied.isCopied ? `Copied ${d.title}.` : `Clipboard unavailable: ${copied.reason || 'unknown reason'}` };
      }
      if (command === 'save') {
        const filename = await exportDraft($, rest);
        return { text: `Saved ${filename} (new file, no overwrite). Your draft remains editable.` };
      }
      if (command === 'discard') {
        if (rest !== 'confirm') throw new DraftError('CONFIRM_REQUIRED', 'To permanently discard the active draft, type /draft discard confirm.');
        const d = selected(); if (!d) throw new DraftError('NO_ACTIVE_DRAFT', 'No active draft.');
        await change($, { type: 'discard' });
        return { text: `Discarded temporary draft '${d.title}'.` };
      }
      return { text: 'Usage: /draft [new <title>|list|open <id>|show|history|undo|redo|restore <version>|copy|save <path.md>|discard confirm]' };
    } catch (error) { return { text: errorMessage(error) }; }
  });

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text, Button, Input, Select, Markdown } = $.ui.resolve(e);
    const label = (value, bold = false) => Text({ children: [value], bold });
    const column = (children, extras = {}) => Box({ flexDirection: 'column', rowGap: 1, children, ...extras });
    const row = (children) => Box({ flexDirection: 'row', columnGap: 2, flexWrap: 'wrap', children });
    const run = (fn) => async () => {
      try { await fn(); } catch (error) { $.ui.toast(errorMessage(error)); }
    };
    const button = (key, text, fn, plain = false) => Button({ key, label: text, plain, onPress: run(fn) });
    const refresh = () => redraw($);
    const docs = listDrafts(library);
    const currentDoc = selected();
    const children = [
      row([ label('Claude Draft', true), label('Temporary documents · local only') ]),
      row([ button('create', '+ New', () => { form = 'new'; refresh(); }),
        button('close', 'Close', () => $.ui.close({ id: PANE })) ]),
    ];
    if (loadError) return column([...children, label(errorMessage(loadError)), label('Recovery failed. Existing data has not been changed.')]);
    if (docs.length) {
      children.push(Select({
        key: 'document-list', label: 'Document', value: library.activeId,
        options: docs.map((d) => ({ value: d.id, label: `${d.title} · v${d.version}` })),
        onSelect: (id) => { void run(async () => { await change($, { type: 'select', id }); tab = 'document'; form = ''; })(); },
      }));
    }
    if (form === 'new') {
      children.push(Input({ key: 'new-title', label: 'New draft title', placeholder: 'Untitled draft', value: '', submitLabel: 'Create',
        onSubmit: (value) => { void run(async () => { await change($, { type: 'create', title: value || 'Untitled draft' }); form = ''; tab = 'document'; })(); },
      }));
    }
    if (!currentDoc) {
      children.push(label('No draft selected. Create one to begin writing without project files.'));
      return column(children, { paddingX: 1 });
    }
    const model = getDraft(library);
    children.push(row([
      label(`${currentDoc.title}`, true), label(`v${currentDoc.version} · ${currentDoc.length} chars`),
      button('rename', 'Rename', () => { form = 'rename'; refresh(); }, true),
    ]));
    children.push(row([
      button('tab-document', tab === 'document' ? '[Document]' : 'Document', () => { tab = 'document'; refresh(); }, true),
      button('tab-changes', tab === 'changes' ? '[Changes]' : 'Changes', () => { tab = 'changes'; refresh(); }, true),
      button('tab-history', tab === 'history' ? '[History]' : 'History', () => { tab = 'history'; refresh(); }, true),
    ]));
    if (form === 'rename') {
      children.push(Input({ key: 'rename-title', label: 'Rename', value: currentDoc.title, submitLabel: 'Rename',
        onSubmit: (value) => { void run(async () => { await change($, { type: 'rename', title: value }); form = ''; })(); },
      }));
    }
    if (tab === 'document') {
      if (!currentDoc.content) {
        children.push(label('(Empty document. Ask Claude to write into this draft.)'));
      } else {
        // Claude Code's Markdown component has a 10,000-character limit.
        const preview = currentDoc.content.slice(0, 9000);
        children.push(Markdown({ key: 'document-preview', text: preview }));
        if (preview.length < currentDoc.content.length) {
          children.push(label(`Preview limited to 9,000 characters; ${currentDoc.content.length - preview.length} more characters remain. Copy, /draft show or export includes the full document.`));
        }
      }
      children.push(Input({ key: 'edit-instruction', label: 'Ask Claude to edit', placeholder: 'e.g. Rewrite only the second paragraph', value: '', submitLabel: 'Send',
        onSubmit: (value) => { void run(async () => {
          if (!value.trim()) return;
          await $.prompt.submit({
            text: `Edit the temporary document '${currentDoc.title}' (draft id ${currentDoc.id}). ${value.trim()} Read the active draft and use claude-draft tools. Do not create or edit workspace files.`,
            asUser: true,
          });
        })(); },
      }));
    }
    if (tab === 'changes') {
      if (model.cursor === 0) children.push(label('No earlier revision to compare.'));
      else {
        const previous = model.revisions[model.cursor - 1].text;
        const after = currentDoc.content;
        const d = changeFragment(previous, after);
        children.push(label(`v${model.revisions[model.cursor - 1].version} → v${currentDoc.version}`));
        children.push(label('Removed:', true), Text({ color: 'red', children: [d.before || '(none)'] }));
        children.push(label('Added:', true), Text({ color: 'green', children: [d.after || '(none)'] }));
        if (d.trimmed) children.push(label('Large changes truncated in comparison only; full text remains intact.'));
      }
    }
    if (tab === 'history') {
      const h = historyOf(library);
      children.push(...h.revisions.slice().reverse().map((v) => button(`rev-${v.version}`,
        `${v.current ? '●' : '○'} v${v.version} · ${v.note} · ${v.length} chars`,
        () => { inspectedVersion = v.version; refresh(); }, true)));
      if (inspectedVersion !== null) {
        const found = model.revisions.find((r) => r.version === inspectedVersion);
        if (found) {
          children.push(label(`Selected v${found.version}:`));
          children.push(label(found.text.slice(0, 1400) || '(empty)'));
          children.push(button('restore', 'Restore as new revision', async () => { await change($, { type: 'restore', version: found.version }); tab = 'document'; }));
        }
      }
    }
    children.push(row([
      ...(currentDoc.canUndo ? [button('undo', 'Undo', () => change($, { type: 'undo' }))] : []),
      ...(currentDoc.canRedo ? [button('redo', 'Redo', () => change($, { type: 'redo' }))] : []),
      button('copy', 'Copy', async () => {
        const copied = await $.ui.copy({ text: selected().content });
        $.ui.toast(copied.isCopied ? 'Copied to clipboard' : `Copy unavailable: ${copied.reason || 'unknown'}`);
      }),
      button('save-button', 'Export…', () => { form = 'export'; refresh(); }),
      button('discard-button', 'Discard…', () => { confirmId = currentDoc.id; form = 'discard'; refresh(); }),
    ]));
    if (form === 'export') {
      children.push(Input({ key: 'export-path', label: 'Export (new file only)', placeholder: 'drafts/letter.md', value: '', submitLabel: 'Save',
        onSubmit: (path) => { void run(async () => { const target = await exportDraft($, path); form = ''; $.ui.toast(`Saved ${target}`); refresh(); })(); },
      }));
    }
    if (form === 'discard' && confirmId === currentDoc.id) {
      children.push(label(`Permanently discard '${currentDoc.title}' and its revision history?`));
      children.push(row([
        button('confirm-discard', 'Discard permanently', async () => { await change($, { type: 'discard', id: confirmId }); form = ''; confirmId = null; }),
        button('cancel-discard', 'Cancel', () => { form = ''; confirmId = null; refresh(); }),
      ]));
    }
    return column(children, { paddingX: 1 });
  });
}

// One concise, stable hunk: identical prefix and suffix are omitted from the comparison.
export function changeFragment(before, after, maxLength = 1600) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let a = before.length, b = after.length;
  while (a > start && b > start && before[a - 1] === after[b - 1]) { a--; b--; }
  const oldPart = before.slice(start, a), newPart = after.slice(start, b);
  return { before: oldPart.slice(0, maxLength), after: newPart.slice(0, maxLength),
    trimmed: oldPart.length > maxLength || newPart.length > maxLength };
}
