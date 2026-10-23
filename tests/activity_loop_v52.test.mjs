/** v5.2 编排器：Decide 与 Execute 并发（Cairn_Y 完整档）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore } from '../controller/index.js';
import { nextActivity } from '../controller/activity.js';
import { openStepOp } from '../controller/ops.js';
import { bootstrapProject } from '../tools/bootstrap_project.mjs';
import { projectGraphPath, tmpDir } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loop = path.join(repoRoot, 'contest', 'activity_loop.py');
const fakeWorker = path.join(repoRoot, 'tests', 'fixtures', 'fake_worker.py');

function runPython(args, env = {}) {
  return spawnSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function seededWorkdir({ steps = 0 } = {}) {
  const cwd = tmpDir('fgs-loop52-');
  bootstrapProject({ cwd, problemId: 'demo', brief: '{"target":"http://10.0.0.8:8080"}', coldStartStep: false });
  if (steps > 0) {
    const store = new GraphStore(projectRoot(cwd));
    const controller = new Controller(store);
    controller.transact((graph) => {
      let g = graph;
      for (let i = 1; i <= steps; i += 1) {
        g = controller.apply(openStepOp({
          action: `侦察 ${i}`,
          from: ['fact_origin'],
          stepId: `step_${String(i).padStart(3, '0')}`,
        }), g);
      }
      return g;
    });
  }
  return cwd;
}

function runLoop(cwd, scenario, extra = [], env = {}) {
  return runPython([
    loop,
    '--cwd', cwd,
    '--problem-id', 'demo',
    '--worker-cmd', `python3 ${fakeWorker}`,
    '--budget-sec', '60',
    '--activity-timeout-sec', '30',
    ...extra,
  ], {
    FAKE_SCENARIO: JSON.stringify(scenario),
    ...env,
  });
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function projectRoot(cwd) {
  return path.dirname(projectGraphPath(cwd, 'demo'));
}

function ledgerOf(cwd) {
  return readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl'));
}

function summaryOf(result) {
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('并发重叠：2 个 Execute 在跑时派发 Decide，台账记 startedWhileExecutes=2', () => {
  const cwd = seededWorkdir({ steps: 4 });
  const scenario = {
    // step_001 快速落一条 Finding → 在 step_002/003 还跑着时触发 Decide。
    step_001: { kind: 'submit_fact', step: 'step_001', title: '快速发现', findingType: 'vuln', outcome: 'committed', sleep: 0.3 },
    step_002: { kind: 'submit_fact', step: 'step_002', title: 'A 产出', outcome: 'committed', sleep: 3 },
    step_003: { kind: 'submit_fact', step: 'step_003', title: 'B 产出', outcome: 'committed', sleep: 3 },
    step_004: { kind: 'submit_fact', step: 'step_004', title: 'C 产出', outcome: 'committed', sleep: 0.1 },
    decide: { kind: 'noop', sleep: 2, outcome: 'no-commit' },
    default: { kind: 'noop' },
  };
  const result = runLoop(cwd, scenario, [
    '--parallel', '3', '--max-activities', '5', '--decide-every', '0',
    '--concurrent-decide', '--decide-timeout-sec', '10', '--rebase-mode', 'append',
  ], { FAKE_RECORD: '1', FAKE_DUMP: 'seen.jsonl' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const ledger = ledgerOf(cwd);
  const decides = ledger.filter((row) => row.activity === 'decide');
  assert.equal(decides.length, 1, `并发窗口内只该派一个 Decide，实际 ${JSON.stringify(decides)}`);
  assert.equal(decides[0].startedWhileExecutes, 2, '派发 Decide 时应有 2 个 Execute 在跑');
  assert.equal(decides[0].concurrentWithExecutes, true);
  assert.equal(decides[0].timedOut, false);
  assert.equal(decides[0].exitCode, 0);

  // 两个长 Execute 都真落盘了（并发不等于牺牲执行）。
  const longRows = ledger.filter((row) => ['step_002', 'step_003'].includes(row.stepId));
  assert.equal(longRows.length, 2);
  for (const row of longRows) {
    assert.equal(row.activity, 'execute');
    assert.equal(row.pluginOutcome, 'committed', `Execute 应 committed: ${JSON.stringify(row)}`);
    assert.equal(row.exitCode, 0);
  }
  const graph = new GraphStore(projectRoot(cwd)).load();
  assert.equal(graph.steps.filter((step) => step.state === 'done').length, 4, '四条 step 都应收束');
  assert.equal(graph.facts.length, 5, 'origin + 4 条产出');

  // Decide 的 env：独立预算 + rebase 只注入给 Decide，Execute 不注入。
  const seen = readJsonl(path.join(cwd, 'seen.jsonl'));
  const decideRun = seen.find((row) => row.activity === 'decide');
  assert.ok(decideRun, '必须真的起了 Decide 进程');
  assert.equal(decideRun.rebase, '1');
  assert.equal(decideRun.rebaseMode, 'append');
  assert.equal(decideRun.budgetMs, '10000', 'Decide 用自己的 --decide-timeout-sec 预算');
  for (const row of seen.filter((item) => item.activity === 'execute')) {
    assert.equal(row.rebase, null, 'Execute 不能继承 Decide 的 rebase 开关');
    assert.equal(row.budgetMs, '30000', 'Execute 仍用 --activity-timeout-sec 预算');
  }
});

test('互斥：Decide 在跑期间 pick 反复给出 decide，也只会有一个 Decide 进程', () => {
  const cwd = seededWorkdir();
  const scenario = {
    decide: { kind: 'noop', sleep: 2, outcome: 'no-commit' },
    default: { kind: 'noop' },
  };
  const result = runLoop(cwd, scenario, [
    '--concurrent-decide', '--decide-timeout-sec', '10', '--max-decides', '5', '--max-activities', '6',
  ], { FAKE_RECORD: '1' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const decides = ledgerOf(cwd).filter((row) => row.activity === 'decide');
  assert.equal(decides.length, 1, `同一时刻只允许一个 Decide，实际 ${JSON.stringify(decides)}`);
  assert.equal(summaryOf(result).outcome, 'deferred', '图没变 → 不空转，直接 defer');
});

test('Decide 超时：独立墙钟杀掉，图零改动；并行 Execute 不受影响', () => {
  const cwd = seededWorkdir({ steps: 3 });
  const scenario = {
    step_001: { kind: 'submit_fact', step: 'step_001', title: '快速', outcome: 'committed', sleep: 0.3 },
    step_002: { kind: 'submit_fact', step: 'step_002', title: '慢 A', outcome: 'committed', sleep: 2 },
    step_003: { kind: 'submit_fact', step: 'step_003', title: '慢 B', outcome: 'committed', sleep: 2 },
    // record=false：模拟 Decide 超时被杀、没来得及落插件台账。
    decide: { kind: 'noop', sleep: 5, outcome: 'no-commit', record: false },
    default: { kind: 'noop' },
  };
  const result = runLoop(cwd, scenario, [
    '--parallel', '2', '--max-activities', '6', '--decide-every', '1',
    '--concurrent-decide', '--decide-timeout-sec', '1',
  ], { FAKE_RECORD: '1' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const ledger = ledgerOf(cwd);
  const decide = ledger.find((row) => row.activity === 'decide');
  assert.ok(decide, '必须有 Decide 台账行');
  assert.equal(decide.timedOut, true, 'Decide 应被独立墙钟杀掉');
  assert.equal(decide.pluginOutcome, null, '超时被杀 → 没有插件结果');
  assert.notEqual(decide.exitCode, 0);

  // 两个 Execute 照常收束。
  const executes = ledger.filter((row) => row.activity === 'execute');
  assert.equal(executes.length, 3);
  for (const row of executes) assert.equal(row.pluginOutcome, 'committed', JSON.stringify(row));
  const graph = new GraphStore(projectRoot(cwd)).load();
  assert.equal(graph.steps.filter((step) => step.state === 'done').length, 3);
});

test('基线语义：Decide 期间 Execute 落的 Finding，结束后立刻再触发一次 Decide', () => {
  const cwd = seededWorkdir({ steps: 4 });
  const scenario = {
    step_001: { kind: 'submit_fact', step: 'step_001', title: '起手', outcome: 'committed', sleep: 0.1 },
    step_002: { kind: 'submit_fact', step: 'step_002', title: '规划期新发现', findingType: 'vuln', outcome: 'committed', sleep: 0.1 },
    step_003: { kind: 'submit_fact', step: 'step_003', title: '长活', outcome: 'committed', sleep: 3 },
    step_004: { kind: 'submit_fact', step: 'step_004', title: '收尾', outcome: 'committed', sleep: 0.1 },
    decide: { kind: 'noop', sleep: 1, outcome: 'no-commit' },
    default: { kind: 'noop' },
  };
  const result = runLoop(cwd, scenario, [
    '--parallel', '1', '--max-activities', '9', '--decide-every', '1',
    '--concurrent-decide', '--decide-timeout-sec', '10',
  ], { FAKE_RECORD: '1' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const ledger = ledgerOf(cwd);
  const decideRows = ledger.filter((row) => row.activity === 'decide');
  assert.ok(decideRows.length >= 2, `findings 基线应让 Decide 结束时立刻再规划: ${JSON.stringify(ledger)}`);
  // 第二次 Decide 紧跟在第一次之后（中间没有 Execute 台账行）——不靠 sleep，靠基线语义。
  const first = ledger.indexOf(decideRows[0]);
  assert.equal(ledger[first + 1].activity, 'decide',
    `两次 Decide 应连续: ${JSON.stringify(ledger.map((row) => [row.activity, row.stepId]))}`);
  // 派发时基线取的是「第一次 Decide 派发时」的 counts（0），所以期间新落的 Finding 仍在基线之上。
  assert.ok(decideRows[1].startedWhileExecutes >= 1, '第二次 Decide 应能看见还有 Execute 在跑');
});

test('开关关闭：不传 --concurrent-decide 时退回 v5.1 串行 Decide（活动序列不变）', () => {
  const cwd = seededWorkdir({ steps: 4 });
  const scenario = {
    step_001: { kind: 'submit_fact', step: 'step_001', title: 'A', outcome: 'committed' },
    step_002: { kind: 'submit_fact', step: 'step_002', title: 'B', outcome: 'committed' },
    step_003: { kind: 'submit_fact', step: 'step_003', title: 'C', outcome: 'committed' },
    step_004: { kind: 'submit_fact', step: 'step_004', title: 'D', outcome: 'committed' },
    default: { kind: 'noop', outcome: 'no-commit' },
  };
  const result = runLoop(cwd, scenario, [
    '--parallel', '1', '--max-activities', '5', '--decide-every', '2',
  ], { FAKE_RECORD: '1' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const ledger = ledgerOf(cwd);
  assert.deepEqual(ledger.map((row) => row.activity).slice(0, 3), ['execute', 'execute', 'decide'],
    `v5.1 序列应是 execute,execute,decide，实际 ${ledger.map((row) => row.activity).join(',')}`);
  // v5.1 台账没有并发字段（Decide 一定在 slot 清空后才跑）。
  for (const row of ledger) {
    assert.equal(row.startedWhileExecutes, undefined);
    assert.equal(row.concurrentWithExecutes, undefined);
  }
});

test('--max-decides 1：第二次 Decide 被抑制，剩余 step 照常执行完', () => {
  const cwd = seededWorkdir({ steps: 5 });
  const scenario = {};
  for (let i = 1; i <= 5; i += 1) {
    const step = `step_${String(i).padStart(3, '0')}`;
    scenario[step] = { kind: 'submit_fact', step, title: `产出 ${i}`, outcome: 'committed', sleep: 0.1 };
  }
  scenario.decide = { kind: 'noop', sleep: 0.3, outcome: 'no-commit' };
  scenario.default = { kind: 'noop' };
  const base = [
    '--parallel', '1', '--max-activities', '12', '--decide-every', '1',
    '--concurrent-decide', '--decide-timeout-sec', '10',
  ];
  const result = runLoop(cwd, scenario, [...base, '--max-decides', '1'], { FAKE_RECORD: '1' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const ledger = ledgerOf(cwd);
  assert.equal(ledger.filter((row) => row.activity === 'decide').length, 1, 'Decide 次数上限必须生效');
  assert.equal(ledger.filter((row) => row.activity === 'execute').length, 5, '超限后只执行，不收尾');
  assert.equal(summaryOf(result).outcome, 'deferred', '规划预算耗尽 = 无法再推进，按 defer 语义退役');
  assert.match(String(summaryOf(result).reason), /max-decides/);
  const graph = new GraphStore(projectRoot(cwd)).load();
  assert.equal(graph.steps.filter((step) => step.state === 'done').length, 5);

  // 对照：同场景放开上限 → Decide 会被反复触发（说明上一条的「只跑一次」确有抑制）。
  const cwd2 = seededWorkdir({ steps: 5 });
  const uncapped = runLoop(cwd2, scenario, [...base, '--max-decides', '5'], { FAKE_RECORD: '1' });
  assert.equal(uncapped.status, 0, `${uncapped.stderr}\n${uncapped.stdout}`);
  assert.ok(ledgerOf(cwd2).filter((row) => row.activity === 'decide').length >= 2,
    '不设上限时应至少跑两次 Decide');
});

test('选择器：decide 分支带 executeCandidate（编排器据此边规划边执行）', () => {
  const graph = {
    facts: [
      { id: 'fact_origin', title: '题目信息', content: 'target' },
      { id: 'fact_002', title: '新发现', content: 'x', findingType: 'vuln' },
    ],
    steps: [{ id: 'step_001', action: '侦察', from: ['fact_origin'], actor: 'agent', priority: 'normal', state: 'open' }],
    goals: [{ id: 'goal_final', kind: 'final', criterion: 'flag' }],
  };
  const due = nextActivity(graph, { findingsAtLastDecide: 0, executesSinceDecide: 0, decideEvery: 3 });
  assert.equal(due.kind, 'decide');
  assert.equal(due.executeCandidate, 'step_001', 'Decide 与 Execute 并发时编排器需要候选 step');

  const runnable = nextActivity(graph, { findingsAtLastDecide: 1, executesSinceDecide: 0, decideEvery: 3 });
  assert.equal(runnable.kind, 'execute');
  assert.equal(runnable.executeCandidate, undefined, 'execute 分支不带候选字段');

  const empty = nextActivity({ ...graph, steps: [] });
  assert.equal(empty.kind, 'decide');
  assert.equal(empty.executeCandidate, undefined, '队列空时的 Decide 没有候选');
});
