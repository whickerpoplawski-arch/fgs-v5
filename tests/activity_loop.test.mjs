/**
 * 活动编排器（contest/activity_loop.py）：用假 worker 跑通
 * decide → execute → decide → done 的完整闭环，以及 defer/超时/台账。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GraphStore } from '../controller/index.js';
import { bootstrapProject } from '../tools/bootstrap_project.mjs';
import { projectGraphPath, tmpDir } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loop = path.join(repoRoot, 'contest', 'activity_loop.py');
const fakeWorker = path.join(repoRoot, 'tests', 'fixtures', 'fake_worker.py');
const driver = path.join(repoRoot, 'contest', 'driver.py');

function runPython(args, env = {}) {
  return spawnSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function seededWorkdir(scenario) {
  const cwd = tmpDir('fgs-loop-');
  bootstrapProject({ cwd, problemId: 'demo', brief: '{"target":"http://10.0.0.8:8080"}' });
  const scenarioFile = path.join(cwd, 'scenario.json');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  return { cwd, scenarioFile };
}

function runLoop(cwd, scenarioFile, extra = {}) {
  const args = [
    loop,
    '--cwd', cwd,
    '--problem-id', 'demo',
    '--worker-cmd', `python3 ${fakeWorker}`,
    '--max-activities', '8',
    '--budget-sec', '60',
    '--activity-timeout-sec', '30',
  ];
  return runPython(args, {
    FAKE_SCENARIO: JSON.stringify(JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))),
    ...extra,
  });
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('活动编排：decide → execute → decide → done，每轮一个独立进程一条台账', () => {
  const { cwd, scenarioFile } = seededWorkdir([
    { kind: 'open_step', action: '侦察 Web' },
    { kind: 'submit_fact', step: 'step_001', title: '侦察结果' },
    { kind: 'satisfy_goal', by: 'fact_origin' },
  ]);
  const result = runLoop(cwd, scenarioFile);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(summary.ok, true);
  assert.equal(summary.outcome, 'done');
  assert.equal(summary.activities, 3);

  const ledger = readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl'));
  assert.deepEqual(ledger.map((row) => row.activity), ['decide', 'execute', 'decide']);
  assert.equal(ledger[1].stepId, 'step_001');
  assert.equal(ledger[0].exitCode, 0);
  assert.equal(ledger[0].timedOut, false);
  // 每轮一个独立 runId（= 一次活动 = 一个干净上下文）
  assert.equal(new Set(ledger.map((row) => row.runId)).size, 3);

  const marker = JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'orchestrator-exit.json'), 'utf8'));
  assert.equal(marker.outcome, 'done');
  assert.match(marker.signature, /^f2:s1:o0/);
});

test('活动编排：图没变 → 不空转 Decide，直接 deferred 并写 meta，供 supervisor 退役', () => {
  const { cwd, scenarioFile } = seededWorkdir([{ kind: 'noop' }]);
  const result = runLoop(cwd, scenarioFile);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(summary.outcome, 'deferred');
  assert.equal(summary.activities, 1, '第二轮发现图没变就该停，不该无限 Decide');

  const meta = JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'projects', 'demo', 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'deferred');
  assert.match(meta.deferredReason, /未变化|无进展/);
});

test('活动编排：单个活动超时被终止，但整题继续（失败不级联）', () => {
  // 第一个 Decide 先把 step 打开、然后挂住 → 超时被杀；图已经变了，
  // 编排器必须继续派发下一轮（execute），而不是把整道题判死。
  const { cwd, scenarioFile } = seededWorkdir([
    { kind: 'open_step', sleep: 3 },
    { kind: 'noop' },
    { kind: 'noop' },
  ]);
  const args = [
    loop, '--cwd', cwd, '--problem-id', 'demo',
    '--worker-cmd', `python3 ${fakeWorker}`,
    '--max-activities', '4',
    '--budget-sec', '60',
    '--activity-timeout-sec', '0.5',
  ];
  const result = runPython(args, {
    FAKE_SCENARIO: JSON.stringify(JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))),
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const ledger = readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl'));
  assert.ok(ledger.length >= 2, `超时后应继续下一轮，实际 ${ledger.length}`);
  assert.equal(ledger[0].timedOut, true);
  assert.equal(ledger[0].activity, 'decide');
  assert.equal(ledger[1].activity, 'execute', '超时不应吞掉已经打开的 step');
  assert.equal(ledger[1].stepId, 'step_001');
});

test('活动编排：--dry-run 只打印命令，不起子进程、不写台账', () => {
  const { cwd } = seededWorkdir([{ kind: 'noop' }]);
  const result = runPython([
    loop, '--cwd', cwd, '--problem-id', 'demo',
    '--worker-cmd', 'python3 x.py', '--dry-run', '--max-activities', '1',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /"dryRun": true/);
  assert.equal(fs.existsSync(path.join(cwd, '.fgs', 'orchestrator.jsonl')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'fake_calls.txt')), false);
});

test('driver：默认只在真的拉起 harness 时启用活动编排；自定义 worker 不被接管', () => {
  const script = [
    'import json, os',
    'from pathlib import Path',
    'import driver',
    'ws = Path("/tmp/ws")',
    'os.environ["CONTEST_DSH_LAUNCH"] = "1"',
    'os.environ.pop("CONTEST_ACTIVITY_RUNS", None)',
    'os.environ.pop("CONTEST_WORKER_CMD", None)',
    'argv = driver.activity_loop_argv(ws, "p-1")',
    'os.environ["CONTEST_WORKER_CMD"] = "python3 /tmp/fake-worker.py"',
    'custom = driver.activity_loop_argv(ws, "p-1")',
    'os.environ.pop("CONTEST_WORKER_CMD", None)',
    'os.environ["CONTEST_ACTIVITY_RUNS"] = "0"',
    'off = driver.activity_loop_argv(ws, "p-1")',
    'print(json.dumps({"on": argv, "custom": custom, "off": off}))',
  ].join('\n');
  // 造一个假的 dsh：让 shutil.which 找得到，且不真的启动 harness。
  const bin = tmpDir('fgs-fake-dsh-');
  const fakeDsh = path.join(bin, 'dsh');
  fs.writeFileSync(fakeDsh, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeDsh, 0o755);
  const result = runPython(['-c', script], {
    PYTHONPATH: path.join(repoRoot, 'contest'),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.on), 'harness 可用时应启用活动编排');
  assert.match(payload.on.join(' '), /activity_loop\.py/);
  assert.match(payload.on.join(' '), /--dsh-bin/);
  assert.equal(payload.custom, null, 'CONTEST_WORKER_CMD 是完整 worker 替换，不该被活动编排接管');
  assert.equal(payload.off, null, '显式关闭时退回单进程长会话');
});

test('driver：stub 模式记录 activityRuns=false，命令形状保持旧样', () => {
  const cwd = tmpDir('fgs-driver-');
  const fixture = path.join(cwd, 'challenges.json');
  fs.writeFileSync(fixture, JSON.stringify({
    challenges: [{
      unique_code: 'A-1',
      description: '示例题面',
      is_completed: false,
      container_addr: ['http://10.0.0.8:8080'],
    }],
  }));
  const workdir = path.join(cwd, 'work');
  const result = runPython([driver], {
    BENCHMARK_TOKEN: 't',
    BENCHMARK_BASE_URL: 'http://benchmark.invalid',
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: workdir,
    CONTEST_DSH_LAUNCH: '0',
    CONTEST_ACTIVITY_RUNS: '1',
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const marker = JSON.parse(fs.readFileSync(path.join(workdir, 'a-1', '.fgs', 'dsh-launch.json'), 'utf8'));
  assert.equal(marker.stub, true);
  assert.equal(marker.activityRuns, false, '缺 harness 时不能声称用活动编排');
});

test('活动编排：死 run 留下的认领会被回收（owner=runId，无需等租约到期）', () => {
  const { cwd, scenarioFile } = seededWorkdir([{ kind: 'noop' }]);
  // 图里预置一个「上个活动被 SIGKILL 后残留」的认领，claimedAt 是很久以前（租约已过期）。
  const store = new GraphStore(path.dirname(projectGraphPath(cwd, 'demo')));
  const graph = store.load();
  graph.steps.push({
    id: 'step_001',
    action: '残留 step',
    from: ['fact_origin'],
    actor: 'agent',
    priority: 'normal',
    state: 'open',
    createdAt: '2026-10-11T09:01:00.000Z',
    owner: 'demo-01-execute',
    claimedAt: '2026-10-11T09:02:00.000Z',
  });
  store.save(graph);
  const before = graph.facts.length;

  const args = [
    loop, '--cwd', cwd, '--problem-id', 'demo',
    '--worker-cmd', `python3 ${fakeWorker}`,
    '--max-activities', '2',
    '--budget-sec', '60',
    '--activity-timeout-sec', '30',
  ];
  const result = runPython(args, {
    FAKE_SCENARIO: JSON.stringify(JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))),
    FAKE_EXIT: '1', // 活动「崩了」：没落盘就退出
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const ledger = readJsonl(path.join(cwd, '.fgs', 'orchestrator.jsonl'));
  assert.equal(ledger[0].activity, 'execute');
  assert.equal(ledger[0].runId, 'demo-01-execute');
  assert.equal(ledger[0].released.released, true, `应回收死 run 的认领: ${JSON.stringify(ledger[0])}`);
  const after = store.load();
  const step = after.steps.find((s) => s.id === 'step_001');
  assert.equal(step.owner ?? null, null, '认领必须回到任务池');
  assert.equal(after.facts.length, before + 1, '回收时留下未完成 Fact');
});
