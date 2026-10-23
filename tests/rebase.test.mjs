/** v5.2 kernel：图版本 rev + 批量 rebase 提交（Decide 与 Execute 并发的地基）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore, revisionOf } from '../controller/index.js';
import { openStepOp, submitFactOp } from '../controller/ops.js';
import { bootstrapProject } from '../tools/bootstrap_project.mjs';
import { projectGraphPath, tmpDir } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revisionWorker = path.join(repoRoot, 'tests', 'fixtures', 'revision_of.mjs');
const decisionWorker = path.join(repoRoot, 'tests', 'fixtures', 'concurrent_decision.mjs');

/** 种题后的空图（fact_origin + goal_final），返回 project root。 */
function seeded(prefix = 'fgs-rebase-') {
  const cwd = tmpDir(prefix);
  bootstrapProject({ cwd, problemId: 'demo', brief: 'brief' });
  return { cwd, root: path.dirname(projectGraphPath(cwd, 'demo')) };
}

function runNode(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('revisionOf：同图稳定，写一次就变，跨进程一致', async () => {
  const { root } = seeded();
  const store = new GraphStore(root);
  const before = revisionOf(store.load());
  assert.equal(revisionOf(store.load()), before, '同一份 graph.yaml 两次哈希必须相等');

  const [a, b] = await Promise.all([
    runNode(revisionWorker, [root]),
    runNode(revisionWorker, [root]),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(a.stdout, before, '另一个进程算出的 rev 必须与当前进程一致');

  const controller = new Controller(store);
  controller.transact((graph) => controller.apply(
    openStepOp({ action: '探路', from: ['fact_origin'], stepId: 'step_001' }), graph,
  ));
  assert.notEqual(revisionOf(store.load()), before, '写一次图 rev 必须变化');
});

test('transactWithRev：返回 { graph, rev, baseRev }，旧 transact 仍返回图', () => {
  const { root } = seeded();
  const store = new GraphStore(root);

  const out = store.transactWithRev((graph) => ({ graph }));
  assert.ok(Array.isArray(out.graph.facts), 'graph 原样返回');
  assert.equal(typeof out.rev, 'string');
  assert.equal(out.rev.length, 64);
  assert.equal(out.baseRev, out.rev, '无外部写时 baseRev === rev');
  assert.ok(!Array.isArray(out), 'transactWithRev 不能退化成返回图');

  const graph = store.transact((g) => g);
  assert.ok(Array.isArray(graph.facts), '旧 transact 的返回类型保持为图');
  assert.equal(graph.steps.length, 0);
});

test('applyBatch(rebase=true)：冲突项拒收，其余照常落盘', () => {
  const { root } = seeded();
  const store = new GraphStore(root);
  const controller = new Controller(store);

  // step_001 先完成（submit_fact 会把 step 置 done），之后 drop 它必然冲突。
  controller.transact((graph) => {
    let g = controller.apply(openStepOp({ action: '已完成', from: ['fact_origin'], stepId: 'step_001' }), graph);
    g = controller.apply(submitFactOp({
      title: '已拿到的结论', content: '结论内容足够长不会被蒸馏拒收', producedBy: 'step_001',
    }), g);
    return g;
  });

  const out = controller.applyBatch([
      openStepOp({ action: '新任务 A', from: ['fact_origin'], stepId: 'step_002' }),
      { type: 'drop_step', stepId: 'step_001', reason: '并发后该任务已过时' },
      openStepOp({ action: '新任务 B', from: ['fact_origin'], stepId: 'step_003' }),
    ], { rebase: true });

  assert.deepEqual(out.applied, ['open_step', 'open_step']);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].op, 'drop_step');
  assert.match(out.rejected[0].detail, /非 open/);

  const graph = store.load();
  assert.ok(graph.steps.some((s) => s.id === 'step_002'), '失败前后的独立 op 都要落盘');
  assert.ok(graph.steps.some((s) => s.id === 'step_003'));
  assert.equal(graph.steps.find((s) => s.id === 'step_001').state, 'done', '冲突项不能改图');
});

test('applyBatch(rebase=false)：任一项失败则整批不落盘（strict 保持）', () => {
  const { root } = seeded();
  const store = new GraphStore(root);
  const controller = new Controller(store);
  controller.transact((graph) => {
    let g = controller.apply(openStepOp({ action: '已完成', from: ['fact_origin'], stepId: 'step_001' }), graph);
    g = controller.apply(submitFactOp({
      title: '已拿到的结论', content: '结论内容足够长不会被蒸馏拒收', producedBy: 'step_001',
    }), g);
    return g;
  });

  assert.throws(() => controller.applyBatch([
    openStepOp({ action: '新任务 A', from: ['fact_origin'], stepId: 'step_002' }),
    { type: 'drop_step', stepId: 'step_001', reason: '已过时' },
  ], { rebase: false }), /非 open/);

  assert.equal(store.load().steps.some((s) => s.id === 'step_002'), false, 'strict 模式必须整批不落盘');
});

test('applyBatch(rebase=true)：中间 op 失败不影响后续独立 op', () => {
  const { root } = seeded();
  const store = new GraphStore(root);
  const controller = new Controller(store);

  const out = controller.applyBatch([
    openStepOp({ action: '任务 A', from: ['fact_origin'], stepId: 'step_001' }),
    { type: 'drop_step', stepId: 'step_999', reason: '不存在的 step' },
    openStepOp({ action: '任务 B', from: ['fact_origin'], stepId: 'step_002' }),
  ], { rebase: true });

  assert.deepEqual(out.applied, ['open_step', 'open_step']);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].op, 'drop_step');
  const graph = store.load();
  assert.ok(graph.steps.some((s) => s.id === 'step_001'));
  assert.ok(graph.steps.some((s) => s.id === 'step_002'));
});

