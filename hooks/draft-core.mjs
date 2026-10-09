// Copyright 2026 claude-draft contributors. Apache-2.0.
// Pure document-domain operations. No file system or Claude Code dependencies.

export const LIMITS = Object.freeze({
  documents: 12,
  contentBytes: 96 * 1024,
  history: 12,
  storeBytes: 1024 * 1024,
  titleLength: 100,
});

const bytes = (value) => new TextEncoder().encode(value).length;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class DraftError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
  }
}

function assert(condition, code, message) {
  if (!condition) throw new DraftError(code, message);
}

export function emptyLibrary() {
  return { schema: 1, activeId: null, drafts: [], updatedAt: 0 };
}

export function validateLibrary(input) {
  assert(isObject(input) && input.schema === 1 && Array.isArray(input.drafts), 'CORRUPT', 'Saved draft data is invalid. No data has been overwritten.');
  assert(input.drafts.length <= LIMITS.documents, 'CORRUPT', 'Saved library exceeds the document limit.');
  assert(typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt), 'CORRUPT', 'Invalid saved timestamp.');
  const ids = new Set();
  for (const d of input.drafts) {
    assert(isObject(d) && typeof d.id === 'string' && d.id.length > 0 && !ids.has(d.id), 'CORRUPT', 'Saved document identifiers are invalid.');
    ids.add(d.id);
    assert(typeof d.title === 'string' && d.title.length > 0 && d.title.length <= LIMITS.titleLength, 'CORRUPT', 'Invalid saved title.');
    assert(Number.isInteger(d.cursor) && Array.isArray(d.revisions) && d.revisions.length > 0 && d.revisions.length <= LIMITS.history && d.cursor >= 0 && d.cursor < d.revisions.length, 'CORRUPT', 'Invalid saved revision history.');
    assert(Number.isInteger(d.nextVersion) && d.nextVersion > 0, 'CORRUPT', 'Invalid version counter.');
    assert(typeof d.createdAt === 'number' && typeof d.updatedAt === 'number', 'CORRUPT', 'Invalid draft timestamps.');
    const seenVersions = new Set();
    for (const r of d.revisions) {
      assert(isObject(r) && Number.isInteger(r.version) && r.version > 0 && !seenVersions.has(r.version) && r.version < d.nextVersion, 'CORRUPT', 'Invalid revision number.');
      assert(typeof r.text === 'string' && bytes(r.text) <= LIMITS.contentBytes && typeof r.note === 'string' && typeof r.at === 'number', 'CORRUPT', 'Invalid saved revision.');
      seenVersions.add(r.version);
    }
  }
  assert(input.activeId === null || (typeof input.activeId === 'string' && ids.has(input.activeId)), 'CORRUPT', 'Active document no longer exists.');
  assert(bytes(JSON.stringify(input)) <= LIMITS.storeBytes, 'CORRUPT', 'Saved draft data is above the size limit.');
  return input;
}

export function current(draft) {
  return draft.revisions[draft.cursor];
}

export function getDraft(library, id) {
  const target = id || library.activeId;
  assert(typeof target === 'string' && target.length > 0, 'NO_ACTIVE_DRAFT', 'No active document. Use /draft new <title> or draft_create first.');
  const draft = library.drafts.find((d) => d.id === target);
  assert(!!draft, 'NOT_FOUND', `Draft ${target} not found. Use draft_list to see available documents.`);
  return draft;
}

function requiredText(value, field) {
  assert(typeof value === 'string', 'INVALID_INPUT', `${field} must be text.`);
  return value;
}

function cleanTitle(input) {
  assert(typeof input === 'string', 'INVALID_TITLE', 'Title must be a string.');
  const title = input.trim();
  assert(title.length > 0 && title.length <= LIMITS.titleLength && !/[\x00-\x1f\x7f]/.test(title), 'INVALID_TITLE', 'Title must have 1–100 visible characters and no control characters.');
  return title;
}

