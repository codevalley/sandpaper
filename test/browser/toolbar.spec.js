import { test, expect } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSandpaperServer } from '../../src/server.js';
import { createFakeProviderServices } from '../helpers/server-fixture.js';

const ROOT = new URL('../..', import.meta.url).pathname;
let repo;
let pageFile;
let runner;
let codexRunner;
let providerServices;
let controller;
let baseUrl;

const READY_PROVIDERS = [
  { id: 'claude', label: 'Claude Code', available: true, compatible: true, authMethod: 'subscription' },
  { id: 'codex', label: 'Codex', available: true, compatible: true, authMethod: 'chatgpt' },
];

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

async function startProviderServer(page, {
  initialProvider = 'claude',
  defaultProvider = 'claude',
  diagnostics = READY_PROVIDERS,
} = {}) {
  await controller?.close();
  providerServices = createFakeProviderServices({ defaultProvider, diagnostics });
  runner = providerServices.runners.claude;
  codexRunner = providerServices.runners.codex;
  controller = createSandpaperServer(repo, { brain: true, initialProvider }, {
    registry: providerServices.registry,
    preferences: providerServices.preferences,
    sessions: providerServices.sessions,
    tokenFactory: () => 'browser-test-token',
  });
  baseUrl = await controller.listen();
  await page.goto(new URL('/hostile.html', baseUrl).href);
  await expect(page.locator('#sp-panel')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  repo = mkdtempSync(join(tmpdir(), 'sandpaper-browser-'));
  mkdirSync(join(repo, 'assets'));
  pageFile = join(repo, 'hostile.html');
  copyFileSync(join(ROOT, 'test/fixtures/hostile.html'), pageFile);
  copyFileSync(join(ROOT, 'test/fixtures/hostile.html'), join(repo, 'other.html'));
  copyFileSync(join(ROOT, 'brain/assets/brain.js'), join(repo, 'assets/brain.js'));
  copyFileSync(join(ROOT, 'brain/assets/brain.css'), join(repo, 'assets/brain.css'));
  await page.addInitScript(() => {
    localStorage.setItem('sp-welcomed:v1', '1');
    sessionStorage.setItem('sp-welcomed:v1', '1');
  });
  await startProviderServer(page);
});

test.afterEach(async () => {
  await controller?.close();
  rmSync(repo, { recursive: true, force: true });
});

test('provider bootstrap identity is accessible and every turn posts the selected provider', async ({ page }) => {
  const button = page.locator('#sp-provider-button');
  await expect(button).toHaveText(/Claude Code/);
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#sp-provider-menu')).toHaveAttribute('role', 'menu');
  await expect(page.locator('#sp-input')).toHaveAttribute('aria-label', 'Message Claude Code');

  const call = await submit(page, 'Use the default provider');
  expect(runner.calls[call].prompt).toContain('Use the default provider');
  expect(codexRunner.calls).toHaveLength(0);
  runner.complete(call);
});

test('provider selection is session-local, survives reload, and does not mutate the default', async ({ page }) => {
  let defaultPosts = 0;
  await page.route('**/__sandpaper/provider-default', async (route) => {
    defaultPosts += 1;
    await route.fallback();
  });

  await page.locator('#sp-provider-button').click();
  await page.locator('[data-provider="codex"]').click();
  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
  await expect(page.locator('#sp-input')).toHaveAttribute('aria-label', 'Message Codex');
  await expect(page.locator('[data-provider="codex"]')).toHaveAttribute('aria-checked', 'true');
  expect(defaultPosts).toBe(0);

  const stored = await page.evaluate(() => {
    const script = document.querySelector('script[data-sandpaper-bootstrap]');
    const bootstrap = JSON.parse(script.getAttribute('data-sandpaper-bootstrap'));
    return {
      key: `sp-provider:v1:${bootstrap.projectId}`,
      value: sessionStorage.getItem(`sp-provider:v1:${bootstrap.projectId}`),
    };
  });
  expect(stored.value).toBe('codex');
  expect(stored.key).toMatch(/^sp-provider:v1:[a-f0-9]{16}$/);

  await page.reload();
  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
  expect(defaultPosts).toBe(0);
  expect(providerServices.defaultProvider).toBe('claude');

  await page.locator('#sp-input').fill('Use Codex explicitly');
  await page.locator('#sp-send').click();
  await waitFor(() => codexRunner.calls.length === 1, 'Codex runner did not receive the turn');
  expect(runner.calls).toHaveLength(0);
  codexRunner.complete(0);
});

