#!/usr/bin/env node
/**
 * The whole test suite:
 *
 *   node tests/run_tests.mjs            run everything
 *   node tests/run_tests.mjs geo csv    run only groups whose name matches
 *
 * Exits 0 when every test passed and 1 otherwise, so it can be wired into CI or
 * a pre-commit hook without any further scripting.
 *
 * These tests cover the pure, headless core of the toolkit - geometry,
 * validation, the file formats and the altitude-sweep verification. The DOM
 * layers (app.js, canvas.js, site_map.js, ui.js) are not covered; testing them
 * would need a browser or a DOM shim, and a shim is a dependency.
 *
 * The first thing this file does is re-launch Node with the module hook from
 * tests/esm_js_hook.mjs, which is what lets Node import the project's `.js`
 * sources as ES modules without a package.json. See that file for why.
 */

import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';

/** Set on the re-launched child so it does not re-launch itself again. */
const HOOK_ENV_FLAG = 'UAV_TOOLKIT_ESM_HOOK';

if (process.env[HOOK_ENV_FLAG] !== '1') {
  process.exit(relaunchWithHook());
}

const { groups } = await import('./harness.mjs');
await importTestModules();
process.exit(await runGroups(selectGroups(groups, process.argv.slice(2))));

/**
 * Re-run this script in a child process that has the module hook installed.
 * @returns {number} the child's exit code
 */
function relaunchWithHook() {
  const self = fileURLToPath(import.meta.url);
  const hookArgs =
    typeof nodeModule.register === 'function'
      ? ['--import', new URL('./register_hook.mjs', import.meta.url).href]
      : // Node older than 18.19 / 20.6 has no module.register().
        ['--no-warnings', '--experimental-loader', new URL('./esm_js_hook.mjs', import.meta.url).href];

  const child = spawnSync(process.execPath, [...hookArgs, self, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [HOOK_ENV_FLAG]: '1' },
  });
  if (child.error) {
    console.error(`Could not start the test runner: ${child.error.message}`);
    return 1;
  }
  return child.status ?? 1;
}

/** Import every tests/*.test.mjs; importing one registers its groups. */
async function importTestModules() {
  const here = new URL('./', import.meta.url);
  const entries = await readdir(fileURLToPath(here));
  const files = entries.filter((name) => name.endsWith('.test.mjs')).sort();
  for (const file of files) {
    await import(new URL(file, here).href);
  }
}

/**
 * @param {Array<{group: string}>} all
 * @param {string[]} filters
 */
function selectGroups(all, filters) {
  if (filters.length === 0) return all;
  const wanted = filters.map((f) => f.toLowerCase());
  return all.filter((g) => wanted.some((f) => g.group.toLowerCase().includes(f)));
}

/**
 * @param {Array<{group: string, cases: Array<{name: string, fn: () => void}>}>} selected
 * @returns {Promise<number>} process exit code
 */
async function runGroups(selected) {
  const startedMs = Date.now();
  let passed = 0;
  /** @type {Array<{group: string, name: string, error: unknown}>} */
  const failures = [];

  for (const { group, cases } of selected) {
    process.stdout.write(`\n${group}\n`);
    for (const testCase of cases) {
      try {
        await testCase.fn();
        passed += 1;
        process.stdout.write(`  ok   ${testCase.name}\n`);
      } catch (error) {
        failures.push({ group, name: testCase.name, error });
        process.stdout.write(`  FAIL ${testCase.name}\n`);
      }
    }
  }

  const elapsedMs = Date.now() - startedMs;

  if (failures.length > 0) {
    process.stdout.write(`\n${'-'.repeat(60)}\n`);
    for (const failure of failures) {
      const error = failure.error;
      process.stdout.write(`\nFAIL ${failure.group} > ${failure.name}\n`);
      process.stdout.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
      const frame = firstProjectFrame(error);
      if (frame) process.stdout.write(`  at ${frame}\n`);
    }
  }

  process.stdout.write(`\n${'-'.repeat(60)}\n`);
  if (selected.length === 0) {
    process.stdout.write('No test groups matched the given filter.\n');
    return 1;
  }
  process.stdout.write(
    `${passed} passed, ${failures.length} failed, ` +
      `${selected.length} groups, ${elapsedMs} ms\n`
  );
  return failures.length === 0 ? 0 : 1;
}

/** The first stack frame inside this repository, which is the useful one. */
function firstProjectFrame(error) {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return null;
  const line = error.stack
    .split('\n')
    .slice(1)
    .find((entry) => entry.includes('.test.mjs') || entry.includes('/shared/js/'));
  return line ? line.trim().replace(/^at\s+/, '') : null;
}
