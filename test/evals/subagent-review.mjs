import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AiSdkGateway } from '../../dist/providers/gateway.js';
import { findProfile, loadConfig, saveConfig } from '../../dist/config.js';
import { ProcessExecutor } from '../../dist/executor/client.js';
import { RuntimeServices } from '../../dist/runtime/services.js';
import { createSubagentRunner } from '../../dist/runtime/subagent.js';
import { SqliteEventStore } from '../../dist/storage/event-store.js';

const filename = 'src/batches.mjs';
const rule = 'nextOffset is null when the batch reaches the end of the input.';
const source = (operator) => `export function batch(items, offset, limit) {
  const end = offset + limit;
  return { items: items.slice(offset, end), nextOffset: end ${operator} items.length ? end : null };
}
`;
const schema = `Return one JSON object with findings (an array) and unchecked (an array of strings).
Each finding has path, line (1-based), source (the exact source line), and an example object with integer size, offset and limit. Use an empty findings array when no defect is found.`;
const variants = {
  baseline: `Review the repository for defects. ${schema}`,
  structured: `Review the batch function against its contract. Before writing the report, use read_file on README.md and ${filename}. Inspect boundary cases at and around the end of the input. Cite the exact line and give a counterexample for each finding. List anything you did not check. ${schema}`,
};

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Bruin Evaluation',
      GIT_AUTHOR_EMAIL: 'eval@example.test',
      GIT_COMMITTER_NAME: 'Bruin Evaluation',
      GIT_COMMITTER_EMAIL: 'eval@example.test',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  }).trim();
}

function prepare(workspace, defective) {
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, filename), source(defective ? '<=' : '<'));
  fs.writeFileSync(path.join(workspace, 'README.md'), `# Batch contract\n\n${rule}\n`);
  git(workspace, 'init', '-q', '--template=', '--object-format=sha1');
  git(workspace, 'add', '--', '.');
  git(workspace, 'commit', '-qm', 'evaluation baseline', '--no-gpg-sign');
  return git(workspace, 'rev-parse', 'HEAD');
}

