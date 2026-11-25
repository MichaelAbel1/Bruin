import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { McpOAuthSession } from '../runtime/mcp-oauth.js';
import { McpManager } from '../runtime/mcp.js';
import { mcpServerSchema } from '../config.js';

test('OAuth snapshots preserve issuer-bound credentials but exclude transient login state', () => {
  const session = new McpOAuthSession();
  session.saveTokens(
    {
      access_token: 'access',
      token_type: 'Bearer',
      refresh_token: 'refresh',
      issuer: 'https://issuer.example',
    },
    { issuer: 'https://issuer.example' },
  );
  session.saveClientInformation(
    { client_id: 'client', client_secret: 'secret' },
    { issuer: 'https://issuer.example' },
  );
  session.saveCodeVerifier('transient-verifier');
  const serialized = JSON.stringify(session.snapshot());
  assert.doesNotMatch(serialized, /transient-verifier|nonce|redirect/);
  const restored = new McpOAuthSession();
  restored.restore(JSON.parse(serialized));
  assert.equal(restored.tokens({ issuer: 'https://issuer.example' })?.refresh_token, 'refresh');
  assert.equal(restored.tokens({ issuer: 'https://other.example' }), undefined);
  assert.equal(
    restored.clientInformation({ issuer: 'https://issuer.example' })?.client_id,
    'client',
  );
  assert.throws(() => restored.codeVerifier(), /缺失/);
  assert.throws(() => restored.restore({ version: 2 }), /Invalid/);
});

test('manager persists refreshed credentials, binds configuration, clears logout but retains shutdown storage', async (t) => {
  const saved: Array<{ name: string; signature: string; state: unknown }> = [];
  const server = mcpServerSchema.parse({
    name: 'test',
    transport: 'http',
    url: 'https://example.com/mcp',
    oauth: {},
  });
  t.mock.method(McpOAuthSession.prototype, 'login', async function (this: McpOAuthSession) {
    this.saveTokens({ access_token: 'NEW_TOKEN', token_type: 'Bearer' });
  });
  const manager = new McpManager();
  manager.onCredentials = (name, signature, state) => saved.push({ name, signature, state });
  await manager.login(server, async () => {});
  const last = saved.at(-1)!;
  assert.match(JSON.stringify(last.state), /NEW_TOKEN/);
  const next = new McpManager();
  next.onCredentials = manager.onCredentials;
  next.restoreOAuth(server, 'wrong signature', { invalid: true });
  next.restoreOAuth(server, last.signature, last.state);
  const count = saved.length;
  await next.close();
  assert.equal(saved.length, count);
  await manager.login(server, async () => {});
  assert.match(JSON.stringify(saved.at(-1)?.state), /NEW_TOKEN/);
  await manager.logout(server.name);
  assert.equal(saved.at(-1)?.state, undefined);
  await manager.close();
});

test('desktop stores OAuth separately through safeStorage and restores only over host IPC', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-encrypted-oauth-'));
  const require = createRequire(import.meta.url);
  const restored: unknown[] = [];
  const context = vm.createContext({
    require: (name: string) =>
      name === 'electron'
        ? {
            app: { getPath: () => dir, requestSingleInstanceLock: () => false, quit() {} },
            safeStorage: {
              isEncryptionAvailable: () => true,
              getSelectedStorageBackend: () => 'keyring',
              encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
              decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
            },
          }
        : require(name),
    process: { env: { BRUIN_HOME: dir }, platform: 'linux', pid: process.pid, kill: process.kill },
    Buffer,
    console,
    setTimeout,
    __dirname: path.resolve('desktop'),
    record: (value: unknown) => restored.push(value),
  });
  try {
    vm.runInContext(fs.readFileSync('desktop/main.cjs', 'utf8'), context);
    vm.runInContext(
      `
      const data = { signature: 'server-signature', state: { version: 1, tokens: [], clients: [], latest: { access_token: 'PRIVATE_OAUTH_TOKEN', token_type: 'Bearer' } } };
      updateStoredKey('notion', safeStorage.encryptString(JSON.stringify(data)).toString('base64'), false, oauthPath());
      requestHost = async (method, params) => record({method, params});
    `,
      context,
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(dir, 'oauth.enc.json'), 'utf8'),
      /PRIVATE_OAUTH_TOKEN/,
    );
    assert.equal(fs.existsSync(path.join(dir, 'keys.enc.json')), false);
    await vm.runInContext('restoreStoredOAuth()', context);
    assert.match(JSON.stringify(restored), /restoreMcpCredentials.*PRIVATE_OAUTH_TOKEN/);
    vm.runInContext(
      `
      updateStoredKey('corrupt', 'not-valid-json', false, oauthPath());
    `,
      context,
    );
    restored.length = 0;
    await vm.runInContext('restoreStoredOAuth()', context);
    assert.match(JSON.stringify(restored), /restoreMcpCredentials.*PRIVATE_OAUTH_TOKEN/);
    assert.ok(vm.runInContext('startupWarnings.length > 0', context));
    vm.runInContext("updateStoredKey('notion', undefined, true, oauthPath())", context);
    vm.runInContext("updateStoredKey('corrupt', undefined, true, oauthPath())", context);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'oauth.enc.json'), 'utf8')), {});
    vm.runInContext("safeStorage.getSelectedStorageBackend = () => 'basic_text'", context);
    assert.equal(vm.runInContext('secureStorageAvailable()', context), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