function checkedContent(value) {
  requiredText(value, 'Content');
  assert(bytes(value) <= LIMITS.contentBytes, 'CONTENT_LIMIT', `A draft can hold at most ${LIMITS.contentBytes} UTF-8 bytes.`);
  return value;
}

function optimisticVersion(draft, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null) return;
  assert(Number.isInteger(expectedVersion) && expectedVersion === current(draft).version, 'STALE_VERSION', `Draft is now v${current(draft).version}; read the latest text before editing.`);
}

function addRevision(draft, text, note, now) {
  const existing = current(draft);
  if (text === existing.text) return false;
  draft.revisions = draft.revisions.slice(0, draft.cursor + 1);
  draft.revisions.push({ version: draft.nextVersion++, text, note: String(note || 'Edit').slice(0, 120), at: now });
  if (draft.revisions.length > LIMITS.history) draft.revisions.shift();
  draft.cursor = draft.revisions.length - 1;
  draft.updatedAt = now;
  return true;
}

function summary(draft, activeId) {
  const r = current(draft);
  return {
    id: draft.id,
    title: draft.title,
    version: r.version,
    length: r.text.length,
    preview: r.text.replace(/\s+/g, ' ').slice(0, 90),
    active: draft.id === activeId,
    canUndo: draft.cursor > 0,
    canRedo: draft.cursor < draft.revisions.length - 1,
    updatedAt: draft.updatedAt,
  };
}

export function listDrafts(library) {
  return library.drafts.map((d) => summary(d, library.activeId));
}

export function readDraft(library, id) {
  const draft = getDraft(library, id);
  return { ...summary(draft, library.activeId), content: current(draft).text };
}

export function historyOf(library, id) {
  const draft = getDraft(library, id);
  return {
    id: draft.id,
    title: draft.title,
    revisions: draft.revisions.map((r, index) => ({
      version: r.version, at: r.at, note: r.note,
      length: r.text.length, current: index === draft.cursor,
    })),
  };
}

