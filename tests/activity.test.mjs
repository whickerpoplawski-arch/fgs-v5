/**
 * v5 活动模式：选择器、CLI、插件注册面、启动认领、活动台账。
 *
 * 这些测试覆盖「一次 run 只做一件事」的三段：
 *   1. 纯选择器（controller/activity.js）——编排器与插件共用的唯一判定；
 *   2. CLI（tools/activity.mjs）——Python 编排器的入口；
 *   3. 插件活动模式（index.js）——工具注册面、启动认领、结束台账。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { apply as applyPlugin } from '../index.js';
import { GraphStore } from '../controller/index.js';
import {
  graphSignature,
  makeRunId,
  nextActivity,
  selectStep,
} from '../controller/activity.js';
import { bootstrapProject } from '../tools/bootstrap_project.mjs';
import { releaseStep } from '../tools/release_step.mjs';
import {
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const activityCli = path.join(repoRoot, 'tools', 'activity.mjs');

const FINAL_GOAL = {
  id: 'goal_final',
  kind: 'final',
  criterion: '取得并提交 FLAG',
  createdAt: '2026-10-11T09:00:00.000Z',
};

function originFact() {
  return {
    id: 'fact_origin',
    title: '题目信息:',
    content: '{"target":"http://10.0.0.8:8080"}',
    createdAt: '2026-10-11T09:00:00.000Z',
  };
}

function openStep(id = 'step_001', extra = {}) {
  return {
    id,
    action: `动作 ${id}`,
    from: ['fact_origin'],
    actor: 'agent',
    priority: 'normal',
    state: 'open',
    createdAt: '2026-10-11T09:01:00.000Z',
    ...extra,
  };
}

/* ------------------------------------------------------------ 纯选择器 */

test('选择器：没有可派发 step → decide；有 open step → execute；goal 满足 → done', () => {
  const seeded = { facts: [originFact()], goals: [FINAL_GOAL], steps: [] };
  const decide = nextActivity(seeded);
  assert.equal(decide.kind, 'decide');

  const withStep = { ...seeded, steps: [openStep()] };
  const execute = nextActivity(withStep);
  assert.equal(execute.kind, 'execute');
  assert.equal(execute.stepId, 'step_001');

  const done = {
    ...seeded,
    goals: [{ ...FINAL_GOAL, satisfiedAt: '2026-10-11T09:30:00.000Z' }],
  };
  assert.equal(nextActivity(done).kind, 'done');
});

test('选择器：step 被租约内持有 → wait；租约过期 → 可接手 execute', () => {
  const now = Date.parse('2026-10-11T10:00:00.000Z');
  const held = {
    facts: [originFact()],
    goals: [FINAL_GOAL],
    steps: [openStep('step_001', { owner: 'sess-a', claimedAt: '2026-10-11T09:59:00.000Z' })],
  };
  const waiting = nextActivity(held, { now, leaseMs: 5 * 60 * 1000 });
  assert.equal(waiting.kind, 'wait');

  const expired = nextActivity(held, { now, leaseMs: 30 * 1000 });
  assert.equal(expired.kind, 'execute');
  assert.equal(expired.stepId, 'step_001');
});

test('选择器：优先级 high 先于 normal；显式 stepId 直接命中', () => {
  const graph = {
    facts: [originFact()],
    goals: [FINAL_GOAL],
    steps: [openStep('step_low', { priority: 'low' }), openStep('step_high', { priority: 'high' })],
  };
  const picked = nextActivity(graph);
  assert.equal(picked.stepId, 'step_high');
  assert.equal(selectStep(graph, { stepId: 'step_low' }).id, 'step_low');
});

test('选择器：图没变 → defer（不做空转 Decide）；allow 重复 → decide', () => {
  const graph = { facts: [originFact()], goals: [FINAL_GOAL], steps: [] };
  const signature = graphSignature(graph);
  const deferred = nextActivity(graph, { lastSignature: signature });
  assert.equal(deferred.kind, 'defer');
  assert.match(deferred.reason, /未变化/);
  // decideOnChangeOnly=false 时允许重复 Decide（手工调试用）
  assert.equal(nextActivity(graph, { lastSignature: signature, decideOnChangeOnly: false }).kind, 'decide');
});

