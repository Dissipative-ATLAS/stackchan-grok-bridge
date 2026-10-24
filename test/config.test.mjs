import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../lib/config.mjs';

test('unlimited automatic waiting is explicit and does not use an infinite timer', () => {
  assert.equal(validateConfig({}).automaticWaitMode, 'bounded');
  const config = validateConfig({ automaticWaitMode: 'until_result', replyWaitMs: 90000 });
  assert.equal(config.automaticWaitMode, 'until_result');
  assert.equal(config.replyWaitMs, 90000);
  for (const automaticWaitMode of [null, true, 0, 'infinite', '']) {
    assert.throws(() => validateConfig({ automaticWaitMode }), /automaticWaitMode/);
  }
  assert.throws(() => validateConfig({ automaticWaitMode: 'until_result', replyWaitMs: Infinity }), /replyWaitMs/);
});
