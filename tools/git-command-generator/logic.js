// Git Command Generator - pure logic entry point (no DOM). Only produces text; never runs git.
import { renderTokens, COMMENT_PREFIX, placeholder, validateValue, createBuilder } from './core.js';
import { ALL_TASKS, CATEGORIES } from './tasks.js';

export * from './core.js';
export { ALL_TASKS, CATEGORIES, TASKS, RECIPES } from './tasks.js';

export const getTask = id => ALL_TASKS.find(t => t.id === id) || null;
export const tasksByCategory = cat => ALL_TASKS.filter(t => t.cat === cat);
const reqOf = (f, v) => (typeof f.req === 'function' ? !!f.req(v) : !!f.req);

export function defaultValues(task) {
  const o = {};
  for (const f of task.fields) o[f.id] = f.type === 'check' ? !!f.def : (f.def ?? '');
  return o;
}

/** Fields that should be shown for the given (raw) values. */
export function visibleFields(task, raw = {}) {
  const v = { ...defaultValues(task), ...raw };
  return task.fields.filter(f => !f.show || f.show(v));
}

const RANK = { high: 2, medium: 1 };

/**
 * Generate the commands for a task.
 * Returns {ok, errors:{id:msg}, missing:[id], steps:[{text, comment}], flags, dangers, danger, undo, alts, notes, warnings, script}.
 * Required values that are still empty are shown as <placeholders> and listed in `missing` (ok=false).
 */
