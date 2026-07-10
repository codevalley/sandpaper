import { test, expect } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSandpaperServer } from '../../src/server.js';
import { createFakeRunner } from '../helpers/server-fixture.js';

const ROOT = new URL('../..', import.meta.url).pathname;
let repo;
let pageFile;
let runner;
let controller;
let baseUrl;

async function waitFor(predicate, message, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function submit(page, prompt) {
  const call = runner.calls.length;
  await page.locator('#sp-input').fill(prompt);
  await page.locator('#sp-send').click();
  await waitFor(() => runner.calls.length > call, `runner did not receive ${prompt}`);
  return call;
}

async function recoverableSubmit(page, prompt) {
  await page.locator('#sp-input').fill(prompt);
  await page.locator('#sp-send').click();
  await expect(page.locator('#sp-input')).toHaveValue(prompt);
  await expect(page.locator('#sp-input')).toBeEnabled();
  await expect(page.locator('#sp-input')).toBeFocused();
  await expect(page.locator('#sp-chip')).not.toHaveClass(/sp-busy/);
}

async function enterHands(page) {
  await page.locator('#sp-edit').dispatchEvent('click');
}

async function editHtml(page, cid, html) {
  const row = page.locator(`[data-cid="${cid}"]`);
  await row.dispatchEvent('click');
  await row.evaluate((element, value) => { element.innerHTML = value; }, html);
  await row.press('Enter');
}

async function rejectMutation(page, path, message = 'Mutation refused') {
  await page.route(`**/__sandpaper/${path}`, (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { code: 'mutation_refused', message } }),
  }));
}

test.beforeEach(async ({ page }) => {
  repo = mkdtempSync(join(tmpdir(), 'sandpaper-browser-'));
  mkdirSync(join(repo, 'assets'));
  pageFile = join(repo, 'hostile.html');
  copyFileSync(join(ROOT, 'test/fixtures/hostile.html'), pageFile);
  copyFileSync(join(ROOT, 'brain/assets/brain.js'), join(repo, 'assets/brain.js'));
  copyFileSync(join(ROOT, 'brain/assets/brain.css'), join(repo, 'assets/brain.css'));
  runner = createFakeRunner();
  controller = createSandpaperServer(repo, { brain: true }, {
    runner,
    tokenFactory: () => 'browser-test-token',
  });
  baseUrl = await controller.listen();
  await page.addInitScript(() => {
    localStorage.setItem('sp-welcomed:v1', '1');
    sessionStorage.setItem('sp-welcomed:v1', '1');
  });
  await page.goto(new URL('/hostile.html', baseUrl).href);
  await expect(page.locator('#sp-panel')).toBeVisible();
});

test.afterEach(async () => {
  await controller?.close();
  rmSync(repo, { recursive: true, force: true });
});

test('reply-only completion says Replied and has no AI undo', async ({ page }) => {
  const call = await submit(page, 'Reply only');
  runner.emit({ type: 'assistant_delta', kind: 'text', text: 'No file change.' }, call);
  runner.complete(call);

  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  await expect(page.locator('.sp-turnmeta .sp-undo')).toHaveCount(0);
});

test('disk edit completion says Saved and exposes enabled AI undo', async ({ page }) => {
  const call = await submit(page, 'Edit the page');
  const changed = readFileSync(pageFile, 'utf8').replace('Beta row', 'Beta saved row');
  runner.edit(changed, call);
  runner.complete(call);

  await expect(page.locator('.sp-turnmeta .sp-tag')).toContainText('Saved');
  await expect(page.locator('.sp-turnmeta .sp-undo')).toBeVisible();
  await expect(page.locator('.sp-turnmeta .sp-undo')).toBeEnabled();
});

test('AI reload rehydrates one completed transcript turn without duplication', async ({ page }) => {
  const navigation = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
  const call = await submit(page, 'Persist this turn');
  runner.edit(readFileSync(pageFile, 'utf8').replace('Gamma row', 'Gamma persisted row'), call);
  runner.complete(call);
  await navigation;

  await expect(page.locator('.sp-bubble')).toHaveCount(1);
  await expect(page.locator('.sp-bubble')).toHaveText('Persist this turn');
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveCount(1);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toContainText('Saved');
  await expect(page.locator('.sp-turnmeta .sp-undo')).toHaveCount(1);
});