test('provider launch override controls initial identity without changing the manifest default', async ({ page }) => {
  await startProviderServer(page, { initialProvider: 'codex', defaultProvider: 'claude' });
  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
  await page.locator('#sp-provider-button').click();
  await expect(page.locator('[data-provider="claude"]')).toContainText('Default');
  await expect(page.locator('#sp-provider-default')).toBeEnabled();
  expect(providerServices.defaultProvider).toBe('claude');
});

test('provider storage discards unknown ids but preserves a known unavailable selection without fallback', async ({ page }) => {
  const key = await page.evaluate(() => {
    const script = document.querySelector('script[data-sandpaper-bootstrap]');
    const bootstrap = JSON.parse(script.getAttribute('data-sandpaper-bootstrap'));
    return `sp-provider:v1:${bootstrap.projectId}`;
  });
  await page.evaluate(({ storageKey }) => sessionStorage.setItem(storageKey, 'mystery-provider'), { storageKey: key });
  await page.reload();
  await expect(page.locator('#sp-provider-button')).toHaveText(/Claude Code/);
  expect(await page.evaluate(({ storageKey }) => sessionStorage.getItem(storageKey), { storageKey: key })).toBeNull();

  const unavailable = [
    READY_PROVIDERS[0],
    {
      id: 'codex', label: 'Codex', available: false, compatible: true,
      authMethod: null, unavailableCode: 'unauthenticated',
    },
  ];
  await startProviderServer(page, { diagnostics: unavailable });
  const unavailableKey = await page.evaluate(() => {
    const script = document.querySelector('script[data-sandpaper-bootstrap]');
    const bootstrap = JSON.parse(script.getAttribute('data-sandpaper-bootstrap'));
    return `sp-provider:v1:${bootstrap.projectId}`;
  });
  await page.evaluate(({ storageKey }) => sessionStorage.setItem(storageKey, 'codex'), { storageKey: unavailableKey });
  await page.reload();

  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
  await expect(page.locator('#sp-input')).toHaveAttribute('aria-label', 'Message Codex');
  await expect(page.locator('#sp-send')).toBeDisabled();
  await expect(page.locator('#sp-provider-default')).toBeDisabled();
  await expect(page.locator('#sp-provider-guidance')).toContainText(/sign in|login/i);
  expect(runner.calls).toHaveLength(0);
  expect(codexRunner.calls).toHaveLength(0);
});

test('unavailable provider remains visible and actionable but cannot be selected', async ({ page }) => {
  await startProviderServer(page, {
    diagnostics: [
      READY_PROVIDERS[0],
      {
        id: 'codex', label: 'Codex', available: false, compatible: false,
        authMethod: null, unavailableCode: 'binary_missing',
      },
    ],
  });
  await page.locator('#sp-provider-button').click();
  const codex = page.locator('[data-provider="codex"]');
  await expect(codex).toBeVisible();
  await expect(codex).toHaveAttribute('role', 'menuitemradio');
  await expect(codex).toHaveAttribute('aria-checked', 'false');
  await expect(codex).toHaveAttribute('aria-disabled', 'true');
  await codex.focus();
  await expect(page.locator('#sp-provider-guidance')).toContainText(/install Codex/i);
  await codex.click({ force: true });
  await expect(page.locator('#sp-provider-button')).toHaveText(/Claude Code/);
  await expect(page.locator('#sp-provider-guidance')).toBeVisible();
  await expect(page.locator('#sp-provider-guidance')).toContainText(/install Codex/i);
  const geometry = await page.evaluate(() => {
    const menu = document.querySelector('#sp-provider-menu').getBoundingClientRect();
    const guidance = document.querySelector('#sp-provider-guidance').getBoundingClientRect();
    const hit = document.elementFromPoint(guidance.left + guidance.width / 2, guidance.top + guidance.height / 2);
    return {
      menuTop: menu.top,
      menuBottom: menu.bottom,
      viewportHeight: window.innerHeight,
      guidanceHit: hit && (hit.id || hit.closest('#sp-provider-guidance')?.id),
    };
  });
  expect(geometry.menuTop).toBeGreaterThanOrEqual(0);
  expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.guidanceHit).toBe('sp-provider-guidance');
});