export function generate(taskOrId, raw = {}, { shell = 'posix' } = {}) {
  const task = typeof taskOrId === 'string' ? getTask(taskOrId) : taskOrId;
  if (!task) throw new Error(`Unknown task ${taskOrId}`);
  const base = { ...defaultValues(task), ...raw };
  const v = {};
  for (const f of task.fields) {
    const val = base[f.id];
    v[f.id] = f.type === 'check' ? !!val : (val == null ? '' : f.type === 'textarea' ? String(val).replace(/\s+$/, '') : String(val).trim());
  }
  const errors = {}, missing = [];
  const vis = new Set();
  for (const f of task.fields) if (!f.show || f.show(v)) vis.add(f.id);
  for (const f of task.fields) {
    if (!vis.has(f.id)) { v[f.id] = f.type === 'check' ? false : (f.type === 'select' ? f.def : ''); continue; }
  }
  for (const f of task.fields) {
    if (!vis.has(f.id) || f.type === 'check') continue;
    if (v[f.id] === '' || !v[f.id].trim()) { if (reqOf(f, v)) { missing.push(f.id); v[f.id] = placeholder(f.label.replace(/\s*[(/].*$/, '').toLowerCase()); } continue; }
    const e = validateValue(f, v[f.id], { required: false });
    if (e) errors[f.id] = e;
  }
  const b = createBuilder();
  task.build(v, b);
  const steps = b.steps.map(s => ({ text: s.tokens.length ? renderTokens(s.tokens, shell) : '', comment: s.comment || '' }));
  const warnings = [...b.warnings];
  if (shell === 'cmd' && steps.some(s => s.text.includes('\n'))) warnings.push('A multi-line argument cannot be typed in cmd.exe; use a single-line message or a POSIX shell / PowerShell.');
  if (shell === 'cmd') warnings.push('In cmd.exe, %VAR% inside quotes is still expanded and ^ is an escape character outside quotes.');
  const danger = b.dangers.slice().sort((x, y) => RANK[y.level] - RANK[x.level])[0] || null;
  const out = { task: task.id, ok: !missing.length && !Object.keys(errors).length, errors, missing, steps, flags: b.flags, dangers: b.dangers, danger, undo: b.undoHints, alts: b.alts, notes: b.notes, warnings };
  out.script = formatScript(steps, shell, { comments: true });
  out.plain = formatScript(steps, shell, { comments: false });
  return out;
}

/** Join steps into a copyable script. With comments, each explanation precedes its command as a shell comment. */
export function formatScript(steps, shell = 'posix', { comments = true } = {}) {
  const pre = COMMENT_PREFIX[shell] || '# ';
  const lines = [];
  for (const s of steps) {
    if (comments && s.comment) for (const l of s.comment.split('\n')) lines.push(pre + l);
    if (s.text) lines.push(s.text);
  }
  return lines.join('\n');
}

// ---------------- favourites ----------------
export const MAX_FAVOURITES = 50;
export function addFavourite(list, { label, text, task = null }, now = Date.now()) {
  const t = String(text || '').trim();
  if (!t) return list;
  const rest = list.filter(f => f.text !== t);
  return [{ id: `${now.toString(36)}${rest.length}`, label: String(label || t.split('\n')[0]).slice(0, 80), text: t, task, ts: now }, ...rest].slice(0, MAX_FAVOURITES);
}
export const removeFavourite = (list, id) => list.filter(f => f.id !== id);
export function sanitizeFavourites(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(f => f && typeof f.text === 'string' && typeof f.id === 'string').map(f => ({ id: f.id, label: String(f.label || f.text).slice(0, 80), text: f.text.slice(0, 5000), task: f.task || null, ts: Number(f.ts) || 0 })).slice(0, MAX_FAVOURITES);
}

// ---------------- cheat sheet ----------------
const CHEAT = `git init -b main|Create a repository|setup
git clone <url>|Copy a remote repository|setup
git clone --depth 1 <url>|Shallow clone (latest commit only)|setup
git config --global user.name "Name"|Set your commit name|setup
git config --global user.email "me@example.com"|Set your commit email|setup
git config --global alias.st status|Create an alias|setup
git config --list --show-origin|Show all settings and where they come from|setup
git status -sb|Short status with branch|inspect
git add <path>|Stage a file|commit
git add -p|Stage hunks interactively|commit
git add -A|Stage everything|commit
git restore --staged <path>|Unstage a file|undo
git restore <path>|Discard working-tree changes of a file|undo
git commit -m "msg"|Commit staged changes|commit
git commit --amend|Replace the last commit|commit
git commit --amend --no-edit|Add staged changes to the last commit|commit
git commit --fixup <sha>|Commit that will be folded into <sha> later|commit
git rebase -i --autosquash <sha>~1|Apply fixup commits|rebase
git rm --cached <path>|Stop tracking a file but keep it|commit
git mv old new|Rename a file|commit
git branch|List local branches|branch
git branch -a|List all branches|branch
git branch -vv|List branches with upstream info|branch
git switch -c <name>|Create and switch to a branch|branch
git switch <name>|Switch branch|branch
git switch -|Return to the previous branch|branch
git branch -m <new>|Rename the current branch|branch
git branch -d <name>|Delete a merged branch|branch
git branch -D <name>|Force delete a branch (DANGER)|branch
git push origin --delete <name>|Delete a remote branch|branch
git branch --merged main|Branches already merged into main|branch
git branch --no-merged main|Branches not merged into main|branch
git merge <branch>|Merge a branch into the current one|merge
git merge --no-ff <branch>|Always create a merge commit|merge
git merge --ff-only <branch>|Merge only if fast-forward|merge
git merge --squash <branch>|Stage the combined changes of a branch|merge
git merge --abort|Cancel a conflicted merge|merge
git rebase <base>|Replay commits on another base|rebase
git rebase -i HEAD~3|Edit the last 3 commits|rebase
git rebase --onto <new> <old> <branch>|Transplant a range of commits|rebase
git rebase --continue|Continue after resolving conflicts|rebase
git rebase --abort|Cancel a rebase|rebase
git pull --rebase|Fetch and rebase local commits|rebase
git pull --ff-only|Fetch and fast-forward only|rebase
git fetch --prune|Download and drop stale remote refs|remote
git remote -v|List remotes|remote
git remote add <name> <url>|Add a remote|remote
git remote set-url origin <url>|Change a remote URL|remote
git push -u origin <branch>|Push and set upstream|remote
git push --force-with-lease|Safer force push (DANGER)|remote
git push --force|Overwrite remote history (DANGER)|remote
git push origin <tag>|Push a tag|remote
git push --tags|Push all tags|remote
git stash push -m "msg"|Stash tracked changes|stash
git stash push -u|Stash including untracked files|stash
git stash list|List stashes|stash
git stash pop|Apply and drop the latest stash|stash
git stash apply stash@{1}|Apply a stash and keep it|stash
git stash drop stash@{0}|Delete a stash|stash
git stash branch <name>|Create a branch from a stash|stash
git tag -a v1.0.0 -m "msg"|Create an annotated tag|tag
git tag -d v1.0.0|Delete a local tag|tag
git describe --tags --abbrev=0|Latest reachable tag|tag
git log --oneline --graph --decorate --all|Compact history graph|inspect
git log -p -- <path>|History of a file with patches|inspect
git log --follow -- <path>|File history across renames|inspect
git log --author="name"|Commits by an author|inspect
git log -S"text"|Commits that added or removed text (pickaxe)|inspect
git log -G"regex"|Commits whose diff matches a regex|inspect
git log main..feature|Commits in feature but not in main|inspect
git shortlog -sn|Commits per author|inspect
git diff|Unstaged changes|inspect
git diff --staged|Staged changes|inspect
git diff main...feature|Changes on feature since it diverged|inspect
git diff --name-only|Only file names|inspect
git diff --word-diff|Word-level diff|inspect
git show <sha>|Show a commit|inspect
git blame -L 10,20 <file>|Who changed lines 10-20|inspect
git bisect start|Start finding a bad commit|inspect
git grep -n "text"|Search tracked files|inspect
git reset --soft HEAD~1|Undo last commit, keep changes staged|undo
git reset HEAD~1|Undo last commit, keep changes unstaged|undo
git reset --hard HEAD~1|Undo last commit and discard changes (DANGER)|undo
git revert <sha>|New commit that undoes a commit|undo
git revert -m 1 <merge-sha>|Revert a merge commit|undo
git reflog|History of where HEAD has been|undo
git reset --hard ORIG_HEAD|Undo a merge/rebase/pull (DANGER)|undo
git checkout <sha> -- <path>|Restore a file from a commit (legacy)|undo
git restore --source=<sha> -- <path>|Restore a file from a commit|undo
git clean -n|Dry-run: show untracked files to delete|maint
git clean -fd|Delete untracked files and folders (DANGER)|maint
git clean -fdx|Also delete ignored files (DANGER)|maint
git cherry-pick <sha>|Copy a commit here|maint
git cherry-pick -x <sha>|Cherry-pick and record the source|maint
git format-patch -1 <sha>|Export a commit as a patch|maint
git am <file>|Apply patches from format-patch|maint
git apply --check <file>|Test whether a patch applies|maint
git archive -o out.zip HEAD|Zip the current tree|maint
git submodule update --init --recursive|Fetch submodules|maint
git worktree add ../dir <branch>|Another working directory|maint
git gc|Compact the repository|maint
git count-objects -vH|Repository size|maint
git filter-repo --path <file> --invert-paths|Remove a file from all history (DANGER)|maint`;
export const CHEATSHEET = CHEAT.split('\n').map(l => { const [cmd, desc, cat] = l.split('|'); return { cmd, desc, cat }; });

/** Case-insensitive AND search over command, description and category. */
export function searchCheatsheet(query, list = CHEATSHEET) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter(e => { const hay = `${e.cmd} ${e.desc} ${e.cat}`.toLowerCase(); return words.every(w => hay.includes(w)); });
}

