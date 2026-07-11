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

async function submit(page, prompt, targetRunner = runner) {
  const call = targetRunner.calls.length;
  await page.locator('#sp-input').fill(prompt);
  await page.locator('#sp-send').click();
  await waitFor(() => targetRunner.calls.length > call, `runner did not receive ${prompt}`);
  return call;
}

async function chooseProvider(page, provider) {
  await page.locator('#sp-provider-button').click();
  await page.locator(`[data-provider="${provider}"]`).click();
}

async function transcriptKey(page, provider, pathname = '/hostile.html') {
  return page.evaluate(({ providerId, pagePath }) => {
    const script = document.querySelector('script[data-sandpaper-bootstrap]');
    const bootstrap = JSON.parse(script.getAttribute('data-sandpaper-bootstrap'));
    return ['sp-thread:v2', bootstrap.projectId, pagePath, providerId].join(':');
  }, { providerId: provider, pagePath: pathname });
}

async function createProviderHistories(page) {
  const claudeCall = await submit(page, 'Claude history');
  runner.complete(claudeCall);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  await chooseProvider(page, 'codex');
  const codexCall = await submit(page, 'Codex history', codexRunner);
  codexRunner.complete(codexCall);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  return {
    claudeKey: await transcriptKey(page, 'claude'),
    codexKey: await transcriptKey(page, 'codex'),
  };
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

test('invalid bootstrap initial provider fails closed until an explicit ready provider is selected', async ({ page }) => {
  await startProviderServer(page, { initialProvider: 'mystery-provider', defaultProvider: 'claude' });
  const button = page.locator('#sp-provider-button');
  await expect(button).toHaveText(/Choose provider/);
  await expect(button).toBeEnabled();
  await expect(page.locator('#sp-input')).toBeDisabled();
  await expect(page.locator('#sp-send')).toBeDisabled();
  await expect(page.locator('#sp-provider-default')).toBeDisabled();
  await expect(page.locator('#sp-label')).toContainText(/choose a provider/i);

  await button.click();
  await expect(page.locator('[data-provider="claude"]')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-provider="codex"]')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#sp-provider-guidance')).toContainText(/choose an available provider/i);
  await page.locator('[data-provider="codex"]').click();

  await expect(button).toHaveText(/Codex/);
  await expect(page.locator('#sp-input')).toBeEnabled();
  await expect(page.locator('#sp-input')).toHaveAttribute('aria-label', 'Message Codex');
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

for (const response of [
  {
    name: '200 error-shaped provider default response',
    body: JSON.stringify({ ok: false, error: { code: 'default_refused', message: 'Default preference refused in body' } }),
    message: 'Default preference refused in body',
  },
  { name: 'empty-object provider default response', body: '{}', message: /invalid default response/i },
  {
    name: 'wrong-provider default response',
    body: JSON.stringify({ ok: true, defaultProvider: 'claude' }),
    message: /invalid default response/i,
  },
  { name: 'malformed provider default response', body: '{', message: /invalid response/i },
  { name: 'empty provider default response', body: '', message: /invalid response/i },
]) {
  test(`${response.name} fails closed without changing local markers`, async ({ page }) => {
    await page.locator('#sp-provider-button').click();
    await page.locator('[data-provider="codex"]').click();
    await page.route('**/__sandpaper/provider-default', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: response.body,
    }));
    await page.locator('#sp-provider-button').click();
    await page.locator('#sp-provider-default').click();

    await expect(page.locator('#sp-provider-menu')).toBeVisible();
    await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
    await expect(page.locator('#sp-provider-default')).toBeEnabled();
    await expect(page.locator('#sp-provider-default')).toContainText(/Make Codex default/);
    await expect(page.locator('[data-provider="claude"]')).toContainText('Default');
    await expect(page.locator('#sp-provider-guidance')).toContainText(response.message);
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
  await page.keyboard.press('ArrowDown');
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
  await expect(page.locator('[data-provider="codex"]')).toBeFocused();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
});

