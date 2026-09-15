/**
 * Entry point for `node --import ./tests/register_hook.mjs`.
 *
 * Kept separate from the hook itself because the hook runs on Node's loader
 * thread, while this registration runs on the main thread.
 */

import { register } from 'node:module';

register(new URL('./esm_js_hook.mjs', import.meta.url));
