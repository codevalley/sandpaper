import { join } from 'node:path';

import { prepareFileUpdates } from './integrations.js';

const OPTIONAL_HANDLER_FIELDS = [
  'commandWindows',
  'command_windows',
  'async',
  'statusMessage',
];

const PROVIDERS = Object.freeze({
  claude: {
    file: join('.claude', 'settings.json'),
    events: [
      ['SessionStart', '*', 'node .sandpaper/hooks/brain-inject.js', 10, ['node bin/brain-inject.js']],
      ['Stop', '*', 'node .sandpaper/hooks/brain-stamp-check.js', 20, ['node bin/brain-stamp-check.js']],
    ],
  },
  codex: {
    file: join('.codex', 'hooks.json'),
    events: [
      ['SessionStart', 'startup|resume|clear|compact', 'node .sandpaper/hooks/brain-inject.js', 10],
      ['Stop', undefined, 'node .sandpaper/hooks/brain-stamp-check.js', 20],
    ],
  },
});

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function exactHandler(value, command, timeout) {
  if (!isObject(value)) return false;
  if (value.type !== 'command' || value.command !== command || value.timeout !== timeout) return false;
  if (OPTIONAL_HANDLER_FIELDS.some((field) => Object.hasOwn(value, field))) return false;
  return Object.keys(value).every((field) => ['type', 'command', 'timeout'].includes(field));
}

function exactMatcher(group, matcher) {
  return matcher === undefined
    ? !Object.hasOwn(group, 'matcher')
    : group.matcher === matcher;
}

function exactOwnedGroup(group, matcher, command, timeout) {
  if (!exactMatcher(group, matcher) || group.hooks.length !== 1
    || !exactHandler(group.hooks[0], command, timeout)) return false;
  const expectedKeys = matcher === undefined ? ['hooks'] : ['hooks', 'matcher'];
  return Object.keys(group).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(group, key));
}

function validateEvent(config, event) {
  if (!Object.hasOwn(config.hooks, event)) return null;
  const groups = config.hooks[event];
  if (!Array.isArray(groups)) throw new Error(`Sandpaper ${event} hooks must be an array`);
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks) || group.hooks.some((hook) => !isObject(hook))) {
      throw new Error(`Sandpaper ${event} hook groups are structurally unsafe`);
    }
  }
  return groups;
}

function updateEvent(config, [event, matcher, command, timeout, legacyCommands = []], enabled) {
  const current = validateEvent(config, event);
  if (!current) {
    if (!enabled) return false;
    config.hooks[event] = [{
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: 'command', command, timeout }],
    }];
    return true;
  }

  let retained = false;
  let changed = false;
  const next = [];
  for (const group of current) {
    const exactCurrent = exactOwnedGroup(group, matcher, command, timeout);
    const exactLegacy = legacyCommands.some((legacy) => exactOwnedGroup(group, matcher, legacy, timeout));
    if (!exactCurrent && !exactLegacy) {
      next.push(group);
      continue;
    }
    if (exactLegacy) {
      changed = true;
      continue;
    }
    if (enabled && !retained) {
      next.push(group);
      retained = true;
    } else {
      changed = true;
    }
  }
  if (enabled && !retained) {
    next.push({
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: 'command', command, timeout }],
    });
    changed = true;
  }
  if (changed) config.hooks[event] = next;
  return changed;
}

function transformConfig(provider, source, enabled) {
  let config;
  if (source === null) {
    if (!enabled) return { ok: true, next: null };
    config = {};
  } else {
    try { config = JSON.parse(source.toString('utf8')); }
    catch { return { ok: false, reason: `Sandpaper ${provider} hook config is invalid JSON` }; }
  }
  if (!isObject(config)) return { ok: false, reason: `Sandpaper ${provider} hook config must be an object` };
  if (Object.hasOwn(config, 'hooks') && !isObject(config.hooks)) {
    return { ok: false, reason: `Sandpaper ${provider} hooks must be an object` };
  }
  if (!Object.hasOwn(config, 'hooks')) {
    if (!enabled) return { ok: true, next: source };
    config.hooks = {};
  }

  try {
    let changed = source === null;
    for (const definition of PROVIDERS[provider].events) {
      changed = updateEvent(config, definition, enabled) || changed;
    }
    if (!changed) return { ok: true, next: source };
    return { ok: true, next: Buffer.from(`${JSON.stringify(config, null, 2)}\n`) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

export function inspectHookConfigSource(provider, source) {
  if (!PROVIDERS[provider]) throw new Error('Unknown Sandpaper hook provider');
  if (source === null) return { status: 'absent', ownedCounts: {} };
  let config;
  try { config = JSON.parse(source.toString('utf8')); }
  catch { return { status: 'invalid', ownedCounts: {} }; }
  if (!isObject(config) || (Object.hasOwn(config, 'hooks') && !isObject(config.hooks))) {
    return { status: 'invalid', ownedCounts: {} };
  }
  const ownedCounts = {};
  try {
    for (const [event, matcher, command, timeout] of PROVIDERS[provider].events) {
      const groups = validateEvent({ hooks: config.hooks || {} }, event) || [];
      ownedCounts[event] = groups.filter((group) => exactOwnedGroup(group, matcher, command, timeout)).length;
    }
  } catch {
    return { status: 'invalid', ownedCounts: {} };
  }
  return { status: 'valid', ownedCounts };
}

export function providerHookPlan(target, provider, { enabled }) {
  const definition = PROVIDERS[provider];
  if (!definition || typeof enabled !== 'boolean') throw new Error('Invalid Sandpaper hook options');
  return {
    label: `${provider}-hooks`,
    destination: join(target, definition.file),
    mode: 0o644,
    update(source) { return transformConfig(provider, source, enabled); },
  };
}

export function installationHookPlans(target, packageRoot, { integrations, hooksEnabled }) {
  const selected = new Set(integrations);
  return [
    providerHookPlan(target, 'claude', { enabled: hooksEnabled && selected.has('claude') }),
    providerHookPlan(target, 'codex', { enabled: hooksEnabled && selected.has('codex') }),
    ...['brain-inject.js', 'brain-stamp-check.js'].map((script) => ({
      label: `hook-script-${script}`,
      destination: join(target, '.sandpaper', 'hooks', script),
      sourceRoot: packageRoot,
      source: join(packageRoot, 'bin', script),
    })),
  ];
}

function mergeProviderHooks(target, provider, options, dependencies = {}) {
  let transaction;
  try {
    transaction = prepareFileUpdates(target, [providerHookPlan(target, provider, options)], dependencies);
    transaction.commit();
    return { ok: true, changed: transaction.changed };
  } catch (error) {
    try { transaction?.abort(); } catch (recoveryError) {
      return { ok: false, changed: false, reason: recoveryError.message, recoveryPath: recoveryError.recoveryPath };
    }
    return {
      ok: false,
      changed: false,
      reason: error?.message || `Could not merge Sandpaper ${provider} hooks`,
      ...(error?.recoveryPath ? { recoveryPath: error.recoveryPath } : {}),
    };
  }
}

export function mergeClaudeHooks(target, options, dependencies) {
  return mergeProviderHooks(target, 'claude', options, dependencies);
}

export function mergeCodexHooks(target, options, dependencies) {
  return mergeProviderHooks(target, 'codex', options, dependencies);
}