test('provider accessibility reaches and activates Make default with arrows and coherent Tab traversal', async ({ page }) => {
  const button = page.locator('#sp-provider-button');
  const menu = page.locator('#sp-provider-menu');
  const claude = page.locator('[data-provider="claude"]');
  const codex = page.locator('[data-provider="codex"]');
  const makeDefault = page.locator('#sp-provider-default');
  const newSession = page.locator('#sp-provider-new-session');

  await button.click();
  await codex.click();
  await button.press('ArrowDown');
  await expect(claude).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(codex).toBeFocused();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(makeDefault).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(newSession).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(makeDefault).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(codex).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(claude).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();

  await button.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(makeDefault).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(makeDefault).toContainText(/default/i);
  await expect(makeDefault).toBeDisabled();
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
  expect(providerServices.defaultProvider).toBe('codex');
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

test('provider switch clears stale Claude header cost before showing Codex identity', async ({ page }) => {
  const call = await submit(page, 'Report Claude cost');
  runner.emit({ type: 'status', state: 'done', label: 'done', done: true, cost: 0.1234 }, call);
  await expect(page.locator('#sp-cost')).toHaveText('$0.1234');
  await expect(page.locator('#sp-cost')).toBeVisible();

  await page.locator('#sp-provider-button').click();
  await page.locator('[data-provider="codex"]').click();

  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
  await expect(page.locator('#sp-cost')).toBeHidden();
  await expect(page.locator('#sp-cost')).toHaveText('');

  await page.reload();
  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
  await expect(page.locator('#sp-cost')).toBeHidden();
  await expect(page.locator('#sp-cost')).toHaveText('');
});

test('Claude and Codex histories use exact independent project/page/provider keys through switch and reload', async ({ page }) => {
  const legacyKey = 'sp-thread:/hostile.html';
  await page.evaluate((key) => sessionStorage.setItem(key, '<div>legacy shared history</div>'), legacyKey);

  const call = await submit(page, 'Remember the accepted provider');
  runner.complete(call);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  const claudeKey = await transcriptKey(page, 'claude');
  const codexKey = await transcriptKey(page, 'codex');
  expect(claudeKey).toMatch(/^sp-thread:v2:[a-f0-9]{16}:\/hostile\.html:claude$/);
  expect(codexKey).toMatch(/^sp-thread:v2:[a-f0-9]{16}:\/hostile\.html:codex$/);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), claudeKey)).toContain('Remember the accepted provider');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), codexKey)).toBeNull();

  await chooseProvider(page, 'codex');
  await expect(page.locator('#sp-thread')).not.toContainText('Remember the accepted provider');
  const codexCall = await submit(page, 'Keep the Codex transcript separate', codexRunner);
  codexRunner.complete(codexCall);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), codexKey)).toContain('Keep the Codex transcript separate');

  await chooseProvider(page, 'claude');
  await expect(page.locator('#sp-thread')).toContainText('Remember the accepted provider');
  await expect(page.locator('#sp-thread')).not.toContainText('Keep the Codex transcript separate');
  await expect(page.locator('.sp-turn[data-turn]').first()).toHaveAttribute('data-turn-provider', 'claude');

  await chooseProvider(page, 'codex');
  await page.reload();

  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
  await expect(page.locator('#sp-thread')).toContainText('Keep the Codex transcript separate');
  await expect(page.locator('#sp-thread')).not.toContainText('Remember the accepted provider');
  await expect(page.locator('.sp-turn[data-turn]').first()).toHaveAttribute('data-turn-provider', 'codex');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), legacyKey)).toBe('<div>legacy shared history</div>');
});

test('rehydrate rejects missing, unknown, and mismatched persisted provider markers without relabeling', async ({ page }) => {
  const call = await submit(page, 'Persist a provider marker');
  runner.complete(call);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  const key = await transcriptKey(page, 'claude');
  await page.evaluate((storageKey) => {
    const key = storageKey;
    const saved = sessionStorage.getItem(key);
    const withId = (html, id) => html.replace(/data-turn="[^"]+"/, `data-turn="${id}"`);
    sessionStorage.setItem(key, saved
      + withId(saved.replace('data-turn-provider="claude"', 'data-turn-provider="mystery-provider"'), 'mystery-turn')
      + withId(saved.replace(' data-turn-provider="claude"', ''), 'missing-provider-turn')
      + withId(saved.replace('data-turn-provider="claude"', 'data-turn-provider="codex"'), 'codex-turn'));
  }, key);
  await page.reload();

  await expect(page.locator('#sp-provider-button')).toHaveText(/Claude Code/);
  await expect(page.locator('.sp-turn[data-turn-provider="claude"]')).toHaveCount(1);
  await expect(page.locator('.sp-turn[data-turn-provider="codex"]')).toHaveCount(0);
  await expect(page.locator('.sp-turn:not([data-turn-provider])')).toHaveCount(0);
  await expect(page.locator('.sp-turn[data-turn-provider="mystery-provider"]')).toHaveCount(0);
});