test('选择器：活动预算用尽 → budget；runId 稳定可读', () => {
  const graph = { facts: [originFact()], goals: [FINAL_GOAL], steps: [openStep()] };
  assert.equal(nextActivity(graph, { activitiesLeft: 0 }).kind, 'budget');
  const id = makeRunId('dec');
  assert.match(id, /^dec-[a-z0-9]+-[a-z0-9]+$/);
});

/* ----------------------------------------------------------------- CLI */

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [activityCli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('CLI：读磁盘图输出一行 JSON；图未种题也能给出 decide', () => {
  const cwd = tmpDir('fgs-act-cli-');
  bootstrapProject({ cwd, problemId: 'demo', brief: '{"target":"x"}' });
  const result = runCli(['--cwd', cwd, '--problem-id', 'demo']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, 'decide');
  assert.match(parsed.signature, /^f1:s0:o0/);

  const unknown = runCli(['--cwd', cwd, '--problem-id', 'nope']);
  const parsedUnknown = JSON.parse(unknown.stdout.trim());
  assert.equal(parsedUnknown.kind, 'decide', '空图 = 尚未规划，仍应给出 decide');
});

test('CLI：open step → execute，--last-signature 相同 → defer', () => {
  const cwd = tmpDir('fgs-act-cli2-');
  bootstrapProject({ cwd, problemId: 'demo', brief: '{"target":"x"}' });
  const store = new GraphStore(path.dirname(projectGraphPath(cwd, 'demo')));
  const graph = store.load();
  graph.steps.push(openStep());
  store.save(graph);

  const first = JSON.parse(runCli(['--cwd', cwd, '--problem-id', 'demo']).stdout.trim());
  assert.equal(first.kind, 'execute');
  assert.equal(first.stepId, 'step_001');
  // 有 open step 时永远优先 execute，不会因为签名未变而 defer
  const again = JSON.parse(runCli(['--cwd', cwd, '--problem-id', 'demo', '--last-signature', first.signature]).stdout.trim());
  assert.equal(again.kind, 'execute');
});

/* ------------------------------------------------- 插件活动模式（注册面） */

function bootActivity({ cwd, activity, step = null, extra = {} }) {
  const previous = { FGS_ACTIVITY: process.env.FGS_ACTIVITY, FGS_STEP: process.env.FGS_STEP, FGS_RUN_ID: process.env.FGS_RUN_ID };
  process.env.FGS_ACTIVITY = activity;
  if (step) process.env.FGS_STEP = step; else delete process.env.FGS_STEP;
  // 活动模式：owner 是 runId（不是会话 id），这里固定成可断言的稳定值。
  process.env.FGS_RUN_ID = `run-${activity}`;
  try {
    const host = makeFakeHost();
    const services = wireServices(host);
    host.ctx.services = { ...host.ctx.services, ...services };
    applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', ...extra });
    const agent = makeFakeAgent(`sess-${activity}`, cwd);
    host.emit('agent/created', { agent });
    return { host, agent };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function seedDisk(cwd) {
  bootstrapProject({ cwd, problemId: 'demo', brief: '{"target":"http://10.0.0.8:8080"}' });
}

test('活动模式 decide：只注册图工具，执行类与环境类工具在 schema 层就不存在', () => {
  const cwd = tmpDir('fgs-act-decide-');
  seedDisk(cwd);
  const { host } = bootActivity({ cwd, activity: 'decide' });
  assert.deepEqual([...host.tools.keys()].sort(), [
    'fgs_add_subgoal',
    'fgs_change_step_priority',
    'fgs_claim_step',
    'fgs_commit',
    'fgs_drop_step',
    'fgs_drop_subgoal',
    'fgs_open_step',
    'fgs_preview',
    'fgs_reopen',
    'fgs_satisfy_goal',
    'fgs_status',
  ]);
  assert.equal(host.tools.has('fgs_submit_fact'), false);
  assert.equal(host.tools.has('fgs_seed'), false);
  assert.equal(host.tools.has('fgs_project'), false);
});

test('活动模式 execute：只注册执行工具；open step 在启动时自动认领', async () => {
  const cwd = tmpDir('fgs-act-exec-');
  seedDisk(cwd);
  const store = new GraphStore(path.dirname(projectGraphPath(cwd, 'demo')));
  const graph = store.load();
  graph.steps.push(openStep());
  store.save(graph);

  const { host, agent } = bootActivity({ cwd, activity: 'execute', step: 'step_001' });
  assert.deepEqual([...host.tools.keys()].sort(), [
    'fgs_commit_step',
    'fgs_preview',
    'fgs_status',
    'fgs_submit_fact',
  ]);
  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(status.ok, true, status.text);
  assert.match(status.text, /活动: execute/);
  assert.match(status.text, /run-execute/);
  assert.match(status.text, /step=step_001/);
  // 认领已经写进图（不是只在内存）；owner 是 **runId**，不是会话 id
  const claimed = store.load().steps.find((s) => s.id === 'step_001');
  assert.equal(claimed.owner, 'run-execute');
});

test('活动模式 execute：提交 Fact + 收束后，活动台账落一条 committed', async () => {
  const cwd = tmpDir('fgs-act-ledger-');
  seedDisk(cwd);
  const store = new GraphStore(path.dirname(projectGraphPath(cwd, 'demo')));
  const graph = store.load();
  graph.steps.push(openStep());
  store.save(graph);

  const { host, agent } = bootActivity({ cwd, activity: 'execute', step: 'step_001' });
  const submitted = await host.callTool('fgs_submit_fact', {
    title: '端口扫描: 80/tcp 开放',
    content: '详情见 workspace/step001.txt',
  }, agent);
  assert.equal(submitted.ok, true, submitted.text);
  const committed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(committed.ok, true, committed.text);
  // 回合收口（headless 一 shot 的正常退出路径）
  host.emit('agent/turn-stopping', { agent });

  const ledger = path.join(path.dirname(projectGraphPath(cwd, 'demo')), 'activity.jsonl');
  assert.equal(fs.existsSync(ledger), true, '缺 activity.jsonl');
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].activity, 'execute');
  assert.equal(lines[0].stepId, 'step_001');
  assert.equal(lines[0].outcome, 'committed');
  // 图里确实落了 Fact 且 step 已 done
  const after = store.load();
  assert.equal(after.steps.find((s) => s.id === 'step_001').state, 'done');
  assert.ok(after.facts.some((f) => f.title.includes('端口扫描')));
});

test('活动模式 execute：FGS_STEP 指向不存在的 step → blocked，且不注册任何 tool 之外的副作用', async () => {
  const cwd = tmpDir('fgs-act-blocked-');
  seedDisk(cwd);
  const { host, agent } = bootActivity({ cwd, activity: 'execute', step: 'step_404' });
  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(status.ok, true, status.text);
  assert.match(status.text ?? '', /step_404/);
  const context = host.contexts[0].text({ scope: agent });
  assert.match(context, /本轮不可执行/);
  assert.match(context, /直接结束回合/);
  host.emit('agent/turn-stopping', { agent });
  const ledger = path.join(path.dirname(projectGraphPath(cwd, 'demo')), 'activity.jsonl');
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].outcome, 'blocked');
});

