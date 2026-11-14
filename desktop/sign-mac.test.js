import test from 'node:test';
import assert from 'node:assert/strict';
import { signingOptions } from './scripts/sign-mac.mjs';

test('Navidrome executable-memory entitlement is scoped to the bundled server', () => {
  const options = signingOptions({ app: '/build/Kept Preview.app', identity: '-', keychain: 'build.keychain', optionsForFile: file => ({ entitlements: 'electron.plist', hardenedRuntime: true, requirements: file }) });
  const server = '/build/Kept Preview.app/Contents/Resources/navidrome';
  assert.match(options.optionsForFile(server).entitlements, /entitlements\.navidrome\.mac\.plist$/);
  assert.equal(options.optionsForFile(server).hardenedRuntime, true);
  for (const file of [options.app, `${options.app}/Contents/MacOS/Kept Preview`, '/other/navidrome']) assert.equal(options.optionsForFile(file).entitlements, 'electron.plist');
  assert.equal(options.identity, '-');
  assert.equal(options.keychain, 'build.keychain');
});
