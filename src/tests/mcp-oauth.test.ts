import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { auth } from '@modelcontextprotocol/client';
import { McpOAuthSession } from '../runtime/mcp-oauth.js';
import { mcpServerSchema } from '../config.js';
import { McpManager } from '../runtime/mcp.js';

test('MCP OAuth performs discovery, PKCE, state validation, token exchange and refresh', async () => {
  let base = '';
  let challenge = '';
  let refreshes = 0;
  let expired = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/.well-known/oauth-protected-resource') || req.url === '/protected') {
      res.end(
        JSON.stringify({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ['tools'],
        }),
      );
      return;
    }
    if (req.url === '/mcp' && req.method === 'GET') {
      res.writeHead(req.headers.authorization ? 405 : 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${base}/protected", scope="tools"`,
      });
      res.end('{}');
      return;
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
        }),
      );
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/mcp' && req.method === 'POST') {
      if (expired && req.headers.authorization === 'Bearer initial') {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${base}/protected", scope="tools"`,
        });
        res.end('{}');
        return;
      }
      assert.ok(['Bearer initial', 'Bearer refreshed'].includes(req.headers.authorization ?? ''));
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(204);
        res.end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'mock', version: '1' },
            }
          : { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      return;
    }
    if (req.url === '/register') {
      const metadata = JSON.parse(body);
      assert.ok(metadata.redirect_uris[0].startsWith('http://127.0.0.1:'));
      res.end(JSON.stringify({ ...metadata, client_id: 'test-client' }));
      return;
    }
    if (req.url === '/token') {
      const params = new URLSearchParams(body);
      assert.equal(params.get('resource'), `${base}/mcp`);
      if (params.get('grant_type') === 'authorization_code') {
        assert.equal(params.get('code'), 'test-code');
        assert.equal(
          createHash('sha256').update(params.get('code_verifier')!).digest('base64url'),
          challenge,
        );
      } else {
        assert.equal(params.get('refresh_token'), 'refresh');
        refreshes++;
        expired = false;
      }
      res.end(
        JSON.stringify({
          access_token: refreshes ? 'refreshed' : 'initial',
          token_type: 'Bearer',
          refresh_token: 'refresh',
          expires_in: 60,
          scope: 'tools',
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
  const session = new McpOAuthSession();
  try {
    await session.login(
      `${base}/mcp`,
      async (value) => {
        const url = new URL(value);
        challenge = url.searchParams.get('code_challenge')!;
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
          const request = http.request(
            { hostname: callback.hostname, port: callback.port, path: 'http://[' },
            (response) => {
              response.resume();
              response.on('end', () => resolve(response.statusCode));
            },
          );
          request.on('error', reject);
          request.end();
        });
        assert.equal(malformedStatus, 400);
        callback.searchParams.set('code', 'test-code');
        callback.searchParams.set('state', '中'.repeat(64));
        assert.equal((await fetch(callback)).status, 400);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('iss', base);
        assert.equal((await fetch(callback)).status, 200);
        assert.equal((await fetch(callback)).status, 400);
      },
      0,
      5000,
    );
    assert.equal(session.tokens()?.access_token, 'initial');
    assert.equal(await auth(session, { serverUrl: `${base}/mcp` }), 'AUTHORIZED');
    assert.equal(refreshes, 1);
    assert.equal(session.tokens()?.access_token, 'refreshed');
    session.invalidateCredentials('all');
    assert.equal(session.tokens(), undefined);
    await assert.rejects(
      session.redirectToAuthorization(new URL('https://example.com/authorize')),
      /需要 OAuth 登录/,
    );
    const manager = new McpManager();
    const config = mcpServerSchema.parse({
      name: 'local-oauth',
      transport: 'http',
      url: `${base}/mcp`,
      oauth: {},
    });
    refreshes = 0;
    try {
      await manager.login(config, async (value) => {
        const url = new URL(value);
        challenge = url.searchParams.get('code_challenge')!;
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('code', 'test-code');
        callback.searchParams.set('iss', base);
        assert.equal((await fetch(callback)).status, 200);
      });
      assert.equal((await manager.listTools(config))[0].name, 'ping');
      expired = true;
      assert.equal((await manager.listTools(config))[0].name, 'ping');
      assert.equal(refreshes, 1);
      await manager.logout(config.name);
      await assert.rejects(manager.listTools(config), /需要 OAuth 登录/);
    } finally {
      await manager.close();
    }
    for (const reason of ['cancel', 'timeout'] as const) {
      const waiting = new McpOAuthSession();
      await assert.rejects(
        waiting.login(
          `${base}/mcp`,
          async () => {
            if (reason === 'cancel') waiting.cancelLogin();
          },
          0,
          100,
        ),
        reason === 'cancel' ? /已取消/ : /超时/,
      );
      assert.equal(waiting.tokens(), undefined);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('OAuth configuration keeps Bearer authentication separate and rejects unsafe settings', () => {
  assert.equal(
    mcpServerSchema.safeParse({
      name: 'x',
      transport: 'http',
      url: 'https://example.com/mcp',
      oauth: {},
    }).success,
    true,
  );
  for (const options of [
    { tokenEnv: 'TOKEN', oauth: {} },
    { oauth: { callbackPort: 80 } },
    { oauth: { callbackPort: '5000' } },
  ]) {
    assert.equal(
      mcpServerSchema.safeParse({
        name: 'x',
        transport: 'http',
        url: 'https://example.com/mcp',
        ...options,
      }).success,
      false,
    );
  }
});
