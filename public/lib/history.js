// Edit history for a model's scene (undo/redo) and the safe git rollback used by the History panel.
// Rollback is only ever `git revert` or a new branch at an old commit: never reset, never force, never deletes history.

export function createHistory({ limit = 100 } = {}) {
  let past = [], future = [];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    // Call with the state BEFORE an edit; it becomes the undo target.
    push(prev, label = 'Edit') {
      if (past.length && JSON.stringify(past.at(-1).value) === JSON.stringify(prev)) return;
      past.push({ value: clone(prev), label, at: Date.now() });
      if (past.length > limit) past.shift();
      future = [];
    },
    undo(current) {
      const e = past.pop();
      if (!e) return null;
      future.push({ value: clone(current), label: e.label, at: Date.now() });
      return clone(e.value);
    },
    redo(current) {
      const e = future.pop();
      if (!e) return null;
      past.push({ value: clone(current), label: e.label, at: Date.now() });
      return clone(e.value);
    },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    list: () => past.map((e) => ({ label: e.label, at: e.at })).reverse(),
    clear() { past = []; future = []; },
  };
}

export const isUndo = (e) => (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z';
export const isRedo = (e) => (e.ctrlKey || e.metaKey) && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y');

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
