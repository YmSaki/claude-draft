import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../hooks/register.mjs';

function host(sharedStore = new Map()) {
  const registered = [];
  const commands = [];
  const panes = [];
  const clipboard = [];
  const prompts = [];
  const notifications = [];
  const writes = new Map();
  let drawCount = 0;
  let forwardedEvent;
  const events = [];
  const $ = {
    session: { id: async () => 'demo-session' },
    clock: { now: async () => 1780000000000 },
    tool: { register: async (v) => registered.push(v) },
    command: { register: async (v) => commands.push(v) },
    store: {
      get: async (key) => sharedStore.get(key),
      set: async (key, value) => { sharedStore.set(key, structuredClone(value)); },
      delete: async (key) => { sharedStore.delete(key); },
      keys: async () => [...sharedStore.keys()],
    },
    ui: {
      open: async (value) => panes.push(value),
      close: async () => {},
      copy: async ({ text }) => { clipboard.push(text); return { isCopied: true }; },
      invalidate: () => { drawCount++; },
      toast: (text) => notifications.push(text),
      log: (text) => notifications.push(text),
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Select', 'Markdown'].map(type => [type, (props) => ({ type, ...props })])),
    },
    prompt: { submit: async (v) => prompts.push(v) },
    fs: {
      exists: async path => writes.has(path),
      write: async (path, text) => { writes.set(path, text); },
    },
  };
  register((type, matcher, cb) => {
    if (typeof matcher === 'function') { cb = matcher; matcher = undefined; }
    events.push({ type, matcher, cb });
  });
  const emit = async (type, e = {}) => {
    const matches = events.filter(x => x.type === type && (!x.matcher || Object.entries(x.matcher).every(([k, v]) => e[k] === v)));
    if (!matches.length) throw new Error(`No listener: ${type}`);
    const chain = async (i, event) => i < matches.length ? matches[i].cb($, event, (next) => chain(i + 1, next)) : ((forwardedEvent = event), { ok: true });
    return chain(0, e);
  };
  async function init() { await emit('session.start', {}); }
  async function tool(name, payload = {}) {
    const r = await emit('tool.call', { tool: 'mcp__claude-draft__' + name, ...payload });
    return JSON.parse(r.result);
  }
  function tree() { return emit('ui.render', { component: 'Pane', requestId: 'claude-draft' }); }
  function walk(node, fn) {
    if (!node || typeof node !== 'object') return null;
    if (fn(node)) return node;
    for (const child of node.children || []) { const v = walk(child, fn); if (v) return v; }
    return null;
  }
  return { $, init, tool, emit, tree, walk, writes, prompts, panes, clipboard, registered, commands, sharedStore, notifications, get drawCount() { return drawCount; }, get forwardedEvent() { return forwardedEvent; } };
}

test('Mod installs a slash command and nine explicit model tools', async () => {
  const h = host(); await h.init();
  assert.deepEqual(h.commands.map(x => x.name), ['draft']);
  assert.equal(h.registered.length, 9);
  assert.equal(h.registered.every(x => x.inputSchema.type === 'object'), true);
  assert.equal(h.sharedStore.size, 0);
});

test('natural-language editing through Mod tools has no project file side effect', async () => {
  const h = host(); await h.init();
  const create = await h.tool('draft_create', { title: 'Notice', content: 'Opening. Body. Ending.' });
  assert.equal(create.ok, true);
  const doc = await h.tool('draft_read');
  assert.equal(doc.content, 'Opening. Body. Ending.');
  const edited = await h.tool('draft_edit', { oldText: 'Body.', newText: 'Revised body.', expectedVersion: doc.version });
  assert.equal(edited.version, 2);
  assert.equal((await h.tool('draft_read')).content, 'Opening. Revised body. Ending.');
  assert.equal(h.writes.size, 0);
});

test('Mod rejects wrong or stale edit and does not change text', async () => {
  const h = host(); await h.init();
  await h.tool('draft_create', { content: 'Again, again.' });
  const ambiguous = await h.tool('draft_edit', { oldText: 'again', newText: 'once', expectedVersion: 1 });
  assert.equal(ambiguous.ok, true); // case sensitive: lower-case 'again' matches once
  const stale = await h.tool('draft_edit', { oldText: 'Again', newText: 'Never', expectedVersion: 1 });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /STALE_VERSION/);
  const current = await h.tool('draft_read');
  assert.equal(current.content, 'Again, once.');
});

test('session restarts keep temporary documents in local plugin store', async () => {
  const store = new Map();
  const a = host(store); await a.init();
  await a.tool('draft_create', { title: 'Persist', content: 'hello' });
  const b = host(store); await b.init();
  const r = await b.tool('draft_read');
  assert.equal(r.title, 'Persist');
  assert.equal(r.content, 'hello');
});

