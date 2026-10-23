/** v5.1 编排器：并行 Execute、预认领、两阶段收束、预告知预算。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore } from '../controller/index.js';
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

function seededWorkdir({ steps = 0, coldStart = false } = {}) {
  const cwd = tmpDir('fgs-loop51-');
  bootstrapProject({ cwd, problemId: 'demo', brief: '{"target":"http://10.0.0.8:8080"}', coldStartStep: coldStart });
  if (steps > 0) {
    const root = path.dirname(projectGraphPath(cwd, 'demo'));
    const store = new GraphStore(root);
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

test('并行 Execute：两个 slot 同时跑不同 step，且起进程前已由编排器认领', () => {
  const cwd = seededWorkdir({ steps: 2 });
  const scenario = {
    step_001: { kind: 'submit_fact', step: 'step_001', title: 'A 产出', outcome: 'committed' },
    step_002: { kind: 'submit_fact', step: 'step_002', title: 'B 产出', outcome: 'committed' },
    default: { kind: 'noop' },
  };
  const result = runLoop(cwd, scenario, [
    '--parallel', '2', '--max-activities', '2', '--activity-timeout-sec', '30',
  ], { FAKE_RECORD: '1', FAKE_DUMP: 'seen.jsonl' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const ledger = readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl'));
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger.map((row) => row.activity), ['execute', 'execute']);
  assert.deepEqual(new Set(ledger.map((row) => row.stepId)), new Set(['step_001', 'step_002']));
  assert.notEqual(ledger[0].runId, ledger[1].runId);

  // 图：两条 step 都已收束，各有一条 Fact。
  const graph = new GraphStore(projectRoot(cwd)).load();
  assert.equal(graph.steps.filter((step) => step.state === 'done').length, 2);
  assert.equal(graph.facts.length, 3);

  // 预认领：子进程看到的 owner 必须是自己 runId（不是 null，也不是别的 run）。
  const seen = readJsonl(path.join(cwd, 'seen.jsonl'));
  for (const row of seen.filter((item) => item.step)) {
    assert.equal(row.owner, row.run, `起进程前必须已认领: ${JSON.stringify(row)}`);
    assert.equal(row.suppress, '1', '首轮要抑制信号兜底（留给收束轮）');
    assert.equal(row.budgetMs, '30000', '预告知预算必须透传');
  }
});

test('Decide 串行插入：decide-every=2 时连续两次 Execute 后插一次 Decide', () => {
  const cwd = seededWorkdir({ steps: 4 });
  const scenario = {
    step_001: { kind: 'submit_fact', step: 'step_001', title: 'A', outcome: 'committed' },
    step_002: { kind: 'submit_fact', step: 'step_002', title: 'B', outcome: 'committed' },
    step_003: { kind: 'submit_fact', step: 'step_003', title: 'C', outcome: 'committed' },
    step_004: { kind: 'submit_fact', step: 'step_004', title: 'D', outcome: 'committed' },
    default: { kind: 'noop', outcome: 'no-commit' },
  };
  const result = runLoop(cwd, scenario, [
    '--parallel', '1', '--max-activities', '5', '--decide-every', '2', '--activity-timeout-sec', '30',
  ], { FAKE_RECORD: '1' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const kinds = readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl')).map((row) => row.activity);
  assert.deepEqual(kinds.slice(0, 3), ['execute', 'execute', 'decide'],
    `前三个活动应是 execute,execute,decide，实际 ${kinds.join(',')}`);
});

test('两阶段收束：超时后用同一 session 续跑，收束轮落 Fact 收尾（不再 release）', () => {
  const cwd = seededWorkdir({ steps: 1 });
  const scenario = {
    step_001: {
      kind: 'noop', sleep: 30, outcome: 'no-commit', sessionId: 'sess-fake-1',
    },
    conclude: { kind: 'submit_fact', step: 'step_001', title: '收束结论', outcome: 'committed' },
    default: { kind: 'noop' },
  };
  const result = runLoop(cwd, scenario, [
    '--parallel', '1', '--max-activities', '3',
    '--activity-timeout-sec', '1', '--conclude-timeout-sec', '20',
  ], { FAKE_RECORD: '1', FAKE_DUMP: 'seen.jsonl' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

  const ledger = readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl'));
  const first = ledger[0];
  assert.equal(first.activity, 'execute');
  assert.equal(first.timedOut, true);
  assert.equal(first.conclude?.ok, true, `应收束成功: ${JSON.stringify(first.conclude)}`);
  assert.equal(first.conclude?.pluginOutcome, 'committed');
  assert.equal(first.released, null, '收束成功就不该再 release');

  const graph = new GraphStore(projectRoot(cwd)).load();
  assert.equal(graph.steps[0].state, 'done');
  assert.equal(graph.facts.length, 2);
  assert.ok(graph.facts.some((fact) => fact.title === '收束结论'));

  const seen = readJsonl(path.join(cwd, 'seen.jsonl'));
  const concludeRun = seen.find((row) => row.conclude === '1');
  assert.ok(concludeRun, '必须有收束轮进程');
  assert.equal(concludeRun.activity, 'execute', '收束轮仍是同一活动类型（同一 session 续跑）');
  assert.equal(concludeRun.suppress, '1');
});

test('收束失败（无 sessionId）→ 直接 release，追加未完成 Fact', () => {
  const cwd = seededWorkdir({ steps: 1 });
  const scenario = { step_001: { kind: 'noop', sleep: 30 }, default: { kind: 'noop' } };
  const result = runLoop(cwd, scenario, [
    '--parallel', '1', '--max-activities', '1',
    '--activity-timeout-sec', '1', '--conclude-timeout-sec', '20',
  ], { FAKE_RECORD: '0' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const first = readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl'))[0];
  assert.equal(first.timedOut, true);
  assert.equal(first.conclude, null, '没有 sessionId 不该起收束轮');
  assert.equal(first.released?.released, true);

  const graph = new GraphStore(projectRoot(cwd)).load();
  assert.equal(graph.steps[0].state, 'open');
  assert.equal(graph.steps[0].owner ?? null, null);
  assert.ok(graph.facts.some((fact) => fact.kind === 'unfinished'));
});

test('非零退出不救援（Cairn：只有超时才 conclude）', () => {
  const cwd = seededWorkdir({ steps: 1 });
  const scenario = { step_001: { kind: 'noop', outcome: 'no-commit', sessionId: 's' }, default: { kind: 'noop' } };
  const result = runLoop(cwd, scenario, [
    '--parallel', '1', '--max-activities', '2', '--activity-timeout-sec', '30',
  ], { FAKE_RECORD: '1', FAKE_EXIT: '1' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const first = readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl'))[0];
  assert.equal(first.exitCode, 1);
  assert.equal(first.conclude, null);
  assert.equal(first.released?.released, true);
});

test('冷启动快路径：第一轮直接是 bootstrap，不先跑 Decide', () => {
  const cwd = seededWorkdir({ coldStart: true });
  const scenario = {
    step_001: { kind: 'submit_fact', step: 'step_001', title: '直冲未果', outcome: 'committed' },
    default: { kind: 'noop' },
  };
  const result = runLoop(cwd, scenario, [
    '--parallel', '1', '--max-activities', '1', '--activity-timeout-sec', '30',
  ], { FAKE_RECORD: '1', FAKE_DUMP: 'seen.jsonl' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const ledger = readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl'));
  assert.equal(ledger[0].activity, 'bootstrap');
  const seen = readJsonl(path.join(cwd, 'seen.jsonl'))[0];
  assert.equal(seen.activity, 'bootstrap');
});
