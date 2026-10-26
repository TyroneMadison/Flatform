// Auto-backup to GitHub. OFF by default and only ever turned on by Tyrone in Settings. Commits the workspace's project
// files in its own git repo and pushes to a backup branch (never main or master, never force) using his existing git
// credentials: no token is stored. Offline or failed pushes are queued and retried on the next run.
export const DEFAULTS = Object.freeze({ enabled: false, remote: 'origin', branch: 'flatform-backup', pending: false, lastRun: null, lastError: null });
const PROTECTED = ['main', 'master'];
const BRANCH = /^[A-Za-z0-9._/-]{1,80}$/;
export const PROJECT_FILES = ['library.json', 'settings.json', 'shares.json', 'batch.json', 'overnight.json', 'models/*/scene.json', 'plugins/*.js'];

export function checkBackup(b) {
  if (!BRANCH.test(b.branch || '') || PROTECTED.includes(b.branch) || b.branch.startsWith('-')) throw new Error('Pick a backup branch other than main');
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(b.remote || '')) throw new Error('Bad remote name');
  return b;
}

/** The git commands for one backup, as argv arrays. Never reset, never force, never main. */
export function backupCommands(b, { stamp = new Date().toISOString() } = {}) {
  checkBackup(b);
  return [
    ['add', '--', ...PROJECT_FILES],
    ['commit', '--allow-empty', '-m', `Flatform backup ${stamp}`],
    ['push', b.remote, `HEAD:refs/heads/${b.branch}`],
  ];
}

export const isSafeGit = (argv) => !argv.some((a) => ['--force', '-f', '--force-with-lease', '--mirror', '--delete', '-d'].includes(a) || /^\+/.test(a) || /refs\/heads\/(main|master)$/.test(a)) && !['reset', 'filter-branch', 'gc'].includes(argv[0]);

export const HOOK = '#!/bin/sh\n# Flatform auto-backup (remove this file to stop). Pushes to the backup branch only.\ngit push origin "HEAD:refs/heads/${FLATFORM_BACKUP_BRANCH:-flatform-backup}" || true\n';

/** One backup run. git(argv) runs git in the workspace and resolves or throws. Disabled = does nothing. */
export async function runBackup(b, git, opts) {
  if (!b.enabled) return { ...b, skipped: 'Backup is off' };
  const cmds = backupCommands(b, opts);
  if (!cmds.every(isSafeGit)) throw new Error('Refusing an unsafe git command');
  try {
    for (const argv of cmds) await git(argv);
    return { ...b, pending: false, lastRun: new Date().toISOString(), lastError: null };
  } catch (e) {
    return { ...b, pending: true, lastError: String(e.message || e).slice(0, 300) }; // queued for the next run
  }
}