test('provider Make default commits only on success and never changes selection', async ({ page }) => {
  let requestSeen;
  const seen = new Promise((resolve) => { requestSeen = resolve; });
  let releaseRequest;
  await page.route('**/__sandpaper/provider-default', async (route) => {
    requestSeen();
    await new Promise((resolve) => { releaseRequest = resolve; });
    await route.fallback();
  });
  await page.locator('#sp-provider-button').click();
  await page.locator('[data-provider="codex"]').click();
  await page.locator('#sp-provider-button').click();
  await page.locator('#sp-provider-default').click();

  await seen;
  await expect(page.locator('#sp-provider-default')).toBeDisabled();
  await expect(page.locator('#sp-provider-default')).toHaveAttribute('aria-disabled', 'true');
  releaseRequest();

  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
  await expect(page.locator('#sp-provider-default')).toBeDisabled();
  await expect(page.locator('#sp-provider-default')).toContainText(/default/i);
  expect(providerServices.preferenceCalls.filter(([operation]) => operation === 'set')).toEqual([['set', 'codex']]);
  expect(providerServices.defaultProvider).toBe('codex');
});

for (const failure of [
  {
    name: 'structured provider default failure',
    install: (page) => page.route('**/__sandpaper/provider-default', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'default_refused', message: 'Default preference refused' } }),
    })),
    message: 'Default preference refused',
  },
  {
    name: 'network provider default failure',
    install: (page) => page.route('**/__sandpaper/provider-default', (route) => route.abort('connectionrefused')),
    message: /unreachable|failed/i,
  },
]) {
  test(`${failure.name} preserves the previous default and selected provider`, async ({ page }) => {
    await page.locator('#sp-provider-button').click();
    await page.locator('[data-provider="codex"]').click();
    await failure.install(page);
    await page.locator('#sp-provider-button').click();
    await page.locator('#sp-provider-default').click();

    await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
    await expect(page.locator('#sp-provider-default')).toBeEnabled();
    await expect(page.locator('#sp-provider-guidance')).toContainText(failure.message);
    expect(providerServices.defaultProvider).toBe('claude');
  });
}

test('provider default action is inert when the selected provider is already default', async ({ page }) => {
  let defaultPosts = 0;
  await page.route('**/__sandpaper/provider-default', async (route) => {
    defaultPosts += 1;
    await route.fallback();
  });
  await page.locator('#sp-provider-button').click();
  await expect(page.locator('#sp-provider-default')).toBeDisabled();
  await expect(page.locator('#sp-provider-default')).toContainText(/default/i);
  expect(defaultPosts).toBe(0);
});

