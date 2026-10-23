/** v5.1 活动选择：冷启动 bootstrap、Finding 触发 Decide、每 K 次 Execute 插 Decide。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { graphSignature, isColdStart, nextActivity } from '../controller/activity.js';
import { bootstrapProject } from '../tools/bootstrap_project.mjs';
import { GraphStore } from '../controller/index.js';
import { projectGraphPath, tmpDir } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'tools', 'activity.mjs');

function graph({ facts = [], steps = [], goals = [] } = {}) {
  return {
    facts,
    steps,
    goals: goals.length > 0 ? goals : [{ id: 'goal_final', kind: 'final', criterion: '拿到 flag' }],
  };
}

const origin = { id: 'fact_origin', title: '题目信息', content: 'target' };
const coldStep = {
  id: 'step_001', action: '冷启动直冲', from: ['fact_origin'], actor: 'bootstrap',
  priority: 'high', state: 'open',
};
const normalStep = (id = 'step_001') => ({
  id, action: '侦察', from: ['fact_origin'], actor: 'agent', priority: 'normal', state: 'open',
});

test('冷启动：只有 origin + bootstrap step → kind=bootstrap，不花一轮 Decide', () => {
  const g = graph({ facts: [origin], steps: [coldStep] });
  assert.equal(isColdStart(g), true);
  const picked = nextActivity(g);
  assert.equal(picked.kind, 'bootstrap');
  assert.equal(picked.stepId, 'step_001');
  assert.equal(picked.counts.coldStart, true);
});

test('冷启动结束：多了一条 Fact 或 step 不是 bootstrap → 回到正常 Decide/Execute', () => {
  const withFact = graph({ facts: [origin, { id: 'fact_002', title: '观察', content: 'x' }], steps: [coldStep] });
  assert.equal(isColdStart(withFact), false);
  assert.equal(nextActivity(withFact).kind, 'execute');

  const normal = graph({ facts: [origin], steps: [normalStep()] });
  assert.equal(isColdStart(normal), false);
  assert.equal(nextActivity(normal).kind, 'execute');
});

test('签名包含 Finding 数：n0 → n1', () => {
  const base = graph({ facts: [origin], steps: [normalStep()] });
  const withFinding = graph({
    facts: [origin, { id: 'fact_002', title: 'SQL 注入', content: 'x', findingType: 'vuln' }],
    steps: [normalStep()],
  });
  assert.match(graphSignature(base), /:n0$/);
  assert.match(graphSignature(withFinding), /:n1$/);
  assert.equal(nextActivity(withFinding).counts.findings, 1);
});

test('新 Finding 立即触发 Decide（即使队列里还有 step）', () => {
  const g = graph({
    facts: [origin, { id: 'fact_002', title: '拿到 shell', content: 'x', findingType: 'shell' }],
    steps: [normalStep('step_001'), normalStep('step_002')],
  });
  const due = nextActivity(g, { findingsAtLastDecide: 0, executesSinceDecide: 0, decideEvery: 3 });
  assert.equal(due.kind, 'decide');
  assert.match(due.reason, /新 Finding/);

  const notDue = nextActivity(g, { findingsAtLastDecide: 1, executesSinceDecide: 0, decideEvery: 3 });
  assert.equal(notDue.kind, 'execute');
});

test('每 K 次 Execute 插一次 Decide；K=0 关闭该触发', () => {
  const g = graph({ facts: [origin], steps: [normalStep('step_001'), normalStep('step_002')] });
  const due = nextActivity(g, { findingsAtLastDecide: 0, executesSinceDecide: 2, decideEvery: 2 });
  assert.equal(due.kind, 'decide');
  assert.match(due.reason, /decideEvery=2/);

  const off = nextActivity(g, { findingsAtLastDecide: 0, executesSinceDecide: 9, decideEvery: 0 });
  assert.equal(off.kind, 'execute');
});

test('队列空 → Decide；图没变 → defer（不空转）', () => {
  const g = graph({ facts: [origin], steps: [] });
  const first = nextActivity(g);
  assert.equal(first.kind, 'decide');
  const again = nextActivity(g, { lastSignature: graphSignature(g) });
  assert.equal(again.kind, 'defer');
});

test('CLI：新参数透传（findings / executes / decide-every）', () => {
  const cwd = tmpDir('fgs-select-');
  bootstrapProject({ cwd, problemId: 'demo', brief: '{"target":"http://x"}', coldStartStep: true });
  const root = path.dirname(projectGraphPath(cwd, 'demo'));
  const store = new GraphStore(root);
  // 冷启动 step 先跑掉：改成普通 step + 一条 Finding，才能测 Decide 触发。
  const g = store.load();
  g.steps[0].actor = 'agent';
  g.facts.push({ id: 'fact_002', title: 'finding', content: 'x', findingType: 'vuln' });
  store.save(g);

  const run = (args) => JSON.parse(spawnSync('node', [cli, '--cwd', cwd, '--problem-id', 'demo', ...args], {
    cwd: repoRoot, encoding: 'utf8',
  }).stdout.trim());
  const due = run(['--findings-at-last-decide', '0', '--executes-since-decide', '0']);
  assert.equal(due.kind, 'decide');
  const notDue = run(['--findings-at-last-decide', '1', '--executes-since-decide', '0']);
  assert.equal(notDue.kind, 'execute');
  const every = run(['--findings-at-last-decide', '1', '--executes-since-decide', '2', '--decide-every', '2']);
  assert.equal(every.kind, 'decide');
});

test('bootstrap_project --cold-start-step：预种 step_001（actor=bootstrap，from=fact_origin）', () => {
  const cwd = tmpDir('fgs-cold-');
  const seeded = bootstrapProject({ cwd, problemId: 'demo', brief: 'brief', coldStartStep: true });
  assert.equal(seeded.ok, true);
  const g = new GraphStore(path.dirname(projectGraphPath(cwd, 'demo'))).load();
  assert.equal(g.steps.length, 1);
  assert.deepEqual(g.steps[0].from, ['fact_origin']);
  assert.equal(g.steps[0].actor, 'bootstrap');
  assert.equal(isColdStart(g), true);

  // 不带 flag：保持旧行为（不预开 step）。
  const cwd2 = tmpDir('fgs-cold2-');
  bootstrapProject({ cwd: cwd2, problemId: 'demo', brief: 'brief' });
  const g2 = new GraphStore(path.dirname(projectGraphPath(cwd2, 'demo'))).load();
  assert.equal(g2.steps.length, 0);
});

test('bootstrap_project --cold-start-step 的 CLI 参数生效且幂等', () => {
  const cwd = tmpDir('fgs-cold3-');
  const script = path.join(repoRoot, 'tools', 'bootstrap_project.mjs');
  const first = spawnSync('node', [script, '--cwd', cwd, '--problem-id', 'demo', '--brief', 'b', '--cold-start-step'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync('node', [script, '--cwd', cwd, '--problem-id', 'demo', '--brief', 'b', '--cold-start-step'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout.trim().split('\n').pop()).status, 'already-seeded');
  assert.equal(new GraphStore(path.dirname(projectGraphPath(cwd, 'demo'))).load().steps.length, 1);
});

test('Finding 计数不把 unfinished 观察 Fact 算进去', () => {
  const g = graph({
    facts: [origin, { id: 'fact_002', title: '中断', content: 'x', kind: 'unfinished' }],
    steps: [normalStep()],
  });
  assert.equal(nextActivity(g).counts.findings, 0);
  assert.match(graphSignature(g), /:n0$/);
});