test('rehydrate admits only structurally complete turns with safe unique identities', async ({ page }) => {
  const call = await submit(page, 'Seed structurally valid history');
  runner.complete(call);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  const key = await transcriptKey(page, 'claude');
  await page.evaluate((storageKey) => {
    const holder = document.createElement('div');
    holder.innerHTML = sessionStorage.getItem(storageKey);
    const source = holder.querySelector('.sp-turn');
    const copy = (id) => {
      const clone = source.cloneNode(true);
      clone.setAttribute('data-turn', id);
      return clone;
    };
    const survivor = copy('safe-survivor');
    const duplicateA = copy('duplicate-id');
    const duplicateB = copy('duplicate-id');
    const empty = copy('');
    const missingProse = copy('missing-prose');
    missingProse.querySelector('.sp-prose').remove();
    const malformedCard = copy('malformed-card');
    const card = document.createElement('div');
    card.className = 'sp-card';
    card.innerHTML = '<span class="sp-card-title">incomplete</span>';
    malformedCard.querySelector('.sp-asst').appendChild(card);
    const thinkingNoToggle = copy('thinking-no-toggle');
    thinkingNoToggle.querySelector('.sp-think-toggle').remove();
    const thinkingMisnested = copy('thinking-misnested');
    thinkingMisnested.querySelector('.sp-asst').appendChild(thinkingMisnested.querySelector('.sp-think-toggle'));
    const thinkingDuplicate = copy('thinking-duplicate');
    thinkingDuplicate.querySelector('.sp-think').appendChild(thinkingDuplicate.querySelector('.sp-think-toggle').cloneNode(true));
    const thinkingWrongControls = copy('thinking-wrong-controls');
    thinkingWrongControls.querySelector('.sp-think-toggle').setAttribute('aria-controls', 'wrong-thinking-body');
    const thinkingWrongAct = copy('thinking-wrong-act');
    thinkingWrongAct.querySelector('.sp-think-toggle').setAttribute('data-act', 'card');
    const thinkingNotButton = copy('thinking-not-button');
    const fakeToggle = document.createElement('span');
    for (const attribute of thinkingNotButton.querySelector('.sp-think-toggle').attributes) {
      fakeToggle.setAttribute(attribute.name, attribute.value);
    }
    thinkingNotButton.querySelector('.sp-think-toggle').replaceWith(fakeToggle);
    const withCard = (id) => {
      const clone = copy(id);
      const nextCard = document.createElement('div');
      nextCard.className = 'sp-card';
      nextCard.innerHTML = '<button class="sp-card-head" type="button" data-act="card" aria-controls="sp-card-body-tamper">' +
        '<span class="sp-card-title">card</span></button><div class="sp-card-body" id="sp-card-body-tamper" hidden></div>';
      clone.querySelector('.sp-asst').appendChild(nextCard);
      return clone;
    };
    const cardNoHead = withCard('card-no-head');
    cardNoHead.querySelector('.sp-card-head').remove();
    const cardMisnestedBody = withCard('card-misnested-body');
    cardMisnestedBody.querySelector('.sp-card-head').appendChild(cardMisnestedBody.querySelector('.sp-card-body'));
    const cardMisnestedTitle = withCard('card-misnested-title');
    cardMisnestedTitle.querySelector('.sp-card').appendChild(cardMisnestedTitle.querySelector('.sp-card-title'));
    const cardWrongControls = withCard('card-wrong-controls');
    cardWrongControls.querySelector('.sp-card-head').setAttribute('aria-controls', 'wrong-card-body');
    const cardDuplicateHead = withCard('card-duplicate-head');
    cardDuplicateHead.querySelector('.sp-card').appendChild(cardDuplicateHead.querySelector('.sp-card-head').cloneNode(true));
    const cardWrongAct = withCard('card-wrong-act');
    cardWrongAct.querySelector('.sp-card-head').setAttribute('data-act', 'think');
    const cardHeadNotButton = withCard('card-head-not-button');
    const fakeHead = document.createElement('div');
    for (const attribute of cardHeadNotButton.querySelector('.sp-card-head').attributes) {
      fakeHead.setAttribute(attribute.name, attribute.value);
    }
    while (cardHeadNotButton.querySelector('.sp-card-head').firstChild) {
      fakeHead.appendChild(cardHeadNotButton.querySelector('.sp-card-head').firstChild);
    }
    cardHeadNotButton.querySelector('.sp-card-head').replaceWith(fakeHead);
    holder.replaceChildren(
      survivor,
      duplicateA,
      duplicateB,
      empty,
      missingProse,
      malformedCard,
      thinkingNoToggle,
      thinkingMisnested,
      thinkingDuplicate,
      thinkingWrongControls,
      thinkingWrongAct,
      thinkingNotButton,
      cardNoHead,
      cardMisnestedBody,
      cardMisnestedTitle,
      cardWrongControls,
      cardDuplicateHead,
      cardWrongAct,
      cardHeadNotButton,
      Object.assign(document.createElement('div'), { textContent: 'not a turn' }),
    );
    sessionStorage.setItem(storageKey, holder.innerHTML);
  }, key);
  await page.addInitScript(() => {
    class FakeEventSource {
      constructor() { window.__sandpaperFakeEvents = this; }
      close() {}
    }
    window.EventSource = FakeEventSource;
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.reload();

  await expect(page.locator('.sp-turn')).toHaveCount(1);
  await expect(page.locator('.sp-turn')).toHaveAttribute('data-turn', 'safe-survivor');
  for (const turnId of [
    'duplicate-id', '', 'missing-prose', 'malformed-card',
    'thinking-no-toggle', 'thinking-misnested', 'thinking-duplicate', 'thinking-wrong-controls',
    'thinking-wrong-act', 'thinking-not-button',
    'card-no-head', 'card-misnested-body', 'card-misnested-title', 'card-wrong-controls', 'card-duplicate-head',
    'card-wrong-act', 'card-head-not-button',
  ]) {
    await page.evaluate((id) => {
      window.__sandpaperFakeEvents.onmessage({
        data: JSON.stringify({
          type: 'assistant_delta', turnId: id, provider: 'claude', page: '/hostile.html',
          kind: 'text', text: 'discarded structural frame',
        }),
      });
    }, turnId);
  }
  await expect(page.locator('#sp-thread')).not.toContainText('discarded structural frame');
  expect(pageErrors).toEqual([]);
});

test('inactive, missing, unknown, and turn-mismatched provider frames cannot mutate or persist the selected transcript', async ({ page }) => {
  const call = await submit(page, 'Protected Claude history');
  runner.complete(call);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  const key = await transcriptKey(page, 'claude');
  const turnId = await page.locator('.sp-turn[data-turn]').getAttribute('data-turn');

  await page.addInitScript(() => {
    class FakeEventSource {
      constructor() { window.__sandpaperFakeEvents = this; }
      close() {}
    }
    window.EventSource = FakeEventSource;
  });
  await page.reload();
  const before = await page.evaluate((storageKey) => ({
    html: document.querySelector('#sp-thread').innerHTML,
    stored: sessionStorage.getItem(storageKey),
    label: document.querySelector('#sp-label').textContent,
  }), key);

  for (const frame of [
    { type: 'assistant_delta', turnId, provider: 'codex', page: '/hostile.html', kind: 'text', text: 'Codex contamination' },
    { type: 'assistant_delta', turnId, page: '/hostile.html', kind: 'text', text: 'Missing-provider contamination' },
    { type: 'edit', turnId, provider: 'mystery-provider', page: '/hostile.html', file: 'hostile.html', added: 1, removed: 0 },
    { type: 'status', turnId, provider: 'codex', page: '/hostile.html', state: 'error', label: 'Wrong provider error' },
    { type: 'assistant_delta', turnId: 'unknown-turn', provider: 'claude', page: '/hostile.html', kind: 'text', text: 'Unknown turn contamination' },
    { type: 'usage', turnId: 'unknown-turn', provider: 'claude', page: '/hostile.html', totalTokens: 99 },
  ]) {
    await page.evaluate((value) => {
      window.__sandpaperFakeEvents.onmessage({ data: JSON.stringify(value) });
    }, frame);
  }

  const after = await page.evaluate((storageKey) => ({
    html: document.querySelector('#sp-thread').innerHTML,
    stored: sessionStorage.getItem(storageKey),
    label: document.querySelector('#sp-label').textContent,
  }), key);
  expect(after).toEqual(before);
});

test('same-provider peer frames cannot claim a local optimistic turn before its rejected response', async ({ page, context }) => {
  const peer = await context.newPage();
  await peer.addInitScript(() => {
    localStorage.setItem('sp-welcomed:v1', '1');
    sessionStorage.setItem('sp-welcomed:v1', '1');
    class FakeEventSource {
      constructor() { window.__sandpaperFakeEvents = this; }
      close() {}
    }
    window.EventSource = FakeEventSource;
  });
  await peer.goto(new URL('/hostile.html', baseUrl).href);

  const ownerCall = await submit(page, 'Owner tab turn');
  await expect(page.locator('.sp-turn[data-turn]')).toHaveCount(1);
  const ownerTurnId = await page.locator('.sp-turn[data-turn]').getAttribute('data-turn');
  let releaseRejection;
  await peer.route('**/__sandpaper/turn', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await new Promise((resolve) => { releaseRejection = resolve; });
    await route.fulfill({ status: response.status(), headers: response.headers(), body });
  });
  await peer.locator('#sp-input').fill('Peer tab rejected turn');
  await peer.locator('#sp-send').click();
  await expect.poll(() => typeof releaseRejection).toBe('function');

  for (const text of ['owner early frame', 'owner second frame']) {
    await peer.evaluate(({ turnId, frameText }) => {
      window.__sandpaperFakeEvents.onmessage({
        data: JSON.stringify({
          type: 'assistant_delta', turnId, provider: 'claude', page: '/hostile.html',
          kind: 'text', text: frameText,
        }),
      });
    }, { turnId: ownerTurnId, frameText: text });
  }
  for (const frame of [
    { type: 'status', turnId: ownerTurnId, provider: 'claude', page: '/hostile.html', state: 'thinking', label: 'owner foreign busy' },
    { type: 'status', turnId: ownerTurnId, provider: 'claude', page: '/hostile.html', state: 'error', label: 'owner foreign error' },
    { type: 'status', turnId: ownerTurnId, provider: 'claude', page: '/hostile.html', state: 'done', label: 'owner foreign done', done: true, cost: 42 },
  ]) {
    await peer.evaluate((value) => window.__sandpaperFakeEvents.onmessage({ data: JSON.stringify(value) }), frame);
  }
  await expect(peer.locator('.sp-bubble')).toHaveText('Peer tab rejected turn');
  await expect(peer.locator('#sp-thread')).not.toContainText('owner early frame');
  await expect(peer.locator('.sp-turn')).not.toHaveAttribute('data-turn', ownerTurnId);
  await expect(peer.locator('#sp-label')).toHaveText('Sending…');
  await expect(peer.locator('#sp-cost')).toBeHidden();

  releaseRejection();
  await expect(peer.locator('#sp-input')).toHaveValue('Peer tab rejected turn');
  await expect(peer.locator('#sp-label')).toContainText(/turn is already in progress/i);
  await peer.evaluate((turnId) => {
    window.__sandpaperFakeEvents.onmessage({
      data: JSON.stringify({
        type: 'assistant_delta', turnId, provider: 'claude', page: '/hostile.html',
        kind: 'text', text: 'owner late frame',
      }),
    });
  }, ownerTurnId);
  for (const frame of [
    { type: 'status', turnId: ownerTurnId, provider: 'claude', page: '/hostile.html', state: 'thinking', label: 'owner late busy' },
    { type: 'status', turnId: ownerTurnId, provider: 'claude', page: '/hostile.html', state: 'error', label: 'owner late error' },
    { type: 'status', turnId: ownerTurnId, provider: 'claude', page: '/hostile.html', state: 'done', label: 'owner late done', done: true, cost: 42 },
  ]) {
    await peer.evaluate((value) => window.__sandpaperFakeEvents.onmessage({ data: JSON.stringify(value) }), frame);
  }
  await expect(peer.locator('#sp-thread')).not.toContainText(/owner (early|second|late) frame/);
  await expect(peer.locator('.sp-turn')).not.toHaveAttribute('data-turn', ownerTurnId);
  await expect(peer.locator('#sp-label')).toContainText(/turn is already in progress/i);
  await expect(peer.locator('#sp-input')).toBeEnabled();
  await expect(peer.locator('#sp-cost')).toBeHidden();

  runner.complete(ownerCall);
  await peer.close();
});

test('the initiating tab replays only its ordered frames after an exact accepted 202 binds the turn', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeEventSource {
      constructor() { window.__sandpaperFakeEvents = this; }
      close() {}
    }
    window.EventSource = FakeEventSource;
  });
  await page.reload();
  let accepted;
  let releaseAccepted;
  await page.route('**/__sandpaper/turn', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    accepted = { status: response.status(), headers: response.headers(), body, json: JSON.parse(body) };
    await new Promise((resolve) => { releaseAccepted = resolve; });
    await route.fulfill({ status: accepted.status, headers: accepted.headers, body: accepted.body });
  });

  const call = await submit(page, 'Frames before acceptance');
  await expect.poll(() => accepted && accepted.json.turnId).toBeTruthy();
  const turnId = accepted.json.turnId;
  runner.complete(call);
  for (const frame of [
    { type: 'assistant_delta', turnId: 'foreign-turn', provider: 'claude', page: '/hostile.html', kind: 'text', text: 'foreign buffered text' },
    { type: 'status', turnId: 'foreign-turn', provider: 'claude', page: '/hostile.html', state: 'thinking', label: 'foreign buffered busy' },
    { type: 'status', turnId: 'foreign-turn', provider: 'claude', page: '/hostile.html', state: 'error', label: 'foreign buffered error' },
    { type: 'status', turnId: 'foreign-turn', provider: 'claude', page: '/hostile.html', state: 'done', label: 'foreign buffered done', done: true, cost: 99 },
    { type: 'assistant_delta', turnId, provider: 'claude', page: '/hostile.html', kind: 'text', text: 'first then ' },
    { type: 'assistant_delta', turnId, provider: 'claude', page: '/hostile.html', kind: 'text', text: 'second' },
    { type: 'status', turnId, provider: 'claude', page: '/hostile.html', state: 'done', label: 'done', done: true, changed: false, undoable: false },
  ]) {
    await page.evaluate((value) => window.__sandpaperFakeEvents.onmessage({ data: JSON.stringify(value) }), frame);
  }
  await expect(page.locator('.sp-prose')).toHaveText('');
  await expect(page.locator('.sp-turnmeta')).toBeHidden();
  await expect(page.locator('#sp-label')).toHaveText('Sending…');
  await expect(page.locator('#sp-cost')).toBeHidden();

  releaseAccepted();
  await expect(page.locator('.sp-turn')).toHaveAttribute('data-turn', turnId);
  await expect(page.locator('.sp-prose')).toHaveText('first then second');
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  await expect(page.locator('#sp-thread')).not.toContainText('foreign buffered text');
  await expect(page.locator('#sp-label')).toHaveText('done');
  await expect(page.locator('#sp-input')).toBeEnabled();
  for (const frame of [
    { type: 'status', turnId: 'foreign-turn', provider: 'claude', page: '/hostile.html', state: 'thinking', label: 'foreign accepted busy' },
    { type: 'status', turnId: 'foreign-turn', provider: 'claude', page: '/hostile.html', state: 'error', label: 'foreign accepted error' },
    { type: 'status', turnId: 'foreign-turn', provider: 'claude', page: '/hostile.html', state: 'done', label: 'foreign accepted done', done: true, cost: 99 },
  ]) {
    await page.evaluate((value) => window.__sandpaperFakeEvents.onmessage({ data: JSON.stringify(value) }), frame);
  }
  await expect(page.locator('#sp-label')).toHaveText('done');
  await expect(page.locator('#sp-input')).toBeEnabled();
  await expect(page.locator('#sp-chip')).not.toHaveClass(/sp-busy/);
  await expect(page.locator('#sp-cost')).toBeHidden();
});

