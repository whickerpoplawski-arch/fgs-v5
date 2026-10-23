/**
 * 磁盘预种：无 LLM 时写出可 auto-attach 的图，重复调用幂等。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { apply as applyPlugin } from '../index.js';
import { GraphStore } from '../controller/index.js';
import { ProjectRegistry } from '../controller/projects.js';
import { BootstrapError, bootstrapProject } from '../tools/bootstrap_project.mjs';
import { makeFakeAgent, makeFakeHost, tmpDir, wireServices } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'tools', 'bootstrap_project.mjs');

function bootAt(cwd) {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex' });
  const agent = makeFakeAgent('sess-bootstrap', cwd);
  host.emit('agent/created', { agent });
  return { host, agent };
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('bootstrap 无 LLM 写出 fact_origin + goal_final，第二次不改图', () => {
  const cwd = tmpDir('fgs-boot-');
  const first = bootstrapProject({
    cwd,
    problemId: 'A-10',
    brief: '端口题\n只做本题',
    target: 'http://10.0.0.8:8080',
    criterion: '取得有效 flag 并 submit correct=true',
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'seeded');
  assert.equal(first.problemId, 'a-10');
  assert.equal(first.activeProblemId, 'a-10');

  const indexPath = path.join(cwd, '.fgs', 'competition.json');
  const projectDir = path.join(cwd, '.fgs', 'projects', 'a-10');
  const graphPath = path.join(projectDir, 'graph.yaml');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(index.activeProblemId, 'a-10');
  assert.equal(index.problems[0].id, 'a-10');
  assert.equal(index.problems[0].state, 'seeded');
  assert.equal(fs.existsSync(path.join(projectDir, 'workspace')), true);
  assert.equal(fs.existsSync(path.join(projectDir, 'graph.json')), true);
  const meta = JSON.parse(fs.readFileSync(path.join(projectDir, 'meta.json'), 'utf8'));
  assert.equal(meta.state, 'seeded');
  assert.equal(meta.id, 'a-10');

  const store = new GraphStore(projectDir);
  const graph = store.load();
  assert.equal(graph.facts.length, 1);
  assert.equal(graph.facts[0].id, 'fact_origin');
  assert.equal(graph.facts[0].title, '题目信息:');
  const origin = JSON.parse(graph.facts[0].content);
  assert.equal(origin.target, 'http://10.0.0.8:8080');
  assert.match(origin.brief, /端口题/);
  assert.equal(graph.goals.length, 1);
  assert.equal(graph.goals[0].id, 'goal_final');
  assert.equal(graph.goals[0].kind, 'final');
  assert.match(graph.goals[0].criterion, /correct=true/);
  assert.equal(graph.steps.length, 0);

  const yaml = fs.readFileSync(graphPath);
  const json = fs.readFileSync(path.join(projectDir, 'graph.json'));
  const second = bootstrapProject({
    cwd,
    problemId: 'a-10',
    brief: '另一份题面，不得覆盖',
    target: 'http://should-not-replace',
    criterion: '不得换判据',
  });
  assert.equal(second.status, 'already-seeded');
  assert.equal(second.problemId, 'a-10');
  assert.deepEqual(fs.readFileSync(graphPath), yaml);
  assert.deepEqual(fs.readFileSync(path.join(projectDir, 'graph.json')), json);
  const again = store.load();
  assert.equal(again.facts[0].content, graph.facts[0].content);
  assert.equal(again.goals[0].criterion, graph.goals[0].criterion);
});

test('预种之后新会话不调 fgs_project 也能 open_step，再预种不吃掉已提交的 step', async () => {
  const cwd = tmpDir('fgs-boot-attach-');
  bootstrapProject({
    cwd,
    problemId: 'b-02',
    brief: '已在磁盘',
    criterion: '取得有效 flag 并 submit correct=true',
  });

  const { host, agent } = bootAt(cwd);
  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(status.ok, true, status.text);
  assert.doesNotMatch(status.text, /没有活动 Project/);
  assert.doesNotMatch(status.text, /尚未种题/);
  assert.match(status.text, /b-02/);

  const opened = await host.callTool(
    'fgs_open_step',
    { action: '直冲 goal', from: ['fact_origin'] },
    agent,
  );
  assert.equal(opened.ok, true, opened.text);
  const committed = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '直冲 goal', from: ['fact_origin'] }],
  }, agent);
  assert.equal(committed.ok, true, committed.text);

  const graphPath = path.join(cwd, '.fgs', 'projects', 'b-02', 'graph.yaml');
  const before = fs.readFileSync(graphPath);
  assert.match(before.toString('utf8'), /step_001/);
  const third = bootstrapProject({ cwd, problemId: 'b-02', brief: '再次' });
  assert.equal(third.status, 'already-seeded');
  assert.deepEqual(fs.readFileSync(graphPath), before);
});

test('已建但未种的 Project 会补 seed；残缺图拒绝覆盖', () => {
  const cwd = tmpDir('fgs-boot-fill-');
  const registry = new ProjectRegistry(path.join(cwd, '.fgs'));
  registry.create({ id: 'empty-1', title: 'empty' });
  const filled = bootstrapProject({ cwd, problemId: 'empty-1', brief: '补种' });
  assert.equal(filled.status, 'seeded');
  const graph = new GraphStore(registry.projectRoot('empty-1')).load();
  assert.equal(graph.facts[0].id, 'fact_origin');
  assert.equal(graph.facts[0].content, '补种');
  assert.equal(graph.goals[0].id, 'goal_final');

  const broken = tmpDir('fgs-boot-partial-');
  const brokenReg = new ProjectRegistry(path.join(broken, '.fgs'));
  brokenReg.create({ id: 'partial', title: 'partial' });
  fs.writeFileSync(path.join(brokenReg.projectRoot('partial'), 'graph.yaml'), [
    'facts:',
    '- id: fact_origin',
    '  title: "题目信息:"',
    '  content: "only-origin"',
    'goals: []',
    'steps: []',
    '',
  ].join('\n'));
  assert.throws(
    () => bootstrapProject({ cwd: broken, problemId: 'partial', brief: '不要覆盖' }),
    /goal_final/,
  );
  const text = fs.readFileSync(path.join(brokenReg.projectRoot('partial'), 'graph.yaml'), 'utf8');
  assert.match(text, /only-origin/);
  assert.doesNotMatch(text, /goal_final:/);
});

test('非法 id、缺 brief、cwd 不存在都失败', () => {
  const cwd = tmpDir('fgs-boot-bad-');
  assert.throws(() => bootstrapProject({ cwd, problemId: '   ', brief: 'x' }), BootstrapError);
  assert.throws(() => bootstrapProject({ cwd, problemId: '', brief: 'x' }), /problemId 为空/);
  assert.throws(() => bootstrapProject({ cwd, problemId: 'ok-id' }), /缺 brief/);
  assert.throws(
    () => bootstrapProject({ cwd: path.join(cwd, 'missing'), problemId: 'ok-id', brief: 'x' }),
    /cwd 不存在/,
  );
  assert.equal(fs.existsSync(path.join(cwd, '.fgs')), false);
});

test('cwd 不可写则失败', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, () => {
  const parent = tmpDir('fgs-boot-ro-');
  const cwd = path.join(parent, 'locked');
  fs.mkdirSync(cwd);
  fs.chmodSync(cwd, 0o555);
  try {
    assert.throws(
      () => bootstrapProject({ cwd, problemId: 'a-1', brief: 'x' }),
      /不可写/,
    );
  } finally {
    fs.chmodSync(cwd, 0o755);
  }
});

test('CLI：种题 exit 0，重复幂等，缺 id exit 1', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fgs-boot-cli-'));
  const first = runCli([
    '--cwd', cwd,
    '--problem-id', 'cli-1',
    '--brief', 'cli brief',
    '--target', 'http://10.1.1.1',
  ], { FGS_PROBLEM_ID: '', FGS_BRIEF: '', FGS_TARGET: '' });
  assert.equal(first.status, 0, first.stderr);
  const payload = JSON.parse(first.stdout);
  assert.equal(payload.status, 'seeded');
  assert.equal(payload.problemId, 'cli-1');
  const graphPath = path.join(cwd, '.fgs', 'projects', 'cli-1', 'graph.yaml');
  const bytes = fs.readFileSync(graphPath);

  const second = runCli(['--cwd', cwd, '--problem-id', 'cli-1', '--brief', 'other']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'already-seeded');
  assert.deepEqual(fs.readFileSync(graphPath), bytes);

  const bad = runCli(['--cwd', cwd], { FGS_PROBLEM_ID: '', FGS_BRIEF: '' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /problemId/);
  assert.equal(JSON.parse(bad.stdout).ok, false);
});