function assess(answer, defective, workspace) {
  let report;
  try {
    report = JSON.parse(answer.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
  } catch {
    return { valid: false, hits: 0, falsePositives: null, misses: Number(defective) };
  }
  if (
    !Array.isArray(report?.findings) ||
    !Array.isArray(report?.unchecked) ||
    !report.unchecked.every((item) => typeof item === 'string')
  )
    return { valid: false, hits: 0, falsePositives: null, misses: Number(defective) };
  const line = fs.readFileSync(path.join(workspace, filename), 'utf8').split('\n')[2].trim();
  const reproduced = report.findings.some((finding) => {
    if (
      !defective ||
      finding?.path !== filename ||
      finding?.line !== 3 ||
      typeof finding?.source !== 'string' ||
      finding.source.trim() !== line
    )
      return false;
    const { size, offset, limit } = finding.example ?? {};
    return (
      [size, offset, limit].every(Number.isSafeInteger) &&
      size >= 0 &&
      offset >= 0 &&
      offset <= size &&
      limit > 0 &&
      offset + limit === size
    );
  });
  const hits = Number(reproduced);
  return {
    valid: true,
    hits,
    falsePositives: report.findings.length - hits,
    misses: Number(defective) - hits,
  };
}

const [alias, directory, option, ...extra] = process.argv.slice(2);
if (
  !alias ||
  !directory ||
  (option && !['--fixture-provider', '--parent-evidence'].includes(option)) ||
  extra.length
)
  throw new Error(
    'Usage: node test/evals/subagent-review.mjs MODEL_ALIAS NEW_DIRECTORY [--fixture-provider|--parent-evidence]',
  );

const simulated = option === '--fixture-provider';
const parentEvidence = option === '--parent-evidence';
const profile = simulated
  ? { alias, provider: 'openai-compatible', model: 'fixture' }
  : findProfile(alias);
const root = path.resolve(directory);
fs.mkdirSync(root);
process.env.BRUIN_HOME = path.join(root, 'bruin');
saveConfig({ ...loadConfig(), profiles: [profile], defaultProfile: profile.alias });
const store = new SqliteEventStore(path.join(process.env.BRUIN_HOME, 'sessions.sqlite'));
const executor = new ProcessExecutor();
const budgets = { maxModelCalls: 12, maxDurationMs: 180_000 };
let modelCalls = 0;
class ReviewGateway extends AiSdkGateway {
  complete(...args) {
    modelCalls++;
    return super.complete(...args);
  }
}
const fixtureGateway = () => ({
  async complete(_profile, prompt) {
    modelCalls++;
    const evidence = prompt.filter((message) => message.role === 'tool');
    if (!evidence.length)
      return {
        text: '',
        calls: [{ id: 'contract', name: 'read_file', input: { path: 'README.md' } }],
      };
    const result = evidence[1];
    if (!result)
      return { text: '', calls: [{ id: 'read', name: 'read_file', input: { path: filename } }] };
    const findings = JSON.stringify(result).includes('end <= items.length')
      ? [
          {
            path: filename,
            line: 3,
            source: source('<=').split('\n')[2].trim(),
            example: { size: 4, offset: 2, limit: 2 },
          },
        ]
      : [];
    return { text: JSON.stringify({ findings, unchecked: [] }), calls: [] };
  },
});
const services = new RuntimeServices(
  store,
  executor,
  createSubagentRunner(
    store,
    executor,
    simulated ? fixtureGateway : (mode) => new ReviewGateway(mode),
  ),
);
const results = [];
try {
  for (const defective of [true, false]) {
    let baseline;
    for (const [variant, instruction] of Object.entries(variants)) {
      const workspace = fs.mkdtempSync(path.join(root, 'trial-'));
      const commit = prepare(workspace, defective);
      baseline ??= commit;
      assert.equal(commit, baseline);
      const module = await import(pathToFileURL(path.join(workspace, filename)).href);
      assert.equal(module.batch([0, 1, 2, 3], 2, 2).nextOffset, defective ? 4 : null);
      const parent = store.createSession(workspace, profile);
      const signal = new AbortController().signal;
      const start = Date.now();
      let prompt = instruction;
      if (parentEvidence) {
        const evidence = [];
        for (const file of ['README.md', filename]) {
          const read = await executor.execute(
            {
              requestId: `parent-${variant}-${file}`,
              name: 'read_file',
              input: { path: file },
              workspace,
              timeoutMs: 3000,
              maxOutputBytes: 8000,
            },
            signal,
          );
          assert.equal(read.isError, false, read.output);
          const numbered = read.output
            .trimEnd()
            .split('\n')
            .map((line, index) => `${index + 1} | ${line}`);
          evidence.push(`${file}\n${numbered.join('\n')}`);
        }
        prompt += `\nThe parent read the following files. Review these snapshots if tools are unavailable. The number before each | is the source line; omit that prefix from the source field.\n${evidence.join('\n\n')}`;
      }
      const startCalls = modelCalls;
      const result = await services.execute(
        { id: 'review', name: 'spawn_subagent', input: { prompt } },
        parent,
        signal,
        budgets,
      );
      assert.equal(result.isError, false, result.output);
      await services.waitForSubagents(parent.id, signal);
      const finished = store
        .events(parent.id)
        .find((event) => event.type === 'subagent_finished')?.payload;
      assert.ok(finished);
      const events = store.events(finished.childId);
      const answer =
        events.filter((event) => event.type === 'assistant' && !event.payload.synthetic).at(-1)
          ?.payload.text ?? '';
      const untouched = git(workspace, 'status', '--porcelain') === '';
      const metrics = assess(answer, defective, workspace);
      const readCalls = new Map();
      const inspectedFiles = new Set();
      for (const event of events) {
        if (event.type === 'tool_requested' && event.payload.name === 'read_file')
          readCalls.set(event.payload.callId, event.payload.input?.path);
        if (
          event.type === 'tool_finished' &&
          !event.payload.isError &&
          readCalls.has(event.payload.callId)
        )
          inspectedFiles.add(readCalls.get(event.payload.callId));
      }
      results.push({
        sample: defective ? 'defective' : 'clean',
        variant,
        workspace,
        commit,
        prompt,
        status: finished.status,
        error: finished.error,
        answer,
        metrics,
        untouched,
        elapsedMs: Date.now() - start,
        modelCalls: modelCalls - startCalls,
        inspectedFiles: [...inspectedFiles],
        inspectedBoth: inspectedFiles.has(filename) && inspectedFiles.has('README.md'),
        tools: events
          .filter((event) => event.type === 'tool_finished')
          .map((event) => event.payload.name),
      });
      const report = { simulated, parentEvidence, model: profile.model, budgets, results };
      fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  if (simulated)
    assert.ok(
      results.every(
        (result) =>
          result.untouched &&
          result.inspectedBoth &&
          result.status === 'completed' &&
          result.metrics.valid &&
          result.metrics.misses === 0 &&
          result.metrics.falsePositives === 0,
      ),
    );
} finally {
  await services.close();
  await executor.close();
  store.close();
}