for (const failure of [
  { name: '409', status: 409, body: { ok: false, error: { code: 'turn_in_progress', message: 'A turn is already in progress' } }, message: 'A turn is already in progress' },
  { name: 'authentication', status: 403, body: { ok: false, error: { code: 'invalid_token', message: 'Invalid Sandpaper token' } }, message: 'Invalid Sandpaper token' },
]) {
  test(`${failure.name} rejection restores the attempted turn and composer`, async ({ page }) => {
    await page.route('**/__sandpaper/turn', (route) => route.fulfill({
      status: failure.status,
      contentType: 'application/json',
      body: JSON.stringify(failure.body),
    }));
    await recoverableSubmit(page, `${failure.name} draft`);
    await expect(page.locator('#sp-label')).toHaveText(failure.message);
    await expect(page.locator('.sp-bubble')).toHaveText(`${failure.name} draft`);
  });
}

test('malformed response restores prompt and reports the response error', async ({ page }) => {
  await page.route('**/__sandpaper/turn', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: '{',
  }));
  await recoverableSubmit(page, 'Malformed draft');
  await expect(page.locator('#sp-label')).toHaveText('Sandpaper returned an invalid response');
});

test('network failure restores prompt and reports the transport error', async ({ page }) => {
  await page.route('**/__sandpaper/turn', (route) => route.abort('connectionrefused'));
  await recoverableSubmit(page, 'Network draft');
  await expect(page.locator('#sp-label')).not.toHaveText('Sending…');
  await expect(page.locator('#sp-label')).not.toHaveText('Bridge unreachable');
});

test('runner error restores the draft and keeps changed recovery truthful', async ({ page }) => {
  const call = await submit(page, 'Partial write draft');
  const changed = readFileSync(pageFile, 'utf8').replace('Beta row', 'Beta partial row');
  runner.edit(changed, call);
  runner.fail('model process exploded', call);

  await expect(page.locator('#sp-input')).toHaveValue('Partial write draft');
  await expect(page.locator('#sp-input')).toBeEnabled();
  await expect(page.locator('#sp-input')).toBeFocused();
  await expect(page.locator('.sp-err')).toContainText('model process exploded');
  await expect(page.locator('.sp-turnmeta .sp-tag')).toContainText('Saved');
  await expect(page.locator('.sp-turnmeta .sp-undo')).toBeVisible();
});

test('AI undo recovers after refusal and disappears after successful consumption', async ({ page }) => {
  const call = await submit(page, 'Make undoable AI edit');
  runner.edit(readFileSync(pageFile, 'utf8').replace('Gamma row', 'Gamma AI row'), call);
  runner.complete(call);
  const undo = page.locator('.sp-turnmeta .sp-undo');
  await expect(undo).toBeVisible();

  let refused = false;
  await page.route('**/__sandpaper/undo', async (route) => {
    if (!refused) {
      refused = true;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'turn_in_progress', message: 'An AI turn is editing this page' } }),
      });
      return;
    }
    await route.fallback();
  });
  await undo.click();
  await expect(undo).toHaveText('Undo');
  await expect(undo).toBeEnabled();
  await expect(page.locator('#sp-label')).toHaveText('An AI turn is editing this page');
  await undo.click();
  await expect(undo).toBeHidden();
});

test('direct undo recovers after refusal and disappears after successful consumption', async ({ page }) => {
  await page.locator('#sp-edit').click();
  const row = page.locator('[data-cid="row-a"]');
  await row.dispatchEvent('click');
  await row.evaluate((element) => { element.innerHTML = '<em>Alpha direct</em>'; });
  await row.press('Enter');
  const undo = page.locator('#sp-undo');
  await expect(undo).toBeVisible();

  let refused = false;
  await page.route('**/__sandpaper/undo-direct', async (route) => {
    if (!refused) {
      refused = true;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'turn_in_progress', message: 'An AI turn is editing this page' } }),
      });
      return;
    }
    await route.fallback();
  });
  await undo.click();
  await expect(undo).toHaveText('⟲ undo');
  await expect(undo).toBeEnabled();
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(undo).toBeHidden();
});

test('Pick and Hands are mutually exclusive pressed modes', async ({ page }) => {
  const pick = page.locator('#sp-pick');
  const hands = page.locator('#sp-edit');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await expect(hands).toHaveAttribute('aria-pressed', 'false');

  await pick.dispatchEvent('click');
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await expect(hands).toHaveAttribute('aria-pressed', 'false');

  await hands.dispatchEvent('click');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await expect(hands).toHaveAttribute('aria-pressed', 'true');

  await hands.dispatchEvent('click');
  await expect(pick).toHaveAttribute('aria-pressed', 'false');
  await expect(hands).toHaveAttribute('aria-pressed', 'false');
});