test('transcript storage write failures stay local and never copy history across provider keys', async ({ page }) => {
  const legacyKey = 'sp-thread:/hostile.html';
  await page.evaluate((key) => {
    sessionStorage.setItem(key, '<div>legacy sentinel</div>');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (storageKey, value) {
      if (storageKey.startsWith('sp-thread:v2:')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return original.call(this, storageKey, value);
    };
  }, legacyKey);
  const call = await submit(page, 'Visible despite quota failure');
  runner.complete(call);
  await expect(page.locator('#sp-thread')).toContainText('Visible despite quota failure');
  await chooseProvider(page, 'codex');
  await expect(page.locator('#sp-thread .sp-turn')).toHaveCount(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), legacyKey)).toBe('<div>legacy sentinel</div>');
});

test('two tabs may select different providers while one lifecycle globally locks turn, switch, and reset controls', async ({ page, context }) => {
  const peer = await context.newPage();
  await peer.addInitScript(() => {
    localStorage.setItem('sp-welcomed:v1', '1');
    sessionStorage.setItem('sp-welcomed:v1', '1');
  });
  await peer.goto(new URL('/other.html', baseUrl).href);
  await chooseProvider(peer, 'codex');
  await expect(page.locator('#sp-provider-button')).toHaveText(/Claude Code/);
  await expect(peer.locator('#sp-provider-button')).toHaveText(/Codex/);

  const call = await submit(page, 'Global lifecycle across providers');
  for (const tab of [page, peer]) {
    await expect(tab.locator('#sp-provider-button')).toBeDisabled();
    await expect(tab.locator('#sp-provider-new-session')).toBeDisabled();
    await expect(tab.locator('#sp-input')).toBeDisabled();
  }
  runner.complete(call);
  for (const tab of [page, peer]) {
    await expect(tab.locator('#sp-provider-button')).toBeEnabled();
    await expect(tab.locator('#sp-provider-new-session')).toBeEnabled();
  }
  await expect(page.locator('#sp-provider-button')).toHaveText(/Claude Code/);
  await expect(peer.locator('#sp-provider-button')).toHaveText(/Codex/);
  await peer.close();
});

