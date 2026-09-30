import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpManager } from '../runtime/mcp.js';

test('MCP workspace switches and disconnects wait for in-flight requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruin-mcp-concurrency-'));
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const script = path.join(dir, 'server.cjs');
  fs.writeFileSync(
    script,
    `
    const readline = require('node:readline');
    const fs = require('node:fs');
    const path = require('node:path');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: process.cwd(), inputSchema: { type: 'object', properties: {} } }] };
      else if (message.method === 'tools/call') {
        fs.writeFileSync(path.join(process.cwd(), 'in-flight'), 'started');
        result = { content: [{ type: 'text', text: process.cwd() }] };
      }
      setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n'), message.method === 'initialize' ? 0 : 100);
    });
  `,
  );
  const server = {
    name: 'shared',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [script],
    envNames: [],
  };
  const manager = new McpManager();
  try {
    const [one, two] = await Promise.all([
      manager.listTools(server, first),
      manager.listTools(server, second),
    ]);
    assert.equal(one[0].description, fs.realpathSync(first));
    assert.equal(two[0].description, fs.realpathSync(second));
    const [firstCall, secondCall] = await Promise.all([
      manager.callTool(server, 'echo', {}, first),
      manager.callTool(server, 'echo', {}, second),
    ]);
    assert.equal(JSON.parse(firstCall.output).content[0].text, fs.realpathSync(first));
    assert.equal(JSON.parse(secondCall.output).content[0].text, fs.realpathSync(second));
    const call = manager.callTool(server, 'echo', {}, first);
    const disconnect = manager.disconnect(server.name);
    assert.equal(JSON.parse((await call).output).content[0].text, fs.realpathSync(first));
    await disconnect;
    await assert.rejects(manager.listTools(server, path.join(dir, 'missing')));
    assert.equal((await manager.listTools(server, second))[0].name, 'echo');
    fs.unlinkSync(path.join(second, 'in-flight'));
    const pending = manager.callTool(server, 'echo', {}, second);
    const settled = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(second, 'in-flight')) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(path.join(second, 'in-flight')), true);
    await manager.close();
    const outcome = await settled;
    assert.ok('result' in outcome);
    assert.equal(JSON.parse(outcome.result.output).content[0].text, fs.realpathSync(second));
  } finally {
    await manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
