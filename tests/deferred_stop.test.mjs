/**
 * D-002：deferred 之后不得再进入 Execute，也不得继续环境执行。
 * 时钟用 config.now，不真实 sleep。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import { GraphStore } from '../controller/index.js';
import { makeFakeAgent, makeFakeHost, tmpDir, wireServices } from './helpers.mjs';

const TTL = 10 * 60 * 1000;

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.tools.register({
    name: 'bash',
    description: 'fake bash',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute() {
      return { ok: true, text: 'bash ok' };
    },
  });
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', executeSessionTtlMs: TTL, ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-a', cwd);
  host.emit('agent/created', { agent });
  const command = host.commands.find((item) => item.name === 'fgs');
  const fgs = (raw, who = agent) => command.handler({ agent: who, rawInput: raw });
  return { host, agent, cwd, fgs };
}

function graphOf(cwd, id) {
  return new GraphStore(path.join(cwd, '.fgs', 'projects', id)).load();
}

function metaOf(cwd, id) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'projects', id, 'meta.json'), 'utf8'));
}

function idsOf(graph) {
  return {
    facts: graph.facts.map((item) => item.id),
    goals: graph.goals.map((item) => item.id),
    steps: graph.steps.map((item) => item.id),
  };
}

async function seedProject(host, agent, fgs, id, brief) {
  const created = fgs(`new ${id} ${brief}`);
  assert.equal(created.kind, 'success', JSON.stringify(created));
  return created;
}

async function openOwned(host, agent, action) {
  const drafted = await host.callTool('fgs_open_step', {
    action, from: ['fact_origin'],
  }, agent);
  assert.equal(drafted.ok, true, drafted.text);
  const opened = await host.callTool('fgs_commit', {}, agent);
  assert.equal(opened.ok, true, opened.text);
  return opened;
}

test('未 deferred 时 open → commit → 环境工具 → 收束仍然放行', async () => {
  const { host, agent, cwd, fgs } = boot();
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '探测端口');
  const graph = graphOf(cwd, 'alpha');
  assert.equal(graph.steps[0].state, 'open');
  assert.equal(graph.steps[0].owner, 'sess-a');
  assert.notEqual(metaOf(cwd, 'alpha').state, 'deferred');

  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, true, bash.text);
  assert.equal(bash.text, 'bash ok');

  const submitted = await host.callTool('fgs_submit_fact', {
    title: '扫到 22', content: '只有 ssh',
  }, agent);
  assert.equal(submitted.ok, true, submitted.text);
  const closed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(closed.ok, true, closed.text);
  assert.equal(graphOf(cwd, 'alpha').steps[0].state, 'done');
  assert.equal(graphOf(cwd, 'alpha').facts.some((fact) => fact.id === 'fact_001'), true);
  assert.notEqual(metaOf(cwd, 'alpha').state, 'deferred');
  assert.equal(agent.concluded, false);
});

test('TTL deferred 后拒绝 Execute 入口与环境工具，meta 与图节点保留，重复结算幂等', async () => {
  const clock = { now: 1_700_000_000_000 };
  const { host, agent, cwd, fgs } = boot({ now: () => clock.now });
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '探测端口');

  const live = await host.callTool('bash', {}, agent);
  assert.equal(live.ok, true, live.text);
  assert.equal(agent.concluded, false);

  const before = idsOf(graphOf(cwd, 'alpha'));
  clock.now += TTL;
  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, false, bash.text);
  assert.match(bash.text, /deferred/);
  assert.match(bash.text, /execute_timeout/);
  assert.match(bash.text, /bash/);
  assert.doesNotMatch(bash.text, /先 fgs_open_step/);
  assert.notEqual(bash.text, 'bash ok');
  assert.equal(agent.concluded, true, '没有其它可做题时应 concludeTurn');

  const meta = metaOf(cwd, 'alpha');
  assert.equal(meta.state, 'deferred');
  assert.equal(meta.deferredReason, 'execute_timeout');
  assert.ok(meta.deferredAt);
  assert.ok(meta.unfinishedFactId);
  const settled = graphOf(cwd, 'alpha');
  const settledIds = idsOf(settled);
  for (const id of before.facts) assert.ok(settledIds.facts.includes(id));
  for (const id of before.goals) assert.ok(settledIds.goals.includes(id));
  for (const id of before.steps) assert.ok(settledIds.steps.includes(id));
  assert.equal(settled.steps[0].id, 'step_001');
  assert.equal(settled.steps[0].state, 'open');
  assert.equal(settled.steps[0].owner, null);
  assert.equal(settled.facts.filter((fact) => fact.kind === 'unfinished').length, 1);
  assert.equal(settled.goals[0].id, 'goal_final');

  const againBash = await host.callTool('bash', {}, agent);
  assert.equal(againBash.ok, false);
  assert.match(againBash.text, /deferred/);
  assert.equal(metaOf(cwd, 'alpha').deferredAt, meta.deferredAt);
  assert.equal(metaOf(cwd, 'alpha').deferredReason, 'execute_timeout');
  assert.deepEqual(idsOf(graphOf(cwd, 'alpha')), settledIds);

  const opened = await host.callTool('fgs_open_step', {
    action: '继续扫', from: ['fact_origin'],
  }, agent);
  assert.equal(opened.ok, false, opened.text);
  assert.match(opened.text, /deferred/);
  assert.match(opened.text, /execute_timeout/);
  assert.match(opened.text, /fgs_open_step/);

  const claimed = await host.callTool('fgs_claim_step', { stepId: 'step_001' }, agent);
  assert.equal(claimed.ok, false, claimed.text);
  assert.match(claimed.text, /deferred/);

  const commitOpen = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '继续扫', from: ['fact_origin'] }],
  }, agent);
  assert.equal(commitOpen.ok, false, commitOpen.text);
  assert.match(commitOpen.text, /deferred/);

  const commitClaim = await host.callTool('fgs_commit', {
    operations: [{ op: 'claim_step', stepId: 'step_001' }],
  }, agent);
  assert.equal(commitClaim.ok, false, commitClaim.text);
  assert.match(commitClaim.text, /deferred/);

  const submitted = await host.callTool('fgs_submit_fact', { title: '不该写', content: 'x' }, agent);
  assert.equal(submitted.ok, false, submitted.text);
  assert.match(submitted.text, /deferred/);
  const commitStep = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(commitStep.ok, false, commitStep.text);
  assert.match(commitStep.text, /deferred/);

  assert.deepEqual(idsOf(graphOf(cwd, 'alpha')), settledIds);
  assert.equal(graphOf(cwd, 'alpha').steps[0].state, 'open');
  assert.equal(metaOf(cwd, 'alpha').deferredAt, meta.deferredAt);
  assert.equal(metaOf(cwd, 'alpha').unfinishedFactId, meta.unfinishedFactId);

  const preview = await host.callTool('fgs_preview', {}, agent);
  assert.equal(preview.ok, true, preview.text);
  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(status.ok, true, status.text);
  assert.match(status.text, /Decide/);
  assert.match(status.text, /execute_timeout/);

  const bumped = await host.callTool('fgs_commit', {
    operations: [{ op: 'change_step_priority', stepId: 'step_001', priority: 'low' }],
  }, agent);
  assert.equal(bumped.ok, true, bumped.text);
  assert.match(bumped.text, /deferred/);
  assert.doesNotMatch(bumped.text, /下一步进入 Execute/);
  const after = graphOf(cwd, 'alpha');
  assert.equal(after.steps[0].id, 'step_001');
  assert.equal(after.steps[0].state, 'open');
  assert.equal(after.steps[0].priority, 'low');
  assert.ok(after.facts.some((fact) => fact.id === 'fact_origin'));
  assert.ok(after.goals.some((goal) => goal.id === 'goal_final'));
  assert.equal(metaOf(cwd, 'alpha').state, 'deferred');
  assert.equal(metaOf(cwd, 'alpha').deferredAt, meta.deferredAt);
  assert.equal(metaOf(cwd, 'alpha').deferredReason, 'execute_timeout');

  clock.now += TTL;
  await host.callTool('fgs_status', {}, agent);
  assert.equal(metaOf(cwd, 'alpha').deferredAt, meta.deferredAt);
  assert.equal(graphOf(cwd, 'alpha').facts.filter((fact) => fact.kind === 'unfinished').length, 1);
  assert.equal(graphOf(cwd, 'alpha').steps[0].id, 'step_001');
});