test('applyBatch：baseRev 落后时 rebased=true，相等时 false', () => {
  const { root } = seeded();
  const store = new GraphStore(root);
  const controller = new Controller(store);

  const baseRev = revisionOf(store.load());
  const same = controller.applyBatch([], { rebase: true, baseRev });
  assert.equal(same.rebased, false);
  assert.equal(same.revBefore, baseRev);
  assert.equal(same.rev, baseRev);

  // 模拟「Decide 规划期间 Execute 改了图」。
  controller.transact((graph) => controller.apply(
    openStepOp({ action: '并发写入', from: ['fact_origin'], stepId: 'step_001' }), graph,
  ));
  const midRev = revisionOf(store.load());

  const stale = controller.applyBatch(
    [openStepOp({ action: 'Decide 的补充任务', from: ['fact_origin'], stepId: 'step_002' })],
    { rebase: true, baseRev },
  );
  assert.equal(stale.rebased, true);
  assert.equal(stale.revBefore, midRev, 'revBefore 是进锁后读到的当前版本');
  assert.equal(stale.rev, revisionOf(store.load()), 'rev 是落盘后的版本');
  assert.ok(stale.graph.steps.some((s) => s.id === 'step_002'), '冲突后仍按最新图应用');
});

test('applyBatch(rebase=true)：两个进程并发各追加一个 step，都不丢', async () => {
  const { root } = seeded();
  const [a, b] = await Promise.all([
    runNode(decisionWorker, [root, 'step_001']),
    runNode(decisionWorker, [root, 'step_002']),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.match(a.stdout, /open_step/);
  assert.match(b.stdout, /open_step/);

  const graph = new GraphStore(root).load();
  const ids = graph.steps.map((s) => s.id).sort();
  assert.deepEqual(ids, ['step_001', 'step_002'], '并发 RMW 不能互相覆盖');
});

test('revisionOf 只由图内容决定：graph.json 被改/被删都不影响', () => {
  const { root } = seeded();
  const store = new GraphStore(root);
  const before = revisionOf(store.load());

  fs.writeFileSync(store.jsonPath, '{"facts":[],"goals":[],"steps":[]}\n', 'utf8');
  assert.equal(revisionOf(store.load()), before);
  fs.unlinkSync(store.jsonPath);
  assert.equal(revisionOf(store.load()), before);
});