test('switching from Hands to Pick commits active rich text before Pick activates', async ({ page }) => {
  let releaseWrite;
  const writeSeen = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let finishWrite;
  await page.route('**/__sandpaper/write', async (route) => {
    releaseWrite();
    await new Promise((resolve) => { finishWrite = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"undoable":true}' });
  });

  await enterHands(page);
  const row = page.locator('[data-cid="row-a"]');
  await row.dispatchEvent('click');
  await row.evaluate((element) => { element.innerHTML = '<strong>Alpha committed</strong>'; });
  await page.locator('#sp-pick').dispatchEvent('click');
  await writeSeen;
  await expect(page.locator('#sp-pick')).toHaveAttribute('aria-pressed', 'false');
  finishWrite();
  await expect(page.locator('#sp-pick')).toHaveAttribute('aria-pressed', 'true');
  await expect(row).not.toHaveAttribute('contenteditable', 'true');
});

test('latest mode request wins while a Hands commit is pending', async ({ page }) => {
  let writeSeen;
  const requestSeen = new Promise((resolve) => { writeSeen = resolve; });
  let finishWrite;
  await page.route('**/__sandpaper/write', async (route) => {
    writeSeen();
    await new Promise((resolve) => { finishWrite = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"undoable":true}' });
  });
  await enterHands(page);
  const row = page.locator('[data-cid="row-a"]');
  await row.dispatchEvent('click');
  await row.evaluate((element) => { element.innerHTML = 'Pending mode save'; });
  await page.locator('#sp-pick').dispatchEvent('click');
  await requestSeen;
  await page.locator('#sp-edit').dispatchEvent('click');
  await expect(page.locator('#sp-edit')).toHaveAttribute('aria-pressed', 'true');
  finishWrite();
  await expect(page.locator('#sp-edit')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sp-pick')).toHaveAttribute('aria-pressed', 'false');
});

test('failed rich text write restores exact innerHTML without reload', async ({ page }) => {
  await rejectMutation(page, 'write', 'Text write refused');
  await enterHands(page);
  const row = page.locator('[data-cid="row-a"]');
  const before = await row.evaluate((element) => element.innerHTML);
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await editHtml(page, 'row-a', '<em>Optimistic rich text</em>');

  await expect.poll(() => row.evaluate((element) => element.innerHTML)).toBe(before);
  expect(navigations).toBe(0);
  await expect(page.locator('#sp-label')).toHaveText('Text write refused');
});

test('failed delete restores exact sibling bytes and order without reload', async ({ page }) => {
  await rejectMutation(page, 'dom', 'Delete refused');
  await enterHands(page);
  const rows = page.locator('#rows');
  const before = await rows.evaluate((element) => element.innerHTML);
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await page.locator('[data-cid="row-b"]').dispatchEvent('mouseover');
  await page.locator('#sp-rowctl .sp-row-delete').dispatchEvent('click');

  await expect.poll(() => rows.evaluate((element) => element.innerHTML)).toBe(before);
  expect(navigations).toBe(0);
  await expect(page.locator('#sp-label')).toHaveText('Delete refused');
});

test('failed move restores exact sibling bytes and order without reload', async ({ page }) => {
  await rejectMutation(page, 'dom', 'Move refused');
  await enterHands(page);
  const rows = page.locator('#rows');
  const before = await rows.evaluate((element) => element.innerHTML);
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await page.locator('[data-cid="row-a"]').dispatchEvent('mouseover');
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    document.querySelector('#sp-rowctl .sp-grip').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    const target = document.querySelector('[data-cid="row-c"]');
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: rect.bottom - 1 }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: rect.bottom - 1 }));
  });

  await expect.poll(() => rows.evaluate((element) => element.innerHTML)).toBe(before);
  expect(navigations).toBe(0);
  await expect(page.locator('#sp-label')).toHaveText('Move refused');
});

test('optimistic direct mutations are serialized', async ({ page }) => {
  let requests = 0;
  let releaseFirst;
  await page.route('**/__sandpaper/write', async (route) => {
    requests += 1;
    if (requests === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"undoable":true}' });
  });
  await enterHands(page);
  await editHtml(page, 'row-a', 'Alpha first transaction');
  await editHtml(page, 'row-b', 'Beta second transaction');
  await expect.poll(() => requests).toBe(1);
  releaseFirst();
  await expect.poll(() => requests).toBe(2);
});