test('Mod provides an object-first pane with document picker, preview and actions', async () => {
  const h = host(); await h.init();
  await h.tool('draft_create', { title: 'Landing', content: '# Header\n\nHello' });
  const t = await h.tree();
  assert.equal(t.type, 'Box');
  assert.ok(h.walk(t, x => x.type === 'Select' && x.key === 'document-list'));
  assert.ok(h.walk(t, x => x.type === 'Markdown' && x.text.includes('Hello')));
  assert.ok(h.walk(t, x => x.type === 'Input' && x.key === 'edit-instruction'));
  const editInput = h.walk(t, x => x.key === 'edit-instruction');
  await editInput.onSubmit('make the headline shorter');
  assert.match(h.prompts[0].text, /make the headline shorter/);
  assert.equal(h.prompts[0].asUser, true);
});

test('UI copy works on selected document and never writes files', async () => {
  const h = host(); await h.init();
  await h.tool('draft_create', { content: 'Copy me.' });
  const pane = await h.tree();
  await h.walk(pane, x => x.key === 'copy').onPress();
  assert.deepEqual(h.clipboard, ['Copy me.']);
  assert.equal(h.writes.size, 0);
});

test('UI discard is two-stage, with cancellation retaining the object', async () => {
  const h = host(); await h.init();
  await h.tool('draft_create', { content: 'Keep me' });
  await h.walk(await h.tree(), x => x.key === 'discard-button').onPress();
  await h.walk(await h.tree(), x => x.key === 'cancel-discard').onPress();
  assert.equal((await h.tool('draft_list')).documents.length, 1);
  await h.walk(await h.tree(), x => x.key === 'discard-button').onPress();
  await h.walk(await h.tree(), x => x.key === 'confirm-discard').onPress();
  assert.equal((await h.tool('draft_list')).documents.length, 0);
  assert.equal(h.sharedStore.size, 0);
});

test('save is an explicit user action, creates a new file only and rejects duplicate', async () => {
  const h = host(); await h.init();
  await h.tool('draft_create', { content: 'Exported.' });
  const save = await h.emit('command.run', { command: 'draft', args: 'save docs/memo.md' });
  assert.match(save.text, /Saved docs\/memo.md/);
  assert.equal(h.writes.get('docs/memo.md'), 'Exported.');
  const retry = await h.emit('command.run', { command: 'draft', args: 'save docs/memo.md' });
  assert.match(retry.text, /FILE_EXISTS/);
  const traversal = await h.emit('command.run', { command: 'draft', args: 'save ../secret.md' });
  assert.match(traversal.text, /INVALID_PATH/);
});

test('slash command supports new / undo / redo / list without creating files', async () => {
  const h = host(); await h.init();
  const created = await h.emit('command.run', { command: 'draft', args: 'new Letter' });
  assert.match(created.text, /Created temporary draft/);
  await h.tool('draft_write', { content: 'First', expectedVersion: 1 });
  await h.tool('draft_write', { content: 'Second', expectedVersion: 2 });
  const undo = await h.emit('command.run', { command: 'draft', args: 'undo' });
  assert.match(undo.text, /v2/);
  assert.equal((await h.tool('draft_read')).content, 'First');
  await h.emit('command.run', { command: 'draft', args: 'redo' });
  assert.equal((await h.tool('draft_read')).content, 'Second');
  assert.equal(h.writes.size, 0);
});

test('active draft is offered as additive prompt context, with original user text unchanged', async () => {
  const h = host(); await h.init();
  await h.tool('draft_create', { title: 'Context', content: 'Text' });
  const result = await h.emit('prompt.submit', { text: 'Please tighten the second sentence', context: ['Prior info'] });
  assert.equal(result.ok, true);
  assert.equal(h.forwardedEvent.text, 'Please tighten the second sentence');
  assert.equal(h.forwardedEvent.context[0], 'Prior info');
  assert.match(h.forwardedEvent.context[1], /Active temporary document/);
  assert.match(h.forwardedEvent.context[1], /draft_read/);
  assert.equal(h.writes.size, 0);
});

test('corrupt stored draft is never overwritten by the model', async () => {
  const store = new Map([['draft-session-v1:demo-session', { schema: 1, updatedAt: 0, drafts: [{ id: 'bad', revisions: [] }] }]]);
  const h = host(store); await h.init();
  const create = await h.tool('draft_create', { title: 'Unsafe' });
  assert.equal(create.ok, false);
  assert.match(create.error, /CORRUPT/);
  assert.equal(store.get('draft-session-v1:demo-session').drafts[0].id, 'bad');
});
