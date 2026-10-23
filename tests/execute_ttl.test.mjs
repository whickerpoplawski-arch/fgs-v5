/**
 * Execute 会话墙钟 TTL：未完成 Fact、释放认领、deferred 调度。
 * 与 stepLeaseMs 正交。时钟用 config.now，避免真实 sleep。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import { Controller, GraphStore } from '../controller/index.js';
import {
  openStepOp,
  releaseStepOp,
  seedOriginOp,
  WriteRejected,
} from '../controller/ops.js';
import {
  callRoute,
  makeFakeAgent,
  makeFakeHost,
  tmpDir,
  wireServices,
} from './helpers.mjs';

const TTL = 10 * 60 * 1000;

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-a', cwd);
  host.emit('agent/created', { agent });
  const command = host.commands.find((item) => item.name === 'fgs');
  const fgs = (raw, who = agent) => command.handler({ agent: who, rawInput: raw });
  return { host, agent, cwd, fgs };
}

function otherAgent(host, cwd, id = 'sess-b') {
  const agent = makeFakeAgent(id, cwd);
  host.emit('agent/created', { agent });
  return agent;
}

function graphOf(cwd, id) {
  return new GraphStore(path.join(cwd, '.fgs', 'projects', id)).load();
}

function metaOf(cwd, id) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'projects', id, 'meta.json'), 'utf8'));
}

function activeId(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'competition.json'), 'utf8')).activeProblemId;
}

function contextOf(host, agent) {
  const def = host.contexts.find((item) => item.name === 'fgs-graph');
  return def.text({ scope: agent });
}

async function seedProject(host, agent, fgs, id, brief) {
  const created = fgs(`new ${id} ${brief}`);
  assert.equal(created.kind, 'success', JSON.stringify(created));
  return created;
}

async function openOwned(host, agent, action) {
  const opened = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action, from: ['fact_origin'] }],
  }, agent);
  assert.equal(opened.ok, true, opened.text);
  return opened;
}

test('默认 executeSessionTtlMs 为 10 分钟，且和 stepLeaseMs 分开写', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const contract = fs.readFileSync(new URL('../CONTRACT.md', import.meta.url), 'utf8');
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(src, /executeSessionTtlMs:\s*10 \* 60 \* 1000/);
  assert.match(src, /stepLeaseMs:\s*30 \* 60 \* 1000/);
  assert.match(patch, /executeSessionTtlMs:\s*600000/);
  assert.match(contract, /executeSessionTtlMs/);
  assert.match(contract, /stepLeaseMs/);
  assert.match(readme, /executeSessionTtlMs/);
  assert.match(readme, /stepLeaseMs/);
});

test('release_step 拒绝空 Fact；step 保持 open，同 owner 的其它 step 一并放回池', () => {
  const store = new GraphStore(tmpDir());
  const ctl = new Controller(store);
  ctl.commit(ctl.apply(seedOriginOp({ title: '题目信息:', content: 'brief' })));
  const claimedAt = new Date().toISOString();
  ctl.commit(ctl.apply(openStepOp({
    action: '当前步', from: ['fact_origin'], owner: 'sess-a', claimedAt, stepId: 'step_001',
  })));
  ctl.commit(ctl.apply(openStepOp({
    action: '同会话另一步', from: ['fact_origin'], owner: 'sess-a', claimedAt, stepId: 'step_002',
  })));
  assert.throws(
    () => ctl.apply(releaseStepOp({ stepId: 'step_001', factTitle: '   ', factContent: '有内容' })),
    WriteRejected,
  );
  assert.throws(
    () => ctl.apply(releaseStepOp({ stepId: 'step_001', factTitle: '有标题', factContent: '  ' })),
    /禁止空超时/,
  );
  const graph = ctl.apply(releaseStepOp({
    stepId: 'step_001',
    factTitle: '未完成：step_001 Execute 会话超时',
    factContent: '卡在：step_001，step 仍为 open。\n已试：没有未提交草稿。\n为何停：execute_session_ttl 超时。',
  }));
  ctl.commit(graph);
  const loaded = store.load();
  const fact = loaded.facts.find((item) => item.kind === 'unfinished');
  assert.ok(fact);
  assert.equal(fact.producedBy, 'step_001');
  assert.match(fact.content, /卡在：/);
  assert.match(fact.content, /已试：/);
  assert.match(fact.content, /为何停：execute_session_ttl 超时/);
  for (const step of loaded.steps) {
    assert.equal(step.state, 'open');
    assert.equal(step.owner, null);
    assert.equal(step.claimedAt, null);
    assert.equal(step.to ?? null, null);
  }
  assert.equal(loaded.steps[0].linkedUnfinishedFactId, fact.id);
  assert.equal(loaded.steps[1].linkedUnfinishedFactId ?? null, null);
  assert.equal(loaded.goals[0].satisfiedAt ?? null, null);
  const again = ctl.apply(releaseStepOp({
    stepId: 'step_001',
    factTitle: '未完成：不该再写一条',
    factContent: '卡在：x\n已试：y\n为何停：execute_session_ttl 超时。',
  }));
  assert.equal(again.facts.length, loaded.facts.length);
});

test('未过 TTL 不 settle；过 TTL 后未完成 Fact + 释放认领 + deferred，且幂等', async () => {
  const clock = { now: 1_700_000_000_000 };
  const { host, agent, cwd, fgs } = boot({
    executeSessionTtlMs: TTL,
    now: () => clock.now,
  });
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '探测端口');

  clock.now += TTL - 1;
  const early = await host.callTool('fgs_status', {}, agent);
  assert.match(early.text, /Execute/);
  let graph = graphOf(cwd, 'alpha');
  assert.equal(graph.facts.some((fact) => fact.kind === 'unfinished'), false);
  assert.equal(graph.steps[0].state, 'open');
  assert.equal(graph.steps[0].owner, 'sess-a');
  assert.notEqual(metaOf(cwd, 'alpha').state, 'deferred');

  clock.now += 1;
  const settled = await host.callTool('fgs_status', {}, agent);
  assert.match(settled.text, /角色: Decide/);
  assert.match(settled.text, /未完成 Fact/);
  assert.match(settled.text, /卡在：step_001/);
  assert.match(settled.text, /已试：没有未提交草稿/);
  assert.match(settled.text, /为何停：execute_session_ttl 超时/);
  assert.match(settled.text, /wave=cleanup/);
  graph = graphOf(cwd, 'alpha');
  const fact = graph.facts.find((item) => item.kind === 'unfinished');
  assert.ok(fact);
  assert.equal(fact.producedBy, 'step_001');
  assert.equal(graph.steps[0].state, 'open');
  assert.equal(graph.steps[0].owner, null);
  assert.equal(graph.steps[0].claimedAt, null);
  assert.equal(graph.steps[0].to ?? null, null);
  assert.equal(graph.steps[0].linkedUnfinishedFactId, fact.id);
  assert.equal(graph.goals[0].satisfiedAt ?? null, null);
  const meta = metaOf(cwd, 'alpha');
  assert.equal(meta.state, 'deferred');
  assert.equal(meta.deferredReason, 'execute_timeout');
  assert.equal(meta.unfinishedFactId, fact.id);
  assert.ok(meta.deferredAt);
  assert.equal(activeId(cwd), 'alpha');

  const again = await host.callTool('fgs_status', {}, agent);
  assert.match(again.text, /未完成 Fact/);
  assert.equal(graphOf(cwd, 'alpha').facts.filter((item) => item.kind === 'unfinished').length, 1);

  const bumped = await host.callTool('fgs_commit', {
    operations: [{ op: 'change_step_priority', stepId: 'step_001', priority: 'low' }],
  }, agent);
  assert.equal(bumped.ok, true, bumped.text);
  assert.equal(metaOf(cwd, 'alpha').state, 'deferred');
  assert.equal(graphOf(cwd, 'alpha').steps[0].linkedUnfinishedFactId, fact.id);
  assert.equal(graphOf(cwd, 'alpha').steps[0].state, 'open');

  const http = await callRoute(host.routes[0], '/fgs/state?problemId=alpha');
  assert.equal(http.json.deferred, true);
  assert.equal(http.json.deferredReason, 'execute_timeout');
  assert.equal(http.json.unfinishedFactId, fact.id);
  assert.equal(http.json.steps[0].owner, null);
  assert.equal(http.json.steps[0].linkedUnfinishedFactId, fact.id);
});

test('回合收口钩子在 TTL 后写未完成 Fact（含草稿），不把 step 收成 done', async () => {
  const clock = { now: 1_700_000_000_000 };
  const { host, agent, cwd, fgs } = boot({
    executeSessionTtlMs: TTL,
    now: () => clock.now,
  });
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '扫端口');
  const drafted = await host.callTool('fgs_submit_fact', {
    title: '扫到 22 端口',
    content: 'nmap 只看到 ssh',
  }, agent);
  assert.equal(drafted.ok, true, drafted.text);

  clock.now += TTL;
  host.emit('agent/turn-stopping', { agent });
  host.emit('agent/turn-stopping', { agent });

  const graph = graphOf(cwd, 'alpha');
  const facts = graph.facts.filter((item) => item.kind === 'unfinished');
  assert.equal(facts.length, 1);
  assert.match(facts[0].content, /卡在：step_001/);
  assert.match(facts[0].content, /已试：扫到 22 端口/);
  assert.match(facts[0].content, /nmap 只看到 ssh/);
  assert.match(facts[0].content, /为何停：execute_session_ttl 超时/);
  assert.equal(graph.steps[0].state, 'open');
  assert.equal(graph.steps[0].owner, null);
  assert.equal(graph.steps[0].linkedUnfinishedFactId, facts[0].id);
  assert.doesNotMatch(facts[0].content, /无有效产出|回合结束前没有/);
  assert.equal(metaOf(cwd, 'alpha').state, 'deferred');

  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(graphOf(cwd, 'alpha').facts.filter((item) => item.kind === 'unfinished').length, 1);
  assert.doesNotMatch(status.text, /草稿:/);
  const ctx = contextOf(host, agent);
  assert.match(ctx, /未完成 Fact/);
  assert.match(ctx, /nmap 只看到 ssh/);
  assert.match(ctx, /wave=cleanup/);
});

test('有非 deferred 题时不自动切到 deferred，也不自动认领', async () => {
  const clock = { now: 1_700_000_000_000 };
  const { host, agent, cwd, fgs } = boot({
    executeSessionTtlMs: TTL,
    now: () => clock.now,
  });
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '做 alpha');
  await seedProject(host, agent, fgs, 'beta', 'beta-brief');
  fgs('switch alpha');

  clock.now += TTL;
  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(activeId(cwd), 'beta');
  assert.match(status.text, /Project: beta/);
  assert.match(status.text, /next=beta/);
  assert.match(status.text, /不自动认领\/切换到 deferred/);
  assert.doesNotMatch(status.text, /next=alpha/);
  assert.match(status.text, /deferred alpha schedule=stopped/);
  assert.equal(metaOf(cwd, 'alpha').state, 'deferred');
  assert.equal(graphOf(cwd, 'alpha').steps[0].owner, null);
  assert.equal(graphOf(cwd, 'beta').facts.some((fact) => fact.kind === 'unfinished'), false);

  const list = fgs('list');
  assert.equal(activeId(cwd), 'beta', 'list 不得把活动题改到 deferred');
  assert.match(list.text, /next=beta/);
  assert.match(list.text, /alpha .*schedule=stopped/);
  assert.match(list.text, /\* beta/);
  assert.doesNotMatch(list.text, /next=alpha/);

  const switched = fgs('switch alpha');
  assert.equal(switched.kind, 'success');
  assert.equal(activeId(cwd), 'alpha');
  const ctx = contextOf(host, agent);
  assert.equal(activeId(cwd), 'alpha', '上下文不得自动切到别的题，也不得改回');
  assert.match(ctx, /next=beta/);
  assert.match(ctx, /不自动认领\/切换/);
  assert.doesNotMatch(ctx, /next=alpha/);
  assert.match(ctx, /未完成 Fact/);

  const before = graphOf(cwd, 'alpha');
  const opened = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '不该自动认领', from: ['fact_origin'] }],
  }, agent);
  assert.equal(opened.ok, false, opened.text);
  assert.match(opened.text, /deferred/);
  assert.equal(graphOf(cwd, 'alpha').steps.length, before.steps.length);
  assert.equal(graphOf(cwd, 'alpha').steps[0].owner, null);
  assert.equal(activeId(cwd), 'alpha');
  assert.equal(agent.concluded, false, '还有 beta 可做，不得结束整个会话');

  const claimed = await host.callTool('fgs_claim_step', { stepId: 'step_001' }, agent);
  assert.equal(claimed.ok, false, claimed.text);
  assert.match(claimed.text, /deferred/);
  assert.equal(graphOf(cwd, 'alpha').steps[0].owner, null);

  fgs('switch beta');
  const betaOpen = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '做 beta', from: ['fact_origin'] }],
  }, agent);
  assert.equal(betaOpen.ok, true, betaOpen.text);
  assert.equal(graphOf(cwd, 'beta').steps[0].owner, 'sess-a');
  assert.equal(agent.concluded, false);
});

test('只剩 deferred 题时不再认领，并请求结束会话', async () => {
  const clock = { now: 1_700_000_000_000 };
  const { host, agent, cwd, fgs } = boot({
    executeSessionTtlMs: TTL,
    now: () => clock.now,
  });
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '只剩这题');
  clock.now += TTL;
  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(activeId(cwd), 'alpha');
  assert.match(status.text, /next=alpha/);
  assert.match(status.text, /wave=cleanup/);
  assert.match(status.text, /Execute 已停止/);
  assert.equal(agent.concluded, true);
  const list = fgs('list');
  assert.match(list.text, /schedule=stopped/);
  assert.match(list.text, /Execute 已停止/);
  const claimed = await host.callTool('fgs_claim_step', { stepId: 'step_001' }, agent);
  assert.equal(claimed.ok, false, claimed.text);
  assert.match(claimed.text, /deferred/);
  assert.equal(graphOf(cwd, 'alpha').steps[0].owner, null);
  assert.equal(graphOf(cwd, 'alpha').steps[0].state, 'open');
});

test('deferred 后不能再进入 Execute，二次刷新不改 meta、不追加 Fact', async () => {
  const clock = { now: 1_700_000_000_000 };
  const { host, agent, cwd, fgs } = boot({
    executeSessionTtlMs: TTL,
    now: () => clock.now,
  });
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '第一次');
  clock.now += TTL;
  await host.callTool('fgs_status', {}, agent);
  const meta = metaOf(cwd, 'alpha');
  const factIds = graphOf(cwd, 'alpha').facts.map((fact) => fact.id);
  assert.equal(factIds.filter((id) => id !== 'fact_origin').length, 1);

  const claimed = await host.callTool('fgs_claim_step', { stepId: 'step_001' }, agent);
  assert.equal(claimed.ok, false, claimed.text);
  assert.match(claimed.text, /deferred/);
  assert.match(claimed.text, /execute_timeout/);
  clock.now += TTL;
  await host.callTool('fgs_status', {}, agent);
  const again = metaOf(cwd, 'alpha');
  assert.equal(again.state, 'deferred');
  assert.equal(again.deferredAt, meta.deferredAt);
  assert.equal(again.deferredReason, 'execute_timeout');
  assert.equal(again.unfinishedFactId, meta.unfinishedFactId);
  assert.deepEqual(graphOf(cwd, 'alpha').facts.map((fact) => fact.id), factIds);
  assert.equal(graphOf(cwd, 'alpha').steps[0].state, 'open');
  assert.equal(graphOf(cwd, 'alpha').steps[0].owner, null);
  assert.equal(graphOf(cwd, 'alpha').steps[0].id, 'step_001');
});

test('stepLeaseMs 仍拦住租约内的接手；execute TTL 释放认领不必等租约', async () => {
  const clock = { now: Date.now() };
  const { host, agent, cwd, fgs } = boot({
    executeSessionTtlMs: TTL,
    stepLeaseMs: 30 * 60 * 1000,
    now: () => clock.now,
  });
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '租约内的步');
  const bob = otherAgent(host, cwd);

  const blocked = await host.callTool('fgs_claim_step', { stepId: 'step_001' }, bob);
  assert.equal(blocked.ok, false, blocked.text);
  assert.match(blocked.text, /租约未过期/);
  assert.equal(graphOf(cwd, 'alpha').steps[0].owner, 'sess-a');

  clock.now += TTL;
  const stillBlocked = await host.callTool('fgs_claim_step', { stepId: 'step_001' }, bob);
  assert.equal(stillBlocked.ok, false, stillBlocked.text);
  assert.match(stillBlocked.text, /租约未过期/);

  await host.callTool('fgs_status', {}, agent);
  assert.equal(graphOf(cwd, 'alpha').steps[0].owner, null);
  assert.equal(graphOf(cwd, 'alpha').steps[0].state, 'open');
  const took = await host.callTool('fgs_claim_step', { stepId: 'step_001' }, bob);
  assert.equal(took.ok, false, took.text);
  assert.match(took.text, /deferred/);
  assert.equal(graphOf(cwd, 'alpha').steps[0].owner, null);
  assert.equal(graphOf(cwd, 'alpha').steps[0].id, 'step_001');
});