test('direct undo is disabled while a queued direct mutation is active', async ({ page }) => {
  await enterHands(page);
  await editHtml(page, 'row-a', 'First undoable write');
  const undo = page.locator('#sp-undo');
  await expect(undo).toBeVisible();
  await expect(undo).toBeEnabled();

  let requestSeen;
  const seen = new Promise((resolve) => { requestSeen = resolve; });
  let finishWrite;
  await page.route('**/__sandpaper/write', async (route) => {
    requestSeen();
    await new Promise((resolve) => { finishWrite = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"undoable":true}' });
  });
  await editHtml(page, 'row-b', 'Second queued write');
  await seen;
  await expect(undo).toBeDisabled();
  finishWrite();
  await expect(undo).toBeEnabled();
});

test('direct success hides undo when server reports no snapshot', async ({ page }) => {
  await page.route('**/__sandpaper/write', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"ok":true,"undoable":false}',
  }));
  await enterHands(page);
  await editHtml(page, 'row-a', 'Alpha without snapshot');
  await expect(page.locator('#sp-label')).toContainText('Saved');
  await expect(page.locator('#sp-undo')).toBeHidden();
});

test('direct edit keeps the initiating tab and reloads only the peer tab', async ({ page, context }) => {
  const peer = await context.newPage();
  await peer.addInitScript(() => {
    localStorage.setItem('sp-welcomed:v1', '1');
    sessionStorage.setItem('sp-welcomed:v1', '1');
  });
  await peer.goto(new URL('/hostile.html', baseUrl).href);
  await expect(peer.locator('#sp-panel')).toBeVisible();
  let selfNavigations = 0;
  let peerNavigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) selfNavigations += 1; });
  peer.on('framenavigated', (frame) => { if (frame === peer.mainFrame()) peerNavigations += 1; });

  await enterHands(page);
  await editHtml(page, 'row-b', '<strong>Peer sees persisted edit</strong>');
  await expect(peer.locator('[data-cid="row-b"]')).toContainText('Peer sees persisted edit');
  expect(selfNavigations).toBe(0);
  expect(peerNavigations).toBe(1);
  await expect(page.locator('[data-cid="row-b"]')).toContainText('Peer sees persisted edit');
  await peer.close();
});

test('diff deletion and structural deletion use separate repaired selectors', async ({ page }) => {
  const call = await submit(page, 'Explain a diff');
  runner.emit({
    type: 'edit', tool: 'Edit', file: 'hostile.html', added: 1, removed: 1, cids: ['row-a'],
    hunks: [{ oldText: 'Alpha before', newText: 'Alpha after' }],
  }, call);
  runner.complete(call);

  await expect(page.locator('.sp-diff-del')).toHaveText('- Alpha before');
  await expect(page.locator('#sp-rowctl .sp-row-delete')).toHaveCount(1);
  await expect(page.locator('#sp-panel .sp-del, #sp-rowctl .sp-del')).toHaveCount(0);
});

test('timeline search natively hides unmatched rows', async ({ page }) => {
  await page.locator('#brain-q').fill('Alpha');
  await expect(page.locator('[data-cid="log-alpha"]')).toHaveJSProperty('hidden', false);
  await expect(page.locator('[data-cid="log-beta"]')).toHaveJSProperty('hidden', true);
});

test('/ shortcut ignores interactive targets, modifiers, composition, and prevented events', async ({ page }) => {
  for (const selector of ['#host-input', '#host-button', '#host-editable']) {
    await page.locator(selector).focus();
    await page.keyboard.press('/');
    await expect(page.locator(selector)).toBeFocused();
  }

  for (const init of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
    { isComposing: true },
    { prevented: true },
  ]) {
    const active = await page.evaluate((eventInit) => {
      document.body.tabIndex = -1;
      document.body.focus();
      const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true, ...eventInit });
      if (eventInit.prevented) event.preventDefault();
      document.dispatchEvent(event);
      return document.activeElement && document.activeElement.id;
    }, init);
    expect(active).not.toBe('brain-q');
  }
});