test('活动模式 decide：system 段是活动规则、上下文给出结束信号；不再渲染旧角色规则', () => {
  const cwd = tmpDir('fgs-act-rules-');
  seedDisk(cwd);
  const { host, agent } = bootActivity({ cwd, activity: 'decide' });
  assert.match(host.sections[0].text, /FGS 活动模式/);
  assert.doesNotMatch(host.sections[0].text, /角色由图的 open step 自动决定/);
  const context = host.contexts[0].text({ scope: agent });
  assert.match(context, /本轮活动】Decide/);
  assert.match(context, /结束信号/);
  assert.match(context, /fgs_commit/);
});

test('活动模式：execute 收束后环境动作被 guard 拒（活动结束就该停）', async () => {
  const cwd = tmpDir('fgs-act-stop-');
  seedDisk(cwd);
  const store = new GraphStore(path.dirname(projectGraphPath(cwd, 'demo')));
  const graph = store.load();
  graph.steps.push(openStep());
  store.save(graph);

  A:
  {
    const { host, agent } = bootActivity({ cwd, activity: 'execute', step: 'step_001' });
    host.ctx.tools.register({
      name: 'bash',
      description: 'fake bash',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      async execute() { return { ok: true, text: 'ran' }; },
    });
    const okRun = await host.callTool('bash', {}, agent);
    assert.equal(okRun.ok, true, '收束前 bash 应放行');
    await host.callTool('fgs_submit_fact', { title: 'w', content: 'c' }, agent);
    await host.callTool('fgs_commit_step', {}, agent);
    const denied = await host.callTool('bash', {}, agent);
    assert.equal(denied.ok, false);
    assert.match(denied.text, /活动结束/);
  }
});

