/** v5.2 插件侧：Decide rebase 提交（冲突降级 / delta 回灌 / 台账 / graphRev / 保守档）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import { Controller, GraphStore } from '../controller/index.js';
import {
  changePriorityOp, dropStepOp, openStepOp, submitFactOp,
} from '../controller/ops.js';
import { bootstrapProject } from '../tools/bootstrap_project.mjs';
import {
  callRoute,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

function projectWithStep() {
  const cwd = tmpDir('fgs-v52-');
  bootstrapProject({ cwd, problemId: 'demo', brief: '{"target":"http://10.0.0.8:8080"}' });
  rootOf(cwd);
  const controller = new Controller(new GraphStore(rootOf(cwd)));
  controller.transact((graph) => controller.apply(
    openStepOp({ action: '侦察 Web', from: ['fact_origin'], stepId: 'step_001' }),
    graph,
  ));
  return cwd;
}

function rootOf(cwd) {
  return path.dirname(projectGraphPath(cwd, 'demo'));
}

/** 模拟一个并发 Execute：在 Decide 规划期间直接改图。 */
function externalWrite(cwd, mutate) {
  const controller = new Controller(new GraphStore(rootOf(cwd)));
  return controller.transact((graph) => mutate(controller, graph));
}

function bootAt(cwd, overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, {
    stateDir: '.fgs',
    verifyMode: 'regex',
    ...overrides,
  });
  const agent = makeFakeAgent('sess-1', cwd);
  host.emit('agent/created', { agent });
  // 模拟回合开始：真实宿主在模型动作之前就会注入上下文，run 在这一刻被建出来、
  // Decide 的 rebase 基线也在这一刻记下。之后的 externalWrite 才算「并发期间的改动」。
  host.contexts[0]?.text?.({ scope: agent });
  return { host, agent };
}

function ledgerLines(cwd) {
  const ledgerPath = path.join(rootOf(cwd), 'activity.jsonl');
  return fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('Decide + rebase：并发改动后按最新图逐项生效，冲突项回报原因', async () => {
  const cwd = projectWithStep();
  const { host, agent } = bootAt(cwd, {
    activity: 'decide', activityRunId: 'run-dec-rb', rebase: true,
  });
  // 并发 Execute 已经把旧方向判死
  externalWrite(cwd, (controller, graph) => controller.apply(
    dropStepOp({ stepId: 'step_001', reason: '并发执行确认该方向无效' }), graph,
  ));

  const result = await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '换方向重试', from: ['fact_origin'], stepId: 'step_002' },
      { op: 'drop_step', stepId: 'step_001', reason: '旧方向无效' },
    ],
  }, agent);

  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /已提交 1 项/);
  assert.match(result.text, /图在你规划期间变化过/);
  assert.match(result.text, /以下操作冲突未生效/);
  assert.match(result.text, /drop_step.*非 open/s);

  const graph = new GraphStore(rootOf(cwd)).load();
  assert.ok(graph.steps.some((s) => s.id === 'step_002'), '未冲突的 op 必须落盘');
  assert.equal(graph.steps.find((s) => s.id === 'step_001').state, 'dropped', '冲突项不得改图');
});

test('Decide 未开 rebase：冲突时整批拒写，图零改动（v5.1 语义不变）', async () => {
  const cwd = projectWithStep();
  const { host, agent } = bootAt(cwd, {
    activity: 'decide', activityRunId: 'run-dec-strict',
  });
  externalWrite(cwd, (controller, graph) => controller.apply(
    dropStepOp({ stepId: 'step_001', reason: '并发执行确认该方向无效' }), graph,
  ));

  const result = await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '换方向重试', from: ['fact_origin'], stepId: 'step_002' },
      { op: 'drop_step', stepId: 'step_001', reason: '旧方向无效' },
    ],
  }, agent);

  assert.equal(result.ok, false);
  assert.match(result.text, /整批不落盘/);
  assert.equal(new GraphStore(rootOf(cwd)).load().steps.some((s) => s.id === 'step_002'), false);
});

