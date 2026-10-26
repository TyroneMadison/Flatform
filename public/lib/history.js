// Edit history for a model's scene (undo/redo) and the safe git rollback used by the History panel.
// Rollback is only ever `git revert` or a new branch at an old commit: never reset, never force, never deletes history.

export function createHistory({ limit = 100, burst = 600, now = Date.now } = {}) {
  let past = [], future = [];
  let last = 0; // when the last edit was recorded
  let gesture = null; // a drag in progress: { before, recorded }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    // Call with the state BEFORE an edit. A drag (begin..end) is one step however long it runs; other edits within
    // `burst` ms of each other (a key held on a slider, a wheel zoom) merge into one step too.
    // Returns true when this edit started a new undo step.
    record(current, label = 'Edit') {
      let pushed = false;
      if (gesture) {
        if (!gesture.recorded) { pushed = this.push(gesture.before, label); gesture.recorded = true; }
      } else if (now() - last > burst) pushed = this.push(current, label);
      last = now();
      return pushed;
    },
    // A pointer went down: remember the state now, record it only if the drag actually changes something.
    begin(current) { gesture = { before: clone(current), recorded: false }; },
    end() { if (gesture?.recorded) last = 0; gesture = null; }, // the next edit after a drag is its own step
    // Call with the state BEFORE an edit; it becomes the undo target.
    push(prev, label = 'Edit') {
      if (past.length && JSON.stringify(past.at(-1).value) === JSON.stringify(prev)) return false;
      past.push({ value: clone(prev), label, at: Date.now() });
      if (past.length > limit) past.shift();
      future = [];
      return true;
    },
    undo(current) {
      const e = past.pop();
      last = 0; // the next edit after an undo or redo is always its own step
      if (!e) return null;
      future.push({ value: clone(current), label: e.label, at: Date.now() });
      return clone(e.value);
    },
    redo(current) {
      const e = future.pop();
      last = 0;
      if (!e) return null;
      past.push({ value: clone(current), label: e.label, at: Date.now() });
      return clone(e.value);
    },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    list: () => past.map((e) => ({ label: e.label, at: e.at })).reverse(),
    clear() { past = []; future = []; gesture = null; last = 0; },
  };
}

export const isUndo = (e) => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
export const isRedo = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y');
// Typing in a field keeps the field's own undo: text-like inputs, textareas, selects and contenteditable.
const TYPING = new Set(['text', 'search', 'number', 'email', 'url', 'password', 'tel']);
export const isTyping = (t) => Boolean(t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && TYPING.has((t.type || 'text').toLowerCase()))));
// Which history step a key press asks for: 'undo', 'redo' or null (not a shortcut, or the user is typing).
export const historyKey = (e) => (isTyping(e.target) ? null : isUndo(e) ? 'undo' : isRedo(e) ? 'redo' : null);

const SHA = /^[0-9a-f]{7,40}$/i;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,100}(?<![./])$/;
// Returns git argv. mode 'revert': a new commit that undoes everything after sha on this branch.
// mode 'branch': a new branch starting at sha; the current branch is untouched.
export function rollbackCommand({ sha, mode = 'branch', branch } = {}) {
  if (!SHA.test(String(sha || ''))) throw new Error('Pick a commit from the list');
  if (mode === 'revert') return [['revert', '--no-edit', `${sha}..HEAD`]];
  if (mode === 'branch') {
    const name = branch || `rollback-${sha.slice(0, 7)}`;
    if (!BRANCH.test(name) || name === 'main' || name === 'master') throw new Error('That branch name is not allowed');
    return [['switch', '-c', name, sha]];
  }
  throw new Error('Rollback is revert or new branch only');
}
export const FORBIDDEN = ['reset', '--hard', '--force', '-f', 'push', 'branch -D', '--force-with-lease', 'filter-branch', 'gc', 'reflog'];
export const isSafe = (cmds) => cmds.every((argv) => !argv.some((a) => FORBIDDEN.includes(a)) && argv[0] !== 'reset' && argv[0] !== 'push');
