import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../skill/sandpaper/', import.meta.url).pathname;
const actions = ['canvas', 'decide', 'help', 'init', 'learn', 'log', 'open', 'plan', 'release', 'serve', 'stamp', 'sync', 'theme'];
const frontmatter = {
  canvas: '---\ndescription: Elevate an explanation into a rich board on the cover\'s canvas (not the terminal)\n---',
  decide: '---\ndescription: Record a decision (or open/resolve a question) in the brain ledger\nargument-hint: "<the decision, and why>"\n---',
  help: '---\ndescription: List the Sandpaper commands and what each one does\n---',
  init: '---\ndescription: Scaffold a living Sandpaper brain for this repo — discover widely, run a wizard, generate\n---',
  learn: '---\ndescription: Record a gotcha or verdict learning in the brain\nargument-hint: "<what bit you, and the takeaway>"\n---',
  log: '---\ndescription: Add a work-log row to the brain (the heartbeat)\nargument-hint: "<what you did, ≤12 words>"\n---',
  open: '---\ndescription: Start the Sandpaper server and open the brain in your browser\n---',
  plan: '---\ndescription: Add or update a task/initiative on the Sandpaper plan board\nargument-hint: "flip t-NNNN done | add \\"<task>\\" to <initiative> | new initiative \\"<name>\\" in phase <0|1>"\n---',
  release: '---\ndescription: Cut a release — draft notes from the brain, pick a semver bump, tag, push\nargument-hint: "[optional: force patch | minor | major]"\n---',
  serve: '---\ndescription: Serve the brain (or any Sandpaper doc) with the on-page refine toolbar\n---',
  stamp: '---\ndescription: Stamp the Sandpaper brain after a substantive turn (the 6-step update)\nargument-hint: "[optional one-line summary of the turn]"\n---',
  sync: '---\ndescription: Reconcile the brain against the code — find and flag drift\n---',
  theme: '---\ndescription: Re-skin the Sandpaper brain from a brand colour or preset\nargument-hint: "<a brand hex like #2E6F95, or \\"preset: <name>\\">"\n---',
};

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function wrapperBody(action) {
  return `${frontmatter[action]}\n\nExecute the canonical Sandpaper workflow at
\`.claude/commands/sandpaper/references/workflows/${action}.md\` with these user arguments:\n\n\`$ARGUMENTS\`\n\nUse Claude Code's native interaction tools when that workflow requires human confirmation.\n`;
}

test('Claude wrappers and canonical workflows expose the same exact action inventory', () => {
  const expected = actions.map((action) => `${action}.md`);
  assert.deepEqual(readdirSync(join(root, 'commands')).filter((name) => name.endsWith('.md')).sort(), expected);
  assert.deepEqual(readdirSync(join(root, 'references', 'workflows')).filter((name) => name.endsWith('.md')).sort(), expected);
});

test('canonical workflows contain no provider routing syntax or provider-specific interaction names', () => {
  for (const action of actions) {
    assert.doesNotMatch(
      read(`references/workflows/${action}.md`),
      /\$ARGUMENTS|\/sandpaper:|AskUserQuestion|\bClaude(?: Code)?\b|\bCodex\b/,
      `${action} must remain provider neutral`,
    );
  }
});

test('each Claude command preserves valid frontmatter and is the exact thin wrapper', () => {
  for (const action of actions) {
    const command = read(`commands/${action}.md`);
    assert.match(command, /^---\n(?=[\s\S]*?^description: ).+?\n---\n\n/ms, `${action} must have valid frontmatter`);
    assert.equal(command, wrapperBody(action), `${action} must contain only the canonical workflow adapter`);
    assert.equal((command.match(/references\/workflows\//g) || []).length, 1, `${action} must name one canonical reference`);
  }
});

test('SKILL is a compact dispatcher with all actions, argument forwarding, and help fallback', () => {
  const skill = read('SKILL.md');
  const body = skill.replace(/^---[\s\S]*?---\n/, '');
  const words = body.trim().split(/\s+/);

  assert.match(skill, /^---\nname: sandpaper\ndescription: (?:>-\n\s+)?Use when[^\n]*(?:\n\s+[^#\n][^\n]*)*\n---\n/);
  assert.ok(words.length < 500, `SKILL must stay compact; found ${words.length} words`);
  for (const action of actions) assert.match(skill, new RegExp(`\\\`${action}\\\``), `dispatcher must list ${action}`);
  assert.match(skill, /Read and execute `references\/workflows\/<action>\.md`/);
  assert.match(skill, /treating the remaining words as arguments/);
  assert.match(skill, /If the action is absent or unknown, execute `references\/workflows\/help\.md`/);
  assert.match(skill, /normal user-input mechanism whenever the workflow requires human confirmation/);
  assert.match(skill, /repository files are canonical truth/i);
  assert.match(skill, /brain is canonical truth/i);
  assert.match(skill, /provider sessions are noncanonical compute context/i);
  assert.doesNotMatch(skill, /\/sandpaper:|\.claude\/settings|AskUserQuestion|SessionStart|Stop hook/);
});

test('action semantics live only in canonical references, not wrappers or SKILL', () => {
  const entrypoints = [read('SKILL.md'), ...actions.map((action) => read(`commands/${action}.md`))].join('\n');
  for (const semanticMarker of [
    'BRAIN:CANVAS',
    'Decision / Because / Instead-of',
    'count source files',
    'Keep-a-Changelog',
    'git status --porcelain',
    'BRAIN:NOW',
    'WCAG AA',
  ]) {
    assert.equal(entrypoints.includes(semanticMarker), false, `${semanticMarker} belongs only in a canonical workflow`);
  }
});

test('release workflow preserves the ordered safety and publication handoff contract', () => {
  const release = read('references/workflows/release.md');
  const orderedSections = [
    '## 1. Range',
    '## 2. Propose and confirm the bump',
    '## 3. Draft and show the notes',
    '## 4. Start clean, write, then stamp',
    '## 5. Stage only the release record',
    '## 6. Run the release gates',
    '## 7. Final human confirmation',
    '## 8. Version, verify tag, then push',
    '## 9. CI publish handoff',
  ];
  let previous = -1;
  for (const section of orderedSections) {
    const current = release.indexOf(section);
    assert.ok(current > previous, `${section} must exist in release order`);
    previous = current;
  }

  assert.match(release, /remaining user arguments/);
  assert.match(release, /native structured user-input\/confirmation mechanism/);
  assert.match(release, /human confirms every version bump/i);
  assert.match(release, /Show the draft before writing/i);
  assert.match(release, /clean-tree check must happen before any release file is written/i);
  assert.ok(release.indexOf('execute the canonical `stamp` workflow') < release.indexOf('npm version <bump>'));
  assert.match(release, /git add -- CHANGELOG\.md brain\/index\.html brain\/log\.html brain\/project\/index\.html brain\/map\.html/);
  assert.match(release, /staged-name list may contain only those five paths/i);
  for (const gate of [
    'npm run check:syntax',
    'npm test',
    'npm run test:browser',
    'npm run test:package',
    'node bin/cli.js doctor',
    'npm run verify-publish',
    'git diff --check',
    'git status --porcelain',
  ]) assert.match(release, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(release, /separate final human confirmation/i);
  assert.match(release, /Confirm that exact tag points at the version commit before pushing/i);
  assert.ok(release.indexOf('npm version <bump>') < release.indexOf('git push --follow-tags'));
  assert.match(release, /\.github\/workflows\/release\.yml/);
  assert.match(release, /Never publish to npm directly/i);
});