// ---------------- reset vs revert vs restore explainer ----------------
export const EXPLAINER = {
  table: {
    head: ['', 'git reset', 'git revert', 'git restore'],
    rows: [
      ['What it changes', 'Moves the branch pointer (and optionally index / files)', 'Adds a NEW commit that undoes an old one', 'Only files (working tree and/or index)'],
      ['Rewrites history', 'Yes', 'No', 'No (no history is touched)'],
      ['Safe on pushed commits', 'No (needs a force push)', 'Yes', 'Yes (local only)'],
      ['Touches working files', '--hard only', 'Yes (applies inverse patch)', 'Yes'],
      ['Typical use', 'Throw away or redo local commits', 'Undo something already shared', 'Discard edits or unstage a file'],
    ],
  },
  diagrams: [
    { id: 'reset', title: 'git reset --hard HEAD~1', text: 'The branch label moves back one commit. C is no longer on any branch (it survives in the reflog for a while).',
      nodes: [{ label: 'A' }, { label: 'B' }, { label: 'C', state: 'faded' }], branch: { name: 'main', at: 1 }, ascii: 'A---B---C        (before: main -> C)\nA---B   C        (after:  main -> B, C unreachable)' },
    { id: 'revert', title: 'git revert C', text: 'History only grows: C\' (a new commit) contains the opposite change of C. Safe to push.',
      nodes: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: "C'", state: 'new' }], branch: { name: 'main', at: 3 }, ascii: 'A---B---C        (before: main -> C)\nA---B---C---C\'   (after:  main -> C\', which undoes C)' },
    { id: 'restore', title: 'git restore --source=B file.txt', text: 'No commit and no branch moves. Only file.txt in your working tree is replaced by its content from B.',
      nodes: [{ label: 'A' }, { label: 'B', state: 'source' }, { label: 'C' }], branch: { name: 'main', at: 2 }, ascii: 'A---B---C        main -> C (unchanged)\n    |\n    +--> file.txt copied into the working tree' },
  ],
};