test('legacy（无活动）：即便 rebase:true 也仍走整批原子（不变量 1/2）', async () => {
  const cwd = projectWithStep();
  const { host, agent } = bootAt(cwd, { rebase: true });
  externalWrite(cwd, (controller, graph) => controller.apply(
    dropStepOp({ stepId: 'step_001', reason: '并发执行确认该方向无效' }), graph,
  ));

  const result = await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '换方向重试', from: ['fact_origin'], stepId: 'step_002' },
      { op: 'drop_step', stepId: 'step_001', reason: '旧方向无效' },
    ],
  }, agent);

  assert.equal(result.ok, false);
  assert.match(result.text, /整批不落盘/);
});

test('Decide + rebase：并发期间新增 Fact 会回灌进提交响应（delta）', async () => {
  const cwd = projectWithStep();
  const { host, agent } = bootAt(cwd, {
    activity: 'decide', activityRunId: 'run-dec-delta', rebase: true,
  });
  externalWrite(cwd, (controller, graph) => controller.apply(submitFactOp({
    title: '并发期间的新发现',
    content: '端口 8080 上是一个未授权接口',
    producedBy: 'step_001',
  }), graph));

  const result = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '基于新发现继续', from: ['fact_001'], stepId: 'step_002' }],
  }, agent);

  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /图在你规划期间变化过/);
  assert.match(result.text, /新增 Fact: fact_001「并发期间的新发现」/);
});

test('Decide + rebaseAllow=append：并发时 drop_step 推迟，open_step 照常生效', async () => {
  const cwd = projectWithStep();
  const { host, agent } = bootAt(cwd, {
    activity: 'decide', activityRunId: 'run-dec-append', rebase: true, rebaseAllow: 'append',
  });
  externalWrite(cwd, (controller, graph) => controller.apply(
    changePriorityOp({ stepId: 'step_001', priority: 'high' }), graph,
  ));

  const result = await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '新增一条方向', from: ['fact_origin'], stepId: 'step_002' },
      { op: 'drop_step', stepId: 'step_001', reason: '旧方向无效' },
    ],
  }, agent);

  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /并发模式下该操作等 Execute 清空后再提交/);
  const graph = new GraphStore(rootOf(cwd)).load();
  assert.ok(graph.steps.some((s) => s.id === 'step_002'));
  assert.equal(graph.steps.find((s) => s.id === 'step_001').state, 'open', '保守档不得并发 drop');
});

test('/fgs/state 暴露 graphRev（12 位），提交后变化', async () => {
  const cwd = projectWithStep();
  const { host, agent } = bootAt(cwd, {
    activity: 'decide', activityRunId: 'run-dec-state', rebase: true,
  });
  const route = host.routes.find((r) => r.path === '/fgs/state');
  // 活动模式下 run.sid 是 runId（owner token），不是会话 id；这里按活动 Project 取快照。
  const before = await callRoute(route, '/fgs/state');
  assert.equal(before.statusCode, 200);
  assert.match(before.json.graphRev, /^[0-9a-f]{12}$/);
  assert.equal(before.json.lastCommit.rejected, 0);

  const committed = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '新方向', from: ['fact_origin'], stepId: 'step_002' }],
  }, agent);
  assert.equal(committed.ok, true, committed.text);

  const after = await callRoute(route, '/fgs/state');
  assert.notEqual(after.json.graphRev, before.json.graphRev);
});

test('活动台账记录 rebase 的 revBefore/revAfter/applied/rejected', async () => {
  const cwd = projectWithStep();
  const { host, agent } = bootAt(cwd, {
    activity: 'decide', activityRunId: 'run-dec-ledger', rebase: true,
  });
  externalWrite(cwd, (controller, graph) => controller.apply(
    dropStepOp({ stepId: 'step_001', reason: '并发执行确认该方向无效' }), graph,
  ));
  const result = await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '换方向重试', from: ['fact_origin'], stepId: 'step_002' },
      { op: 'drop_step', stepId: 'step_001', reason: '旧方向无效' },
    ],
  }, agent);
  assert.equal(result.ok, true, result.text);
  host.emit('agent/turn-stopping', { agent });

  const last = ledgerLines(cwd).pop();
  assert.equal(last.activity, 'decide');
  assert.equal(last.outcome, 'committed');
  assert.match(last.revBefore, /^[0-9a-f]{64}$/);
  assert.match(last.revAfter, /^[0-9a-f]{64}$/);
  assert.notEqual(last.revBefore, last.revAfter);
  assert.equal(last.applied, 1);
  assert.equal(last.rejected, 1);
  assert.equal(last.sessionId, 'sess-1');
});
