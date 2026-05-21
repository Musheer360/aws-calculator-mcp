const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

describe('findChrome', () => {
  const browserJsPath = require.resolve('../lib/browser.js');
  const puppeteerPath = require.resolve('puppeteer');
  let origPuppeteer;

  beforeEach(() => {
    origPuppeteer = require.cache[puppeteerPath];
    delete require.cache[browserJsPath];
  });

  afterEach(() => {
    if (origPuppeteer) require.cache[puppeteerPath] = origPuppeteer;
    else delete require.cache[puppeteerPath];
    delete require.cache[browserJsPath];
  });

  function mockPuppeteer(executablePath) {
    require.cache[puppeteerPath] = {
      id: puppeteerPath, filename: puppeteerPath, loaded: true,
      exports: { executablePath },
    };
  }

  it('is an async function', () => {
    const { findChrome } = require('../lib/browser.js');
    assert.strictEqual(findChrome.constructor.name, 'AsyncFunction');
  });

  it('resolves path when executablePath() returns a Promise (Puppeteer v21+)', async () => {
    const FAKE = '/tmp/fake-chrome-async';
    mockPuppeteer(() => Promise.resolve(FAKE));
    const { findChrome } = require('../lib/browser.js');
    const result = await findChrome();
    assert.strictEqual(result, FAKE);
    assert.notStrictEqual(result, '[object Promise]', 'must await the Promise, not coerce it to a string');
  });

  it('resolves path when executablePath() returns a string (Puppeteer v20 and below)', async () => {
    const FAKE = '/tmp/fake-chrome-sync';
    mockPuppeteer(() => FAKE);
    const { findChrome } = require('../lib/browser.js');
    const result = await findChrome();
    assert.strictEqual(result, FAKE);
  });

  it('falls through to OS paths when puppeteer throws', async () => {
    // Simulate puppeteer unavailable (MODULE_NOT_FOUND) or executablePath failing
    mockPuppeteer(() => { throw new Error('Cannot find module puppeteer'); });
    const { findChrome } = require('../lib/browser.js');
    try {
      const result = await findChrome();
      assert.strictEqual(typeof result, 'string');
      assert.notStrictEqual(result, '[object Promise]');
    } catch (e) {
      // Acceptable: no Chrome installed on this machine
      assert.ok(e instanceof Error);
      assert.ok(e.message.toLowerCase().includes('chrome') || e.message.toLowerCase().includes('chromium'));
    }
  });
});
