import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, DraftError, emptyLibrary, validateLibrary, applyAction,
  listDrafts, readDraft, historyOf, getDraft, safeExportPath,
} from '../hooks/draft-core.mjs';
import { changeFragment } from '../hooks/register.mjs';

const mkId = (() => { let i = 0; return () => 'draft-000' + ++i; })();
function act(state, type, args = {}, at = 1700000000000) {
  return applyAction(state, { type, ...args }, at, mkId);
}
function created(content = 'Hello world', title = 'Intro') {
  return act(emptyLibrary(), 'create', { title, content }).state;
}
function errorCode(fn, code) {
  assert.throws(fn, (e) => e instanceof DraftError && e.code === code, `expected ${code}`);
}

test('creates an empty library and validates the saved schema', () => {
  assert.deepEqual(listDrafts(emptyLibrary()), []);
  assert.equal(validateLibrary(emptyLibrary()).schema, 1);
});
test('creates and selects an object with its own identity and title', () => {
  const s = created('Some text');
  assert.equal(s.drafts.length, 1);
  assert.equal(s.activeId, s.drafts[0].id);
  assert.equal(readDraft(s).content, 'Some text');
  assert.equal(readDraft(s).version, 1);
});
test('multiple documents remain independent when switched', () => {
  let s = created('A', 'Alpha');
  const first = s.activeId;
  s = act(s, 'create', { title: 'Beta', content: 'B' }).state;
  const second = s.activeId;
  assert.notEqual(first, second);
  s = act(s, 'select', { id: first }).state;
  s = act(s, 'write', { content: 'AA', expectedVersion: 1 }).state;
  assert.equal(readDraft(s, first).content, 'AA');
  assert.equal(readDraft(s, second).content, 'B');
});
test('exact passage editing leaves surrounding prose unchanged', () => {
  let s = created('First paragraph.\nSecond paragraph.\nEnd.');
  s = act(s, 'edit', { oldText: 'Second paragraph.', newText: 'Polished middle.', expectedVersion: 1 }).state;
  assert.equal(readDraft(s).content, 'First paragraph.\nPolished middle.\nEnd.');
  assert.equal(readDraft(s).version, 2);
});
test('ambiguous passage cannot be edited by mistake and original stays valid', () => {
  const s = created('abc abc abc');
  errorCode(() => act(s, 'edit', { oldText: 'abc', newText: 'X' }), 'AMBIGUOUS_MATCH');
  assert.equal(readDraft(s).content, 'abc abc abc');
  assert.equal(readDraft(s).version, 1);
});
test('overlapping matches must also be rejected as ambiguous', () => {
  const s = created('aaaa');
  errorCode(() => act(s, 'edit', { oldText: 'aaa', newText: 'X' }), 'AMBIGUOUS_MATCH');
});
test('missing passage does not change the document', () => {
  const s = created('abcd');
  errorCode(() => act(s, 'edit', { oldText: 'xyz', newText: 'X' }), 'NO_MATCH');
  assert.equal(s.drafts[0].revisions.length, 1);
});
test('empty matching text is forbidden', () => {
  errorCode(() => act(created(), 'edit', { oldText: '', newText: 'prefix' }), 'INVALID_INPUT');
});
test('optimistic revision prevents lost updates', () => {
  const s = act(created(), 'write', { content: 'Changed', expectedVersion: 1 }).state;
  errorCode(() => act(s, 'write', { content: 'Stale overwrite', expectedVersion: 1 }), 'STALE_VERSION');
  assert.equal(readDraft(s).content, 'Changed');
});
test('same content is not an extra revision', () => {
  const s = created('Hi');
  const r = act(s, 'write', { content: 'Hi', expectedVersion: 1 });
  assert.equal(r.result.changed, false);
  assert.equal(r.state.drafts[0].revisions.length, 1);
});
test('Undo and redo navigate versions without changing history', () => {
  let s = act(created(), 'write', { content: 'Second' }).state;
  s = act(s, 'write', { content: 'Third' }).state;
  s = act(s, 'undo').state;
  assert.equal(readDraft(s).content, 'Second');
  s = act(s, 'redo').state;
  assert.equal(readDraft(s).content, 'Third');
  assert.equal(historyOf(s).revisions.length, 3);
});
test('new edit after undo invalidates redo and maintains monotonic versions', () => {
  let s = act(created(), 'write', { content: 'Second' }).state;
  s = act(s, 'write', { content: 'Third' }).state;
  s = act(s, 'undo').state;
  s = act(s, 'write', { content: 'Alternative', expectedVersion: 2 }).state;
  assert.equal(readDraft(s).version, 4);
  assert.equal(readDraft(s).canRedo, false);
  errorCode(() => act(s, 'redo'), 'NO_REDO');
});
test('history restore creates a new revision instead of overwriting', () => {
  let s = act(created('A'), 'write', { content: 'B' }).state;
  s = act(s, 'restore', { version: 1 }).state;
  assert.equal(readDraft(s).content, 'A');
  assert.equal(readDraft(s).version, 3);
  assert.deepEqual(historyOf(s).revisions.map((x) => x.version), [1, 2, 3]);
});
test('bounded history drops oldest snapshots but not live document', () => {
  let s = created('0');
  for (let i = 1; i < 20; i++) s = act(s, 'write', { content: '' + i }).state;
  assert.equal(historyOf(s).revisions.length, LIMITS.history);
  assert.equal(readDraft(s).content, '19');
  errorCode(() => act(s, 'restore', { version: 1 }), 'NOT_FOUND');
});
test('rename keeps revision untouched', () => {
  const s = act(created(), 'rename', { title: '  New title  ' }).state;
  assert.equal(readDraft(s).title, 'New title');
  assert.equal(readDraft(s).version, 1);
});
test('invalid titles are rejected without altering anything', () => {
  errorCode(() => act(emptyLibrary(), 'create', { title: '\n', content: '' }), 'INVALID_TITLE');
});
test('empty title uses explicit default during creation', () => {
  const s = act(emptyLibrary(), 'create', { title: 'Untitled draft' }).state;
  assert.equal(readDraft(s).title, 'Untitled draft');
});
test('discard removes the selected document and leaves remaining independent', () => {
  let s = created('one');
  const first = s.activeId;
  s = act(s, 'create', { title: 'Two', content: 'two' }).state;
  s = act(s, 'discard').state;
  assert.equal(s.activeId, first);
  assert.equal(readDraft(s).content, 'one');
  s = act(s, 'discard').state;
  assert.equal(s.activeId, null);
  assert.equal(s.drafts.length, 0);
});
test('all draft text respects 96 KiB UTF-8 limit', () => {
  errorCode(() => act(emptyLibrary(), 'create', { content: '漢'.repeat(50_000) }), 'CONTENT_LIMIT');
  errorCode(() => act(created(), 'write', { content: 'a'.repeat(LIMITS.contentBytes + 1) }), 'CONTENT_LIMIT');
});
test('library has a fixed document limit and never grows beyond it', () => {
  let s = emptyLibrary();
  for (let i = 0; i < LIMITS.documents; i++) s = act(s, 'create', { title: 'Doc' + i }).state;
  errorCode(() => act(s, 'create', { title: 'Nope' }), 'DOCUMENT_LIMIT');
  assert.equal(s.drafts.length, LIMITS.documents);
});
test('corrupt persisted state fails closed rather than clearing user drafts', () => {
  const s = created();
  s.drafts[0].cursor = 999;
  errorCode(() => validateLibrary(s), 'CORRUPT');
});
test('export path allows only explicit relative text documents', () => {
  assert.equal(safeExportPath('drafts\\memo.md'), 'drafts/memo.md');
  assert.equal(safeExportPath('intro.txt'), 'intro.txt');
  assert.equal(safeExportPath('x.md '), 'x.md');
  for (const path of ['../a.md', '/root/a.md', 'C:\\private.md', '\\\\host\\a.md', '.git/config.md', 'notes/.env', 'file.js', 'file.md/../other.md', 'CON.md', 'a\0.md', 'a/./b.md', 'a//b.md']) {
    errorCode(() => safeExportPath(path), 'INVALID_PATH');
  }
});
test('diff shows only changed region and preserves original outside of it', () => {
  assert.deepEqual(changeFragment('hello world', 'hello planet'), { before: 'world', after: 'planet', trimmed: false });
  assert.deepEqual(changeFragment('hello', 'hello'), { before: '', after: '', trimmed: false });
});
test('mutations do not edit passed library state', () => {
  const s = created('original');
  const result = act(s, 'write', { content: 'updated' });
  assert.equal(readDraft(s).content, 'original');
  assert.equal(readDraft(result.state).content, 'updated');
});
test('explicit ID points to the intended draft, not a title lookalike', () => {
  const s = created('hi', 'Document');
  errorCode(() => getDraft(s, 'Document'), 'NOT_FOUND');
});