test('provider accessibility keyboard model supports navigation, activation, dismissal, and focus return', async ({ page }) => {
  const button = page.locator('#sp-provider-button');
  const menu = page.locator('#sp-provider-menu');
  await button.focus();
  await button.press('ArrowDown');
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-provider="claude"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('[data-provider="codex"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(button).toHaveText(/Codex/);
  await expect(button).toBeFocused();

  await button.press('ArrowUp');
  await page.keyboard.press('Home');
  await expect(page.locator('[data-provider="claude"]')).toBeFocused();
  await page.keyboard.press(' ');
  await expect(button).toHaveText(/Claude Code/);
  await expect(button).toBeFocused();

  await button.press('Enter');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();

  await button.click();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(menu).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  await button.click();
  await page.locator('[data-provider="claude"]').press('Tab');
  await expect(menu).toBeHidden();
});

test('provider busy lifecycle locks every tab and matching idle restores controls', async ({ page, context }) => {
  const peer = await context.newPage();
  await peer.addInitScript(() => {
    localStorage.setItem('sp-welcomed:v1', '1');
    sessionStorage.setItem('sp-welcomed:v1', '1');
  });
  await peer.goto(new URL('/other.html', baseUrl).href);
  await expect(peer.locator('#sp-provider-button')).toBeEnabled();

  const call = await submit(page, 'Hold the global provider lifecycle');
  for (const tab of [page, peer]) {
    await expect(tab.locator('#sp-provider-button')).toBeDisabled();
    await expect(tab.locator('#sp-provider-default')).toBeDisabled();
    await expect(tab.locator('#sp-input')).toBeDisabled();
  }
  runner.complete(call);
  for (const tab of [page, peer]) {
    await expect(tab.locator('#sp-provider-button')).toBeEnabled();
    await expect(tab.locator('#sp-input')).toBeEnabled();
  }
  await peer.close();
});

test('provider welcome names both bootstrap providers and shows both command examples', async ({ context }) => {
  const tour = await context.newPage();
  await tour.addInitScript(() => {
    localStorage.removeItem('sp-welcomed:v1');
    sessionStorage.removeItem('sp-welcomed:v1');
  });
  await tour.goto(new URL('/hostile.html', baseUrl).href);
  await expect(tour.locator('#sp-welcome')).toBeVisible();
  await expect(tour.locator('.sp-w-provider-copy')).toContainText('Claude Code and Codex');
  await expect(tour.locator('.sp-w-tip')).toContainText('/sandpaper:theme');
  await expect(tour.locator('.sp-w-tip')).toContainText('$sandpaper theme');
  await tour.close();
});

test('provider identity remains visible when minimized and through request errors', async ({ page }) => {
  await page.locator('#sp-provider-button').click();
  await page.locator('[data-provider="codex"]').click();
  await page.locator('#sp-min').click();
  await expect(page.locator('#sp-panel')).toHaveClass(/sp-min/);
  await expect(page.locator('#sp-who')).toHaveText('Codex');

  await page.locator('#sp-head').click();
  await page.route('**/__sandpaper/turn', (route) => route.abort('connectionrefused'));
  await recoverableSubmit(page, 'Codex network draft');
  await expect(page.locator('#sp-head')).toContainText('Codex');
  await expect(page.locator('#sp-label')).not.toHaveText('Sending…');
  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
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

test('fresh tab terminal replay updates status without creating a blank transcript turn', async ({ page, context }) => {
  const call = await submit(page, 'Finish before fresh tab opens');
  runner.complete(call);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');

  const fresh = await context.newPage();
  await fresh.addInitScript(() => {
    localStorage.setItem('sp-welcomed:v1', '1');
    sessionStorage.setItem('sp-welcomed:v1', '1');
  });
  await fresh.goto(new URL('/hostile.html', baseUrl).href);
  await expect(fresh.locator('#sp-label')).toHaveText('done');
  await expect(fresh.locator('.sp-turn')).toHaveCount(0);
  await expect(fresh.locator('.sp-turnmeta')).toHaveCount(0);
  await fresh.close();
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

test('direct and undo request errors preserve an active turn busy state and unrelated scope', async ({ page }) => {
  const first = await submit(page, 'Create AI undo');
  const aiReload = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
  runner.edit(readFileSync(pageFile, 'utf8').replace('Gamma row', 'Gamma AI undo row'), first);
  runner.complete(first);
  await aiReload;
  const aiUndo = page.locator('.sp-turnmeta .sp-undo');
  await expect(aiUndo).toBeVisible();

  await enterHands(page);
  await editHtml(page, 'row-a', 'Create direct undo');
  const directUndo = page.locator('#sp-undo');
  await expect(directUndo).toBeVisible();

  const active = await submit(page, 'Hold this active turn');
  await expect(page.locator('#sp-chip')).toHaveClass(/sp-busy/);
  await page.locator('#sp-pick').dispatchEvent('click');
  await page.locator('[data-cid="row-c"]').dispatchEvent('click');
  const scoped = await page.locator('#sp-target').textContent();
  await expect(page.locator('#sp-target')).toBeVisible();

  await enterHands(page);
  await editHtml(page, 'row-b', 'Rejected during active AI');
  await expect(page.locator('#sp-label')).toHaveText('An AI turn is editing this page');
  await expect(page.locator('#sp-chip')).toHaveClass(/sp-busy/);
  await expect(page.locator('#sp-input')).toBeDisabled();
  await expect(page.locator('#sp-target')).toHaveText(scoped);

  await aiUndo.dispatchEvent('click');
  await expect(page.locator('#sp-label')).toHaveText('An AI turn is editing this page');
  await expect(page.locator('#sp-chip')).toHaveClass(/sp-busy/);
  await expect(page.locator('#sp-target')).toHaveText(scoped);

  await directUndo.dispatchEvent('click');
  await expect(page.locator('#sp-label')).toHaveText('An AI turn is editing this page');
  await expect(page.locator('#sp-chip')).toHaveClass(/sp-busy/);
  await expect(page.locator('#sp-target')).toHaveText(scoped);
  runner.complete(active);
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

test('additional mode changes are ignored while a Hands commit is pending', async ({ page }) => {
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
  await expect(page.locator('#sp-edit')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#sp-edit')).toBeDisabled();
  finishWrite();
  await expect(page.locator('#sp-edit')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#sp-pick')).toHaveAttribute('aria-pressed', 'true');
});

test('confirmed 4xx rich text rejection exact-rolls back without navigation', async ({ page }) => {
  await rejectMutation(page, 'write', 'Text write refused');
  await enterHands(page);
  const row = page.locator('[data-cid="row-a"]');
  const before = await row.evaluate((element) => element.innerHTML);
  const beforeFile = readFileSync(pageFile, 'utf8');
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await editHtml(page, 'row-a', '<em>Optimistic rich text</em>');

  await expect.poll(() => row.evaluate((element) => element.innerHTML)).toBe(before);
  expect(navigations).toBe(0);
  expect(readFileSync(pageFile, 'utf8')).toBe(beforeFile);
  await expect(page.locator('#sp-label')).toHaveText('Text write refused');
});

test('malformed direct response reloads into text already persisted by the real server', async ({ page }) => {
  let forwardedStatus = 0;
  await page.route('**/__sandpaper/write', async (route) => {
    const response = await route.fetch();
    forwardedStatus = response.status();
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: '{',
    });
  });
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

  await enterHands(page);
  await editHtml(page, 'row-a', '<em>Persisted despite malformed response</em>');

  await expect.poll(() => navigations).toBe(1);
  expect(forwardedStatus).toBe(200);
  await expect(page.locator('[data-cid="row-a"]')).toHaveText('Persisted despite malformed response');
  expect(readFileSync(pageFile, 'utf8')).toContain('<em>Persisted despite malformed response</em>');
});

test('structured 500 after a persisted direct write reloads from disk without rollback', async ({ page }) => {
  let forwardedStatus = 0;
  await page.route('**/__sandpaper/write', async (route) => {
    const response = await route.fetch();
    forwardedStatus = response.status();
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'write_recovery_failed', message: 'Write outcome requires reconciliation' },
      }),
    });
  });
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

  await enterHands(page);
  await editHtml(page, 'row-a', '<strong>Persisted despite structured 500</strong>');

  await expect.poll(() => navigations).toBe(1);
  expect(forwardedStatus).toBe(200);
  await expect(page.locator('[data-cid="row-a"]')).toHaveText('Persisted despite structured 500');
  expect(readFileSync(pageFile, 'utf8')).toContain('<strong>Persisted despite structured 500</strong>');
});

test('lost direct response reloads into structural edit already persisted by the real server', async ({ page }) => {
  let forwardedStatus = 0;
  await page.route('**/__sandpaper/dom', async (route) => {
    const response = await route.fetch();
    forwardedStatus = response.status();
    await route.abort('connectionreset');
  });
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

  await enterHands(page);
  await page.locator('[data-cid="row-b"]').dispatchEvent('mouseover');
  await page.locator('#sp-rowctl .sp-row-delete').dispatchEvent('click');

  await expect.poll(() => navigations).toBe(1);
  expect(forwardedStatus).toBe(200);
  await expect(page.locator('[data-cid="row-b"]')).toHaveCount(0);
  expect(readFileSync(pageFile, 'utf8')).not.toContain('data-cid="row-b"');
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

test('a pending direct transaction blocks a second optimistic mutation on the same node', async ({ page }) => {
  let requests = 0;
  let rejectFirst;
  await page.route('**/__sandpaper/write', async (route) => {
    requests += 1;
    await new Promise((resolve) => { rejectFirst = resolve; });
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: '{"ok":false,"error":{"code":"write_refused","message":"First write refused"}}',
    });
  });
  await enterHands(page);
  const row = page.locator('[data-cid="row-a"]');
  const original = await row.evaluate((element) => element.innerHTML);
  await editHtml(page, 'row-a', 'Alpha first transaction');
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator('#sp-edit')).toBeDisabled();
  await expect(page.locator('#sp-edit')).toHaveAttribute('aria-disabled', 'true');
  await row.dispatchEvent('click');
  await expect(row).not.toHaveAttribute('contenteditable', 'true');
  await row.dispatchEvent('mouseover');
  await expect(page.locator('#sp-rowctl')).toBeHidden();
  expect(requests).toBe(1);

  rejectFirst();
  await expect.poll(() => row.evaluate((element) => element.innerHTML)).toBe(original);
  await expect(page.locator('#sp-edit')).toBeEnabled();
  await expect(page.locator('#sp-edit')).toHaveAttribute('aria-disabled', 'false');
  expect(requests).toBe(1);
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

test('/ shortcut respects form and contenteditable targets inside a shadow root', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'shadow-shortcut-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    input.id = 'shadow-input';
    const editable = document.createElement('div');
    editable.id = 'shadow-editable';
    editable.contentEditable = 'true';
    editable.textContent = 'editable';
    shadow.append(input, editable);
    document.body.appendChild(host);
  });

  for (const id of ['shadow-input', 'shadow-editable']) {
    await page.evaluate((targetId) => {
      document.querySelector('#shadow-shortcut-host').shadowRoot.querySelector(`#${targetId}`).focus();
    }, id);
    await page.keyboard.press('/');
    const state = await page.evaluate(() => ({
      shadowActive: document.querySelector('#shadow-shortcut-host').shadowRoot.activeElement?.id,
      searchActive: document.activeElement?.id === 'brain-q',
    }));
    expect(state).toEqual({ shadowActive: id, searchActive: false });
  }
});

