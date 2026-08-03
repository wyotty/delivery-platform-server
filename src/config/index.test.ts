import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './index.js';

test('empty env values fall back to defaults rather than failing validation', () => {
  // .env templates ship keys with no value ("DB_PATH="); dotenv turns those into
  // empty strings, which must not be treated as a real configured value.
  const config = loadConfig({ DB_PATH: '', PORT: '', TELEGRAM_BOT_TOKEN: '' } as NodeJS.ProcessEnv);
  assert.equal(config.dbPath, 'data/delivery.db');
  assert.equal(config.port, 3000);
  assert.equal(config.telegramBotToken, undefined);
});

test('explicit values override defaults and PORT is coerced to a number', () => {
  const config = loadConfig({ DB_PATH: '/data/x.db', PORT: '8080' } as NodeJS.ProcessEnv);
  assert.equal(config.dbPath, '/data/x.db');
  assert.equal(config.port, 8080);
  assert.equal(typeof config.port, 'number');
});

test('FETCH_ON_BOOT parses as a boolean', () => {
  assert.equal(loadConfig({ FETCH_ON_BOOT: 'true' } as NodeJS.ProcessEnv).fetchOnBoot, true);
  assert.equal(loadConfig({ FETCH_ON_BOOT: 'false' } as NodeJS.ProcessEnv).fetchOnBoot, false);
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).fetchOnBoot, false);
});

test('an out-of-range port is rejected with a readable message', () => {
  assert.throws(() => loadConfig({ PORT: '99999' } as NodeJS.ProcessEnv), /Invalid configuration[\s\S]*port/);
});

test('an unknown log level is rejected', () => {
  assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' } as NodeJS.ProcessEnv), /Invalid configuration/);
});
