import { test, expect } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSandpaperServer } from '../../src/server.js';
import { createFakeRunner } from '../helpers/server-fixture.js';

const ROOT = new URL('../..', import.meta.url).pathname;
let repo;
let controller;
let baseUrl;

function write(relative, contents) {
  const file = join(repo, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
}

function shell(body, script = './assets/brain.js') {
  return `<!doctype html><html><body>${body}<script src="${script}" defer></script></body></html>`;
}

test.beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'sandpaper-brain-browser-'));
  mkdirSync(join(repo, 'brain/assets'), { recursive: true });
  copyFileSync(join(ROOT, 'brain/assets/brain.js'), join(repo, 'brain/assets/brain.js'));
  write('brain/index.html', shell(`
    <b data-count="question:open">9</b>
    <b data-count="decision">9</b>
    <b data-count="learning">9</b>
    <span data-count="component:built">9</span>/<span data-count="component:total">9</span> built
    <span id="plan-overall">9/9 · 100%</span>
    <span data-phase-label="0">9/9 · 100%</span>
    <span data-phase-label="2">9/9 · 100%</span>
    <ul class="needs" data-open-list>
      <li id="row-open"><a href="./decisions.html#q-open">Keep this curated copy</a></li>
      <li id="row-resolved"><a href="./decisions.html#q-resolved">Keep this historical copy hidden</a></li>
    </ul>
  `));
  write('brain/project/index.html', shell(`
    <span id="plan-overall">stale</span>
    <span data-phase-label="0">stale</span>
    <span data-phase-label="2">stale</span>
    <article class="entry--initiative" data-phase="0">
      <li class="task" data-status="done"></li>
    </article>
    <article class="entry--initiative" data-phase="2">
      <li class="task" data-status="done"></li>
      <li class="task" data-status="todo"></li>
    </article>
  `, '../assets/brain.js'));
  write('brain/decisions.html', shell(`
    <article data-kind="decision" data-status="accepted"></article>
    <article data-kind="decision" data-status="accepted"></article>
    <article id="q-open" data-kind="question" data-status="open"></article>
    <article id="q-resolved" data-kind="question" data-status="resolved"></article>
  `));
  write('brain/map.html', shell(`
    <article data-kind="component" data-status="verified"></article>
    <article data-kind="component" data-status="built"></article>
    <article data-kind="component" data-status="wip"></article>
  `));
  write('brain/learnings.html', shell(`
    <aside data-kind="learning"></aside>
    <aside data-kind="learning"></aside>
    <aside data-kind="learning"></aside>
  `));
  controller = createSandpaperServer(repo, { brain: true }, {
    runner: createFakeRunner(),
    tokenFactory: () => 'brain-browser-token',
  });
  baseUrl = await controller.listen();
});

test.afterEach(async () => {
  await controller?.close();
  rmSync(repo, { recursive: true, force: true });
});

test('cover derives mechanical facts from the plan and books', async ({ page }) => {
  await page.goto(new URL('/brain/index.html', baseUrl).href);

  await expect(page.locator('[data-count="question:open"]')).toHaveText('1');
  await expect(page.locator('[data-count="decision"]')).toHaveText('2');
  await expect(page.locator('[data-count="learning"]')).toHaveText('3');
  await expect(page.locator('[data-count="component:built"]')).toHaveText('2');
  await expect(page.locator('[data-count="component:total"]')).toHaveText('3');
  await expect(page.locator('#plan-overall')).toHaveText('2/3 · 67%');
  await expect(page.locator('[data-phase-label="0"]')).toHaveText('1/1 · 100%');
  await expect(page.locator('[data-phase-label="2"]')).toHaveText('1/2 · 50%');
  await expect(page.locator('#row-open')).toBeVisible();
  await expect(page.locator('#row-open')).toHaveText('Keep this curated copy');
  await expect(page.locator('#row-resolved')).toBeHidden();
});

test('a blocked source fetch leaves every stamped fallback untouched', async ({ page }) => {
  await page.route('**/brain/{project/index.html,decisions.html,map.html,learnings.html}', (route) => route.abort('blockedbyclient'));
  await page.goto(new URL('/brain/index.html', baseUrl).href);

  await expect(page.locator('[data-count="question:open"]')).toHaveText('9');
  await expect(page.locator('[data-count="decision"]')).toHaveText('9');
  await expect(page.locator('[data-count="learning"]')).toHaveText('9');
  await expect(page.locator('[data-count="component:built"]')).toHaveText('9');
  await expect(page.locator('#plan-overall')).toHaveText('9/9 · 100%');
  await expect(page.locator('[data-phase-label="2"]')).toHaveText('9/9 · 100%');
  await expect(page.locator('#row-resolved')).toBeVisible();
});

test('a parse failure leaves stamped fallbacks untouched', async ({ page }) => {
  await page.addInitScript(() => {
    window.DOMParser = class BrokenDOMParser {
      parseFromString() { throw new Error('fixture parse failure'); }
    };
  });
  await page.goto(new URL('/brain/index.html', baseUrl).href);

  await expect(page.locator('[data-count="question:open"]')).toHaveText('9');
  await expect(page.locator('#plan-overall')).toHaveText('9/9 · 100%');
  await expect(page.locator('#row-resolved')).toBeVisible();
});

test('plan derivation handles every distinct data-phase', async ({ page }) => {
  await page.goto(new URL('/brain/project/index.html', baseUrl).href);

  await expect(page.locator('#plan-overall')).toHaveText('2/3 · 67%');
  await expect(page.locator('[data-phase-label="0"]')).toHaveText('1/1 · 100%');
  await expect(page.locator('[data-phase-label="2"]')).toHaveText('1/2 · 50%');
});