test('New session clears exactly the selected provider/page transcript after exact server success', async ({ page }) => {
  const { claudeKey, codexKey } = await createProviderHistories(page);
  const otherKey = await transcriptKey(page, 'codex', '/other.html');
  await page.evaluate((key) => sessionStorage.setItem(key, '<div>other page history</div>'), otherKey);
  await chooseProvider(page, 'claude');
  await expect(page.locator('#sp-thread')).toContainText('Claude history');
  await page.evaluate(() => { window.confirm = () => true; });
  let requestBody;
  await page.route('**/__sandpaper/session/reset', async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fallback();
  });

  await page.locator('#sp-provider-button').click();
  const reset = page.locator('#sp-provider-new-session');
  await expect(reset).toBeEnabled();
  await expect(reset).toHaveAttribute('aria-label', 'New session for Claude Code');
  await reset.click();

  await expect(page.locator('#sp-provider-menu')).toBeHidden();
  await expect(page.locator('#sp-provider-button')).toBeFocused();
  await expect(page.locator('#sp-thread .sp-turn')).toHaveCount(0);
  expect(requestBody).toEqual({ page: '/hostile.html', provider: 'claude' });
  expect(await page.evaluate((key) => sessionStorage.getItem(key), claudeKey)).toBeNull();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), codexKey)).toContain('Codex history');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), otherKey)).toBe('<div>other page history</div>');

  await page.locator('#sp-provider-button').press('ArrowDown');
  await expect(page.locator('[data-provider="claude"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-provider="codex"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#sp-provider-button')).toHaveText(/Codex/);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), codexKey)).toContain('Codex history');
  await expect(page.locator('#sp-thread')).toContainText('Codex history');
});