// All operations are copy-on-write: an error cannot partially mutate a document.
export function applyAction(library, action, now, generateId) {
  validateLibrary(library);
  assert(isObject(action) && typeof action.type === 'string', 'INVALID_INPUT', 'Missing action type.');
  assert(typeof now === 'number' && Number.isFinite(now), 'INVALID_INPUT', 'Missing timestamp.');
  const next = structuredClone(library);
  let result;
  let draft;

  switch (action.type) {
    case 'create': {
      assert(next.drafts.length < LIMITS.documents, 'DOCUMENT_LIMIT', `At most ${LIMITS.documents} drafts may be open.`);
      const title = cleanTitle(action.title || 'Untitled draft');
      const text = checkedContent(action.content ?? '');
      const id = generateId();
      assert(typeof id === 'string' && /^[\w-]{8,80}$/.test(id) && !next.drafts.some((d) => d.id === id), 'INVALID_ID', 'Could not create a unique identifier.');
      draft = { id, title, createdAt: now, updatedAt: now, cursor: 0, nextVersion: 2,
        revisions: [{ version: 1, text, note: 'Created', at: now }] };
      next.drafts.push(draft);
      next.activeId = id;
      result = { ...summary(draft, next.activeId), created: true };
      break;
    }
    case 'select': {
      draft = getDraft(next, action.id);
      next.activeId = draft.id;
      result = summary(draft, next.activeId);
      break;
    }
    case 'rename': {
      draft = getDraft(next, action.id);
      const title = cleanTitle(action.title);
      if (draft.title !== title) { draft.title = title; draft.updatedAt = now; }
      next.activeId = draft.id;
      result = summary(draft, next.activeId);
      break;
    }
    case 'write': {
      draft = getDraft(next, action.id);
      optimisticVersion(draft, action.expectedVersion);
      const content = checkedContent(action.content);
      const changed = addRevision(draft, content, action.note || 'Rewritten', now);
      next.activeId = draft.id;
      result = { ...summary(draft, next.activeId), changed };
      break;
    }
    case 'edit': {
      draft = getDraft(next, action.id);
      optimisticVersion(draft, action.expectedVersion);
      const oldText = requiredText(action.oldText, 'oldText');
      const newText = requiredText(action.newText, 'newText');
      assert(oldText.length > 0, 'INVALID_INPUT', 'oldText cannot be empty.');
      const before = current(draft).text;
      const first = before.indexOf(oldText);
      assert(first >= 0, 'NO_MATCH', 'Exact text was not found. Read the current draft and use an exact excerpt.');
      assert(before.indexOf(oldText, first + 1) < 0, 'AMBIGUOUS_MATCH', 'Exact text occurs more than once. Supply a longer, unique excerpt.');
      const after = checkedContent(before.slice(0, first) + newText + before.slice(first + oldText.length));
      const changed = addRevision(draft, after, action.note || 'Edited passage', now);
      next.activeId = draft.id;
      result = { ...summary(draft, next.activeId), changed };
      break;
    }
    case 'restore': {
      draft = getDraft(next, action.id);
      assert(Number.isInteger(action.version), 'INVALID_INPUT', 'Specify a numeric version.');
      const found = draft.revisions.find((r) => r.version === action.version);
      assert(!!found, 'NOT_FOUND', `Version ${action.version} is no longer in history.`);
      const changed = addRevision(draft, found.text, `Restored from v${found.version}`, now);
      next.activeId = draft.id;
      result = { ...summary(draft, next.activeId), changed };
      break;
    }
    case 'undo': {
      draft = getDraft(next, action.id);
      assert(draft.cursor > 0, 'NO_UNDO', 'There is no earlier revision to undo to.');
      draft.cursor -= 1;
      draft.updatedAt = now;
      next.activeId = draft.id;
      result = summary(draft, next.activeId);
      break;
    }
    case 'redo': {
      draft = getDraft(next, action.id);
      assert(draft.cursor < draft.revisions.length - 1, 'NO_REDO', 'There is no later revision to redo.');
      draft.cursor += 1;
      draft.updatedAt = now;
      next.activeId = draft.id;
      result = summary(draft, next.activeId);
      break;
    }
    case 'discard': {
      draft = getDraft(next, action.id);
      next.drafts = next.drafts.filter((d) => d.id !== draft.id);
      if (next.activeId === draft.id) next.activeId = next.drafts.at(-1)?.id || null;
      result = { discarded: true, id: draft.id, activeId: next.activeId };
      break;
    }
    default:
      throw new DraftError('INVALID_OPERATION', `Unsupported action: ${action.type}`);
  }
  next.updatedAt = now;
  assert(bytes(JSON.stringify(next)) <= LIMITS.storeBytes, 'STORE_LIMIT', 'Draft history is full. Discard another draft or export it before continuing.');
  return { state: next, result };
}

// Exports are explicit. This function never opens or writes a path.
export function safeExportPath(input) {
  const path = requiredText(input, 'path').trim();
  assert(path.length > 0 && path.length <= 240, 'INVALID_PATH', 'Supply a relative filename (e.g. drafts/intro.md).');
  assert(!/[\x00-\x1f\x7f]/.test(path) && !/^[~/\\]/.test(path) && !/^[A-Za-z]:/.test(path), 'INVALID_PATH', 'Absolute, home, network, and control-character paths are not allowed.');
  const parts = path.replace(/\\/g, '/').split('/');
  assert(parts.every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.') && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part)), 'INVALID_PATH', 'Use a regular filename without dot segments, hidden paths, or reserved characters.');
  assert(parts.every((part) => !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)), 'INVALID_PATH', 'Reserved device names are not valid paths.');
  assert(/\.(md|txt)$/i.test(parts.at(-1)), 'INVALID_PATH', 'Only .md or .txt exports are supported.');
  return parts.join('/');
}