test('活动模式：正常模式（无 FGS_ACTIVITY）仍注册全部工具——legacy 行为不变', () => {
  const cwd = tmpDir('fgs-act-legacy-');
  seedDisk(cwd);
  const previous = process.env.FGS_ACTIVITY;
  delete process.env.FGS_ACTIVITY;
  try {
    const host = makeFakeHost();
    const services = wireServices(host);
    host.ctx.services = { ...host.ctx.services, ...services };
    applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex' });
    for (const name of ['fgs_seed', 'fgs_project', 'fgs_open_step', 'fgs_submit_fact', 'fgs_commit_step']) {
      assert.ok(host.tools.has(name), `legacy 模式缺工具 ${name}`);
    }
  } finally {
    if (previous !== undefined) process.env.FGS_ACTIVITY = previous;
  }
});

/* ---------------------------------------------- 死 run 的认领回收 */

test('release_step：只回收 owner 匹配的 open step，追加未完成 Fact，step 仍 open', () => {
  const cwd = tmpDir('fgs-release-');
  seedDisk(cwd);
  const store = new GraphStore(path.dirname(projectGraphPath(cwd, 'demo')));
  const graph = store.load();
  graph.steps.push(openStep('step_001', { owner: 'run-dead', claimedAt: new Date().toISOString() }));
  store.save(graph);

  const wrong = releaseStep({ cwd, problemId: 'demo', stepId: 'step_001', owner: 'run-other' });
  assert.equal(wrong.skipped, 'owner=run-dead', '别的 run 的认领不能回收');

  const released = releaseStep({ cwd, problemId: 'demo', stepId: 'step_001', owner: 'run-dead', reason: '超时' });
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.match(released.factId, /^fact_/);
  const after = store.load();
  const step = after.steps.find((s) => s.id === 'step_001');
  assert.equal(step.owner ?? null, null, '认领必须放回任务池');
  assert.equal(step.state, 'open', 'step 不关，只回收认领');
  assert.equal(after.facts.some((f) => f.id === released.factId), true, '必须留下未完成 Fact');

  const again = releaseStep({ cwd, problemId: 'demo', stepId: 'step_001', owner: 'run-dead' });
  assert.equal(again.skipped, 'owner=null', '幂等：第二次什么都不做');
});

test('活动模式 decide：fgs_commit 不把新 step 认领给 decide run（否则 Execute 领不到）', async () => {
  const cwd = tmpDir('fgs-act-decide-claim-');
  seedDisk(cwd);
  const { host, agent } = bootActivity({ cwd, activity: 'decide' });
  const opened = await host.callTool('fgs_open_step', { action: '侦察', from: ['fact_origin'] }, agent);
  assert.equal(opened.ok, true, opened.text);
  const committed = await host.callTool('fgs_commit', {}, agent);
  assert.equal(committed.ok, true, committed.text);
  const store = new GraphStore(path.dirname(projectGraphPath(cwd, 'demo')));
  const step = store.load().steps[0];
  assert.equal(step.state, 'open');
  assert.equal(step.owner ?? null, null, 'decide run 开出的 step 必须保持未认领');
});