test('New session cancellation makes no request or transcript mutation and keeps coherent menu focus', async ({ page }) => {
  const call = await submit(page, 'History preserved on cancel');
  runner.complete(call);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  const key = await transcriptKey(page, 'claude');
  const before = await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key);
  let requests = 0;
  await page.route('**/__sandpaper/session/reset', (route) => { requests += 1; return route.abort(); });
  await page.evaluate(() => { window.confirm = () => false; });

  await page.locator('#sp-provider-button').click();
  await page.locator('#sp-provider-new-session').click();
  expect(requests).toBe(0);
  await expect(page.locator('#sp-provider-menu')).toBeVisible();
  await expect(page.locator('#sp-provider-new-session')).toBeFocused();
  await expect(page.locator('#sp-thread')).toContainText('History preserved on cancel');
  expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key)).toBe(before);
});

for (const resetFailure of [
  {
    name: 'structured failure',
    fulfill: { status: 409, body: JSON.stringify({ ok: false, error: { code: 'turn_in_progress', message: 'A turn is already in progress' } }) },
    message: /turn is already in progress/i,
  },
  { name: 'network failure', abort: 'connectionrefused', message: /failed|reset|connection|reachable/i },
  { name: 'empty success', fulfill: { status: 200, body: '{}' }, message: /invalid session reset response/i },
  { name: 'wrong-provider success', fulfill: { status: 200, body: JSON.stringify({ ok: true, page: '/hostile.html', provider: 'codex' }) }, message: /invalid session reset response/i },
  { name: 'wrong-page success', fulfill: { status: 200, body: JSON.stringify({ ok: true, page: '/other.html', provider: 'claude' }) }, message: /invalid session reset response/i },
  { name: 'extra-field success', fulfill: { status: 200, body: JSON.stringify({ ok: true, page: '/hostile.html', provider: 'claude', extra: true }) }, message: /invalid session reset response/i },
  { name: 'malformed success', fulfill: { status: 200, body: '{' }, message: /invalid response/i },
]) {
  test(`New session ${resetFailure.name} preserves history and focus`, async ({ page }) => {
    const call = await submit(page, `History preserved on ${resetFailure.name}`);
    runner.complete(call);
    await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
    const key = await transcriptKey(page, 'claude');
    const before = await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key);
    await page.evaluate(() => { window.confirm = () => true; });
    await page.route('**/__sandpaper/session/reset', (route) => {
      if (resetFailure.abort) return route.abort(resetFailure.abort);
      return route.fulfill({ contentType: 'application/json', ...resetFailure.fulfill });
    });

    await page.locator('#sp-provider-button').click();
    await page.locator('#sp-provider-new-session').click();
    await expect(page.locator('#sp-provider-menu')).toBeVisible();
    await expect(page.locator('#sp-provider-new-session')).toBeFocused();
    await expect(page.locator('#sp-provider-guidance')).toContainText(resetFailure.message);
    await expect(page.locator('#sp-thread')).toContainText(`History preserved on ${resetFailure.name}`);
    expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key)).toBe(before);
  });
}

