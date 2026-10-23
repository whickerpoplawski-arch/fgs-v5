/** v5.1 插件侧：Bootstrap 活动、收束轮规则、sessionId 台账、commit_step 返回 fact id。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import { Controller, GraphStore } from '../controller/index.js';
import { openStepOp } from '../controller/ops.js';
import { bootstrapProject } from '../tools/bootstrap_project.mjs';
import {
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

const FLAG = 'FLAG{dsh_native_ok}';

function projectWithStep({ coldStart = false } = {}) {
  const cwd = tmpDir('fgs-act-');
  bootstrapProject({ cwd, problemId: 'demo', brief: '{"target":"http://10.0.0.8:8080"}', coldStartStep: coldStart });
  if (!coldStart) {
    const root = path.dirname(projectGraphPath(cwd, 'demo'));
    const store = new GraphStore(root);
    const controller = new Controller(store);
    controller.transact((graph) => controller.apply(
      openStepOp({ action: '侦察 Web', from: ['fact_origin'], stepId: 'step_001' }),
      graph,
    ));
  }
  return cwd;
}

function bootAt(cwd, overrides = {}) {
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
  applyPlugin(host.ctx, {
    stateDir: '.fgs',
    verifyMode: 'regex',
    ...overrides,
  });
  const agent = makeFakeAgent('sess-1', cwd);
  host.emit('agent/created', { agent });
  return { host, agent, cwd };
}

test('Bootstrap 活动：注册期只有执行类图工具 + satisfy_goal/commit，世界工具照常可用', async () => {
  const cwd = projectWithStep({ coldStart: true });
  const { host, agent } = bootAt(cwd, {
    activity: 'bootstrap',
    activityRunId: 'run-boot',
    activityStep: 'step_001',
  });

  assert.ok(host.tools.has('fgs_satisfy_goal'), 'bootstrap 必须能当场判 goal');
  assert.ok(host.tools.has('fgs_commit_step'));
  assert.equal(host.tools.has('fgs_reopen'), false, 'bootstrap 不该有 reopen');
  assert.equal(host.tools.has('fgs_open_step'), false, 'bootstrap 不做规划');

  // 规则段：冷启动直冲 + satisfy_goal 用法
  assert.match(host.sections[0].text, /Bootstrap（冷启动直冲）/);
  assert.match(host.sections[0].text, /fgs_satisfy_goal/);

  // 世界工具在 bootstrap 轮放行（它要真的去拿 flag）
  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, true, bash.text);

  // Fact → commit_step → satisfy_goal 一次走完
  const submitted = await host.callTool('fgs_submit_fact', {
    title: '拿到 flag',
    content: `证据: ${FLAG}`,
  }, agent);
  assert.equal(submitted.ok, true, submitted.text);
  const committed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(committed.ok, true, committed.text);
  const factId = committed.text.match(/新 Fact (fact_\d+)/)?.[1];
  assert.ok(factId, `commit_step 必须回报 fact id: ${committed.text}`);

  const staged = await host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final',
    reason: 'flag 已提交并被 ACK',
    satisfiedBy: [factId],
  }, agent);
  assert.equal(staged.ok, true, staged.text);
  assert.match(staged.text, /草稿/, 'satisfy_goal 先记草稿');
  const satisfied = await host.callTool('fgs_commit', {}, agent);
  assert.equal(satisfied.ok, true, satisfied.text);

  const graph = new GraphStore(path.dirname(projectGraphPath(cwd, 'demo'))).load();
  assert.ok(graph.goals.find((goal) => goal.id === 'goal_final').satisfiedAt);
  // 活动台账：owner = runId（不是会话 id），sessionId 记真实宿主会话
  const ledgerPath = path.join(path.dirname(projectGraphPath(cwd, 'demo')), 'activity.jsonl');
  host.emit('agent/turn-stopping', { agent });
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const last = lines[lines.length - 1];
  assert.equal(last.runId, 'run-boot');
  assert.equal(last.activity, 'bootstrap');
  assert.equal(last.outcome, 'committed');
  assert.equal(last.sessionId, 'sess-1', '台账必须登记宿主 sessionId，收束轮靠它续跑');
  assert.equal(last.conclude, false);
});

test('收束轮：规则与上下文都声明「停止探索、只交付已确认内容」', async () => {
  const cwd = projectWithStep();
  const { host, agent } = bootAt(cwd, {
    activity: 'execute',
    activityRunId: 'run-ex',
    activityStep: 'step_001',
    concludePhase: true,
    activityBudgetMs: 600000,
  });
  assert.match(host.sections[0].text, /收束轮（conclude，覆盖一切旧指令）/);
  assert.match(host.sections[0].text, /立即停止探索/);
  assert.match(host.sections[0].text, /墙钟预算约 10 分钟/);

  const context = host.contexts[0].text({ scope: agent });
  assert.match(context, /收束轮/);
  assert.match(context, /收束指令/);
  assert.match(context, /墙钟预算/);
});

test('execute 活动：satisfy_goal 不在注册期 toolset 里（规划权不外溢）', () => {
  const cwd = projectWithStep();
  const { host } = bootAt(cwd, {
    activity: 'execute',
    activityRunId: 'run-ex2',
    activityStep: 'step_001',
  });
  assert.equal(host.tools.has('fgs_satisfy_goal'), false);
  assert.equal(host.tools.has('fgs_submit_fact'), true);
  assert.equal(host.tools.has('fgs_commit_step'), true);
});

test('活动台账：Execute 正常提交 → outcome=committed，conclude=false', async () => {
  const cwd = projectWithStep();
  const { host, agent } = bootAt(cwd, {
    activity: 'execute',
    activityRunId: 'run-ex3',
    activityStep: 'step_001',
  });
  const submitted = await host.callTool('fgs_submit_fact', { title: '侦察结果', content: '端口 80' }, agent);
  assert.equal(submitted.ok, true, submitted.text);
  const committed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(committed.ok, true, committed.text);
  host.emit('agent/turn-stopping', { agent });

  const ledgerPath = path.join(path.dirname(projectGraphPath(cwd, 'demo')), 'activity.jsonl');
  const last = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').pop());
  assert.equal(last.outcome, 'committed');
  assert.equal(last.stepId, 'step_001');
});

test('活动 Decide：没有环境工具、没有 execute 工具，只有图工具', () => {
  const cwd = projectWithStep({ coldStart: true });
  // 冷启动 step 还在，但把这次 run 声明成 Decide（编排器判定 Decide 的场景）
  const { host, agent } = bootAt(cwd, {
    activity: 'decide',
    activityRunId: 'run-dec',
  });
  assert.equal(host.tools.has('fgs_submit_fact'), false);
  assert.equal(host.tools.has('fgs_commit_step'), false);
  assert.equal(host.tools.has('fgs_open_step'), true);
  assert.match(host.sections[0].text, /本轮 = Decide/);
  void agent;
});

test('活动模式不污染 legacy：同一进程里 legacy 单会话仍注册全量工具', () => {
  const cwd = projectWithStep();
  const { host } = bootAt(cwd, {});
  assert.ok(host.tools.has('fgs_satisfy_goal'));
  assert.ok(host.tools.has('fgs_submit_fact'));
  assert.match(host.sections[0].text, /FGS 黑板/);
});