test('status, transcript, toolbar controls, and composer expose baseline semantics', async ({ page }) => {
  await expect(page.locator('#sp-chip')).toHaveAttribute('role', 'status');
  await expect(page.locator('#sp-chip')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#sp-chip')).toHaveAttribute('aria-atomic', 'true');
  await expect(page.locator('#sp-thread')).toHaveAttribute('role', 'log');
  await expect(page.locator('#sp-thread')).toHaveAttribute('aria-label', 'Sandpaper conversation');
  await expect(page.locator('#sp-thread')).toHaveAttribute('aria-live', 'off');
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

test('rehydrated disclosure IDs stay unique when a new turn adds controls', async ({ page }) => {
  const first = await submit(page, 'First disclosure turn');
  runner.emit({ type: 'assistant_delta', kind: 'thinking', text: 'First thought.' }, first);
  runner.emit({
    type: 'edit', tool: 'Edit', file: 'hostile.html', added: 1, removed: 1,
    hunks: [{ oldText: 'first before', newText: 'first after' }],
  }, first);
  runner.complete(first);
  await page.reload();

  const second = await submit(page, 'Second disclosure turn');
  runner.emit({ type: 'assistant_delta', kind: 'thinking', text: 'Second thought.' }, second);
  runner.emit({
    type: 'edit', tool: 'Edit', file: 'hostile.html', added: 1, removed: 1,
    hunks: [{ oldText: 'second before', newText: 'second after' }],
  }, second);
  runner.complete(second);

  const state = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('.sp-think-toggle, .sp-card-head'));
    const ids = controls.map((control) => control.getAttribute('aria-controls'));
    return {
      ids,
      targetCounts: ids.map((id) => document.querySelectorAll(`#${CSS.escape(id)}`).length),
    };
  });
  expect(new Set(state.ids).size).toBe(state.ids.length);
  expect(state.targetCounts.every((count) => count === 1)).toBe(true);
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
  await expect(dialog).toHaveAttribute('aria-labelledby', 'sp-welcome-title');
  await expect(tour.locator('#sp-welcome-title')).toHaveText('This page is your project’s brain.');
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