test('New session preserves history when browser storage removal throws after server success', async ({ page }) => {
  const call = await submit(page, 'History preserved on storage failure');
  runner.complete(call);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  const key = await transcriptKey(page, 'claude');
  const before = await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key);
  await page.evaluate(() => {
    window.confirm = () => true;
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (storageKey) {
      if (storageKey.startsWith('sp-thread:v2:')) throw new DOMException('Storage denied', 'SecurityError');
      return original.call(this, storageKey);
    };
  });

  await page.locator('#sp-provider-button').click();
  await page.locator('#sp-provider-new-session').click();
  await expect(page.locator('#sp-provider-menu')).toBeVisible();
  await expect(page.locator('#sp-provider-new-session')).toBeFocused();
  await expect(page.locator('#sp-provider-guidance')).toContainText(/browser history|storage|clear/i);
  await expect(page.locator('#sp-thread')).toContainText('History preserved on storage failure');
  expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key)).toBe(before);
});

test('New session request locks provider switching and turn submission until it settles', async ({ page }) => {
  const call = await submit(page, 'History during reset transaction');
  runner.complete(call);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');
  await page.evaluate(() => { window.confirm = () => true; });
  let releaseReset;
  await page.route('**/__sandpaper/session/reset', async (route) => {
    await new Promise((resolve) => { releaseReset = resolve; });
    await route.fallback();
  });

  await page.locator('#sp-provider-button').click();
  await page.locator('#sp-provider-new-session').click();
  await expect.poll(() => typeof releaseReset).toBe('function');
  await expect(page.locator('#sp-provider-button')).toBeDisabled();
  await expect(page.locator('#sp-input')).toBeDisabled();
  await expect(page.locator('#sp-send')).toBeDisabled();
  await expect(page.locator('#sp-provider-new-session')).toBeDisabled();
  expect(codexRunner.calls).toHaveLength(0);

  releaseReset();
  await expect(page.locator('#sp-provider-button')).toBeEnabled();
  await expect(page.locator('#sp-provider-button')).toHaveText(/Claude Code/);
  await expect(page.locator('#sp-thread .sp-turn')).toHaveCount(0);
});

