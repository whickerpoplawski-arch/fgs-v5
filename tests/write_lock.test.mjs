/** v5.1 跨进程写锁：并行 RMW 不丢更新；claim_step CLI 预认领/租约语义。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore } from '../controller/index.js';
import { openStepOp } from '../controller/ops.js';
import { bootstrapProject } from '../tools/bootstrap_project.mjs';
import { claimStep } from '../tools/claim_step.mjs';
import { projectGraphPath, tmpDir } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = path.join(repoRoot, 'tests', 'fixtures', 'concurrent_release.mjs');

function seededRoot() {
  const cwd = tmpDir('fgs-lock-');
  bootstrapProject({ cwd, problemId: 'demo', brief: 'brief' });
  const root = path.dirname(projectGraphPath(cwd, 'demo'));
  return { cwd, root };
}

function addOpenSteps(root, ids, ownerOf) {
  const store = new GraphStore(root);
  const controller = new Controller(store);
  controller.transact((graph) => {
    let g = graph;
    for (const id of ids) {
      g = controller.apply(openStepOp({ action: `step ${id}`, from: ['fact_origin'], stepId: id }), g);
      g = controller.apply({
        type: 'claim_step', stepId: id, owner: ownerOf(id), claimedAt: null,
      }, g);
    }
    return g;
  });
}

function runWorker(root, stepId, owner) {
  return new Promise((resolve) => {
    const child = spawn('node', [worker, root, stepId, owner], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('并行 transact：8 个进程各自 release 一条 step，Fact 一条都不丢', async () => {
  const { root } = seededRoot();
  const ids = Array.from({ length: 8 }, (_, i) => `step_${String(i + 1).padStart(3, '0')}`);
  addOpenSteps(root, ids, (id) => `run-${id}`);

  const results = await Promise.all(ids.map((id) => runWorker(root, id, `run-${id}`)));
  for (const [index, result] of results.entries()) {
    assert.equal(result.code, 0, `worker ${index} 失败: ${result.stderr}`);
  }

  const graph = new GraphStore(root).load();
  // 8 条 unfinished Fact + 1 条 origin；读改写若没加锁，后写的会覆盖先写的。
  assert.equal(graph.facts.length, 9, `facts=${graph.facts.map((f) => f.id).join(',')}`);
  for (const id of ids) {
    const step = graph.steps.find((item) => item.id === id);
    assert.equal(step.owner ?? null, null, `${id} 的认领应被清空`);
    assert.ok(step.linkedUnfinishedFactId, `${id} 应挂上未完成 Fact`);
  }
  const linked = new Set(graph.steps.map((step) => step.linkedUnfinishedFactId).filter(Boolean));
  assert.equal(linked.size, 8, '每条 step 的未完成 Fact 必须各自独立（不能指向同一条）');
});

test('transact：中途抛 WriteRejected 时整体不落盘', () => {
  const { root } = seededRoot();
  const store = new GraphStore(root);
  const controller = new Controller(store);
  const before = store.load();
  assert.throws(() => controller.transact((graph) => {
    const next = controller.apply(
      openStepOp({ action: '合法 step', from: ['fact_origin'], stepId: 'step_001' }),
      graph,
    );
    // 第二项引用不存在的 fact：apply 抛错，第一项也不能落盘。
    controller.apply(openStepOp({ action: '非法 step', from: ['fact_999'] }), next);
  }), /不存在 fact/);
  const after = store.load();
  assert.equal(after.steps.length, before.steps.length);
  assert.equal(after.steps.length, 0);
});

test('claim_step：预认领先写 owner；租约内别的 owner 抢不到', () => {
  const { cwd, root } = seededRoot();
  const store = new GraphStore(root);
  const controller = new Controller(store);
  controller.transact((graph) => controller.apply(
    openStepOp({ action: '侦察', from: ['fact_origin'], stepId: 'step_001' }),
    graph,
  ));

  const first = claimStep({ cwd, problemId: 'demo', stepId: 'step_001', owner: 'run-a', leaseMs: 60000 });
  assert.equal(first.claimed, true);
  assert.equal(new GraphStore(root).load().steps[0].owner, 'run-a');

  const second = claimStep({ cwd, problemId: 'demo', stepId: 'step_001', owner: 'run-b', leaseMs: 60000 });
  assert.equal(second.claimed, undefined);
  assert.match(second.skipped, /held-by=run-a/);

  // 租约过期 ⇒ 可接手（Cairn：认领是租约，不是身份）。
  // 直接把 claimedAt 改老，避免「同一毫秒内 claim 导致租约还没过期」的时间抖动。
  const store2 = new GraphStore(root);
  const g = store2.load();
  g.steps[0].claimedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  store2.save(g);
  const stale = claimStep({ cwd, problemId: 'demo', stepId: 'step_001', owner: 'run-b', leaseMs: 60000 });
  assert.equal(stale.claimed, true);
  assert.equal(new GraphStore(root).load().steps[0].owner, 'run-b');
});

test('claim_step：step 已 done / 不存在 → skipped（幂等）', () => {
  const { cwd, root } = seededRoot();
  assert.match(claimStep({ cwd, problemId: 'demo', stepId: 'step_999', owner: 'r' }).skipped, /no-step/);
  const store = new GraphStore(root);
  const controller = new Controller(store);
  controller.transact((graph) => {
    const opened = controller.apply(
      openStepOp({ action: 'a', from: ['fact_origin'], stepId: 'step_001' }), graph,
    );
    return controller.apply(
      { type: 'submit_fact', title: 't', content: 'c', producedBy: 'step_001' }, opened,
    );
  });
  assert.match(claimStep({ cwd, problemId: 'demo', stepId: 'step_001', owner: 'r' }).skipped, /step-done/);
});