test('status, transcript, toolbar controls, and composer expose baseline semantics', async ({ page }) => {
  await expect(page.locator('#sp-chip')).toHaveAttribute('role', 'status');
  await expect(page.locator('#sp-chip')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#sp-chip')).toHaveAttribute('aria-atomic', 'true');
  await expect(page.locator('#sp-thread')).toHaveAttribute('role', 'log');
  await expect(page.locator('#sp-thread')).toHaveAttribute('aria-label', 'Sandpaper conversation');
  await expect(page.locator('#sp-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#sp-toggle')).toHaveAttribute('aria-controls', 'sp-thread');
  await expect(page.locator('#sp-pick')).toHaveAttribute('aria-label', 'Pick a page element');
  await expect(page.locator('#sp-edit')).toHaveAttribute('aria-label', 'Edit page content directly');
  await expect(page.locator('#sp-input')).toHaveAttribute('aria-label', 'Message Claude Code');
});

test('thinking and change-card disclosures are named buttons with expanded state', async ({ page }) => {
  const call = await submit(page, 'Show disclosure controls');
  runner.emit({ type: 'assistant_delta', kind: 'thinking', text: 'Considering the edit.' }, call);
  runner.emit({
    type: 'edit', tool: 'Edit', file: 'hostile.html', added: 1, removed: 1,
    hunks: [{ oldText: 'before', newText: 'after' }],
  }, call);
  runner.complete(call);

  const thinking = page.locator('.sp-think-toggle');
  const card = page.locator('.sp-card-head');
  await expect(thinking).toHaveJSProperty('tagName', 'BUTTON');
  await expect(thinking).toHaveAttribute('aria-expanded', 'false');
  await expect(thinking).toHaveAttribute('aria-controls', /.+/);
  await expect(card).toHaveJSProperty('tagName', 'BUTTON');
  await expect(card).toHaveAttribute('aria-expanded', 'false');
  await expect(card).toHaveAttribute('aria-controls', /.+/);
  await thinking.dispatchEvent('click');
  await card.dispatchEvent('click');
  await expect(thinking).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toHaveAttribute('aria-expanded', 'true');
});

test('welcome traps focus, closes on Escape, and restores prior focus', async ({ context }) => {
  const tour = await context.newPage();
  await tour.goto(new URL('/hostile.html', baseUrl).href);
  await tour.evaluate(() => {
    localStorage.removeItem('sp-welcomed:v1');
    sessionStorage.removeItem('sp-welcomed:v1');
  });
  await tour.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => document.querySelector('#host-input')?.focus(), { once: true });
  });
  await tour.reload();
  const dialog = tour.locator('#sp-welcome');
  await expect(dialog).toBeVisible();
  await expect(tour.locator('.sp-w-go')).toBeFocused();
  await tour.keyboard.press('Tab');
  await expect(tour.locator('.sp-w-x')).toBeFocused();
  await tour.keyboard.press('Shift+Tab');
  await expect(tour.locator('.sp-w-go')).toBeFocused();
  await tour.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(tour.locator('#host-input')).toBeFocused();
  await tour.close();
});

test('reduced motion disables saved movement and uses non-smooth reveal scrolling', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    Element.prototype.scrollIntoView = function (options) { window.__sandpaperScrollOptions = options; };
  });
  await page.evaluate(() => sessionStorage.setItem('sp-flash', '["row-c"]'));
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__sandpaperScrollOptions?.behavior)).toBe('auto');

  await enterHands(page);
  await editHtml(page, 'row-a', 'Reduced motion save');
  await expect(page.locator('[data-cid="row-a"]')).toHaveClass(/sp-saved/);
  const animation = await page.locator('[data-cid="row-a"]').evaluate((element) => getComputedStyle(element).animationName);
  expect(animation).toBe('none');
});

test('host CSS cannot alter overlay geometry or style host .sp-del content', async ({ page }) => {
  const overlay = await page.locator('#sp-panel').evaluate((element) => {
    const panelStyle = getComputedStyle(element);
    const toggleStyle = getComputedStyle(element.querySelector('#sp-toggle'));
    return {
      panelPosition: panelStyle.position,
      panelBoxSizing: panelStyle.boxSizing,
      panelWidth: element.getBoundingClientRect().width,
      togglePosition: toggleStyle.position,
      toggleWidth: element.querySelector('#sp-toggle').getBoundingClientRect().width,
      togglePadding: toggleStyle.paddingTop,
      toggleTransition: toggleStyle.transitionDuration,
    };
  });
  expect(overlay.panelPosition).toBe('fixed');
  expect(overlay.panelBoxSizing).toBe('border-box');
  expect(overlay.panelWidth).toBeLessThan(500);
  expect(overlay.togglePosition).toBe('static');
  expect(overlay.toggleWidth).toBeLessThan(80);
  expect(overlay.togglePadding).not.toBe('70px');
  expect(overlay.toggleTransition).not.toBe('8s');

  const hostDelete = await page.locator('#host-sp-del').evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, width: style.width, padding: style.paddingTop };
  });
  expect(hostDelete).toEqual({ background: 'rgb(20, 40, 60)', width: '123px', padding: '17px' });
});

test('overlay keyboard focus has a visible focus indicator', async ({ page }) => {
  await page.locator('#sp-toggle').focus();
  const outline = await page.locator('#sp-toggle').evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).not.toBe('0px');
});