test('New session is keyboard reachable, activates once, and is enabled for a known unavailable provider while idle', async ({ page }) => {
  await startProviderServer(page, {
    initialProvider: 'codex',
    diagnostics: [
      READY_PROVIDERS[0],
      { id: 'codex', label: 'Codex', available: false, compatible: true, authMethod: null, unavailableCode: 'unauthenticated' },
    ],
  });
  await page.evaluate(() => { window.confirm = () => true; });
  let requests = 0;
  await page.route('**/__sandpaper/session/reset', async (route) => { requests += 1; await route.fallback(); });
  const button = page.locator('#sp-provider-button');
  await button.focus();
  await button.press('ArrowDown');
  await page.keyboard.press('End');
  const reset = page.locator('#sp-provider-new-session');
  await expect(reset).toBeFocused();
  await expect(reset).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator('#sp-provider-menu')).toBeHidden();
  await expect(button).toBeFocused();
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

test('fresh tab ignores unowned terminal replay without creating a blank transcript turn', async ({ page, context }) => {
  const call = await submit(page, 'Finish before fresh tab opens');
  runner.complete(call);
  await expect(page.locator('.sp-turnmeta .sp-tag')).toHaveText('Replied');

  const fresh = await context.newPage();
  await fresh.addInitScript(() => {
    localStorage.setItem('sp-welcomed:v1', '1');
    sessionStorage.setItem('sp-welcomed:v1', '1');
  });
  await fresh.goto(new URL('/hostile.html', baseUrl).href);
  await expect(fresh.locator('#sp-label')).toHaveText('idle');
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

for (const invalidAcceptance of [
  { name: 'wrong successful status', status: 200, body: { ok: true, turnId: 'turn-1', provider: 'claude' } },
  { name: 'wrong accepted provider', status: 202, body: { ok: true, turnId: 'turn-1', provider: 'codex' } },
  { name: 'unsafe accepted turn id', status: 202, body: { ok: true, turnId: '', provider: 'claude' } },
  { name: 'extra accepted field', status: 202, body: { ok: true, turnId: 'turn-1', provider: 'claude', extra: true } },
]) {
  test(`${invalidAcceptance.name} cannot bind the optimistic turn`, async ({ page }) => {
    await page.route('**/__sandpaper/turn', (route) => route.fulfill({
      status: invalidAcceptance.status,
      contentType: 'application/json',
      body: JSON.stringify(invalidAcceptance.body),
    }));
    await recoverableSubmit(page, `${invalidAcceptance.name} draft`);
    await expect(page.locator('#sp-label')).toContainText(/unexpected response status|invalid accepted turn response/i);
    await expect(page.locator('.sp-turn')).not.toHaveAttribute('data-turn', /.+/);
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
