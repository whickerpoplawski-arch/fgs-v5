/**
 * 校验 / schema UX + Decide 提示微切片。
 * flag 任一条即可、preview 拒未知参数、非法 stepId 明确拒收、
 * commit 枚举补齐 SubGoal/claim、认领真失败 isError。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Controller, GraphStore } from '../controller/index.js';
import {
  openStepOp,
  satisfyGoalOp,
  seedOriginOp,
  submitFactOp,
} from '../controller/ops.js';
import { makeLocalFlagVerify, makeRegexFlagVerify, makeVerifyHook } from '../hooks/flag_verify.js';
import { apply as applyPlugin, BUILD_TAG, PLUGIN_GENERATION } from '../index.js';
import { load as loadYaml } from '../yaml.js';
import {
  ensureActiveProject,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

const DECIDE_NEXT = '先 fgs_open_step + fgs_commit，再执行。';

function newCtl(verifyHook) {
  const store = new GraphStore(tmpDir());
  const ctl = new Controller(store, { verifyHook });
  ctl.commit(ctl.apply(seedOriginOp({ title: '题目信息:', content: 'origin only' })));
  ctl.commit(ctl.apply(openStepOp({ action: 'a', from: ['fact_origin'] })));
  ctl.commit(ctl.apply(submitFactOp({
    title: 'flag', content: 'got flag{abcd}', producedBy: 'step_001',
  })));
  ctl.commit(ctl.apply(openStepOp({ action: 'b', from: ['fact_001'] })));
  ctl.commit(ctl.apply(submitFactOp({
    title: 'notes', content: 'no flag here', producedBy: 'step_002',
  })));
  return ctl;
}

function satisfy(ctl, satisfiedBy) {
  return ctl.apply(satisfyGoalOp({
    goalId: 'goal_final', reason: '证据已齐', satisfiedBy,
  }));
}

test('satisfy_goal 默认 any：一条含 flag、一条没有，仍通过', () => {
  const ctl = newCtl(makeRegexFlagVerify());
  const graph = satisfy(ctl, ['fact_001', 'fact_002']);
  assert.deepEqual(graph.goals[0].satisfiedBy, ['fact_001', 'fact_002']);
});

test('satisfy_goal any：全无 flag 时拒绝，并点名已匹配 / 缺 flag 的 id', () => {
  const ctl = newCtl(makeRegexFlagVerify());
  assert.throws(
    () => satisfy(ctl, ['fact_origin', 'fact_002']),
    /已匹配: 无.*未匹配 flag 正则: fact_origin, fact_002/,
  );
});

test('satisfy_goal all：混合证据拒绝，并同时列出已匹配与缺 flag', () => {
  const ctl = newCtl(makeRegexFlagVerify(undefined, { satisfyFlagMode: 'all' }));
  assert.throws(
    () => satisfy(ctl, ['fact_001', 'fact_002']),
    /已匹配: fact_001.*未匹配 flag 正则: fact_002/,
  );
});

test('local 模式同样默认 any；不存在的 fact 仍拒绝', () => {
  const ctl = newCtl(makeLocalFlagVerify('flag{abcd}'));
  assert.equal(satisfy(ctl, ['fact_001', 'fact_002']).goals[0].satisfiedAt != null, true);
  assert.throws(() => satisfy(ctl, ['fact_001', 'fact_999']), /不存在 fact: fact_999/);
});

test('makeVerifyHook 把 satisfyFlagMode 传进 regex（all 才逐条）', () => {
  const anyHook = makeVerifyHook({});
  const allHook = makeVerifyHook({ satisfyFlagMode: 'all' });
  const graph = {
    facts: [
      { id: 'fact_001', title: 't', content: 'flag{abcd}' },
      { id: 'fact_002', title: 't', content: 'plain' },
    ],
  };
  const op = { satisfiedBy: ['fact_001', 'fact_002'] };
  assert.equal(anyHook(graph, op), null);
  assert.match(allHook(graph, op), /已匹配: fact_001/);
  assert.equal(makeVerifyHook({ satisfyFlagMode: 'nope' })(graph, op), null);
});

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  for (const name of ['bash', 'web_fetch']) {
    host.ctx.tools.register({
      name,
      description: `fake ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      async execute() { return { ok: true, text: `${name} RAN` }; },
    });
  }
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-a', cwd);
  host.emit('agent/created', { agent });
  return { host, agent, cwd };
}

async function seed(host, agent, brief = 'origin only') {
  const created = ensureActiveProject(host, agent);
  assert.equal(created.kind, 'success', JSON.stringify(created));
  const result = await host.callTool('fgs_seed', { brief }, agent);
  assert.equal(result.ok, true, result.text);
}

test('fgs_preview 拒绝未知参数；无参仍成功', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const bad = await host.callTool('fgs_preview', { action: 'noop', noop: true }, agent);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /不接受任何参数/);
  assert.match(bad.text, /action/);
  assert.equal((await host.callTool('fgs_preview', {}, agent)).ok, true);
});

test('非法 stepId（step_recon）一次说清格式，示例 step_001，且不落盘', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  const bad = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'recon', from: ['fact_origin'], stepId: 'step_recon' }],
  }, agent);
  assert.equal(bad.ok, false, bad.text);
  assert.match(bad.text, /step_recon/);
  assert.match(bad.text, /step_001/);
  assert.match(bad.text, /勿把动作名当 id/);
  const graph = loadYaml(fs.readFileSync(projectGraphPath(cwd), 'utf8'));
  assert.equal(graph.steps.length, 0);
});

test('fgs_commit operations 可批量 add/drop_subgoal 与 claim_step', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  const commit = host.tools.get('fgs_commit');
  const opsEnum = commit.parameters.properties.operations.items.properties.op.enum;
  for (const name of ['add_subgoal', 'drop_subgoal', 'claim_step']) {
    assert.ok(opsEnum.includes(name), `schema 缺 ${name}`);
  }
  const schemaFile = JSON.parse(fs.readFileSync(new URL('../schemas/tools/decide.tools.json', import.meta.url), 'utf8'));
  const fileEnum = schemaFile.find((t) => t.function.name === 'fgs_commit')
    .function.parameters.properties.operations.items.properties.op.enum;
  assert.deepEqual(fileEnum, opsEnum);

  const opened = await host.callTool('fgs_commit', {
    claimOpened: false,
    operations: [
      { op: 'add_subgoal', criterion: '第一枚 flag' },
      { op: 'add_subgoal', criterion: '第二枚 flag' },
      { op: 'open_step', action: '尝试直接满足两枚 flag', from: ['fact_origin'] },
    ],
  }, agent);
  assert.equal(opened.ok, true, opened.text);
  let graph = loadYaml(fs.readFileSync(projectGraphPath(cwd), 'utf8'));
  const subs = graph.goals.filter((g) => g.kind === 'sub');
  assert.ok(subs.length >= 1, '双 flag 轨迹应出现 subgoal');
  assert.equal(subs.length, 2);
  assert.equal(graph.steps[0].owner ?? null, null);

  const follow = await host.callTool('fgs_commit', {
    operations: [
      { op: 'drop_subgoal', goalId: 'goal_sub_002', reason: '并入第一枚' },
      { op: 'claim_step', stepId: 'step_001', owner: agent.id },
    ],
  }, agent);
  assert.equal(follow.ok, true, follow.text);
  graph = loadYaml(fs.readFileSync(projectGraphPath(cwd), 'utf8'));
  assert.equal(graph.goals.find((g) => g.id === 'goal_sub_002').state, 'dropped');
  assert.equal(graph.steps[0].owner, agent.id);
});

test('认领真正失败时 isError=true（不存在 / 租约内）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  const missing = await host.callTool('fgs_claim_step', { stepId: 'step_999' }, agent);
  assert.equal(missing.ok, false);
  assert.equal(missing.isError, true);
  assert.match(missing.text, /无法认领/);
  assert.match(missing.content[0].text, /^Error: /);

  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'held', from: ['fact_origin'], stepId: 'step_001' }],
  }, agent);
  const bob = makeFakeAgent('sess-b', cwd);
  host.emit('agent/created', { agent: bob });
  const blocked = await host.callTool('fgs_claim_step', { stepId: 'step_001' }, bob);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /租约未过期/);
  const graph = loadYaml(fs.readFileSync(projectGraphPath(cwd), 'utf8'));
  assert.equal(graph.steps[0].owner, 'sess-a');
});

test('Decide 调环境工具时，拒绝文案带固定的下一步', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, false);
  assert.match(bash.text, /禁止环境执行工具/);
  assert.ok(bash.text.endsWith(DECIDE_NEXT), bash.text);
  const web = await host.callTool('web_fetch', {}, agent);
  assert.equal(web.ok, false);
  assert.ok(web.text.endsWith(DECIDE_NEXT), web.text);
});

test('插件默认 any：satisfiedBy 里只要一条 fact 含 flag 就能 satisfy', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '取 flag', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(2);
  const submitted = await host.callTool('fgs_submit_fact', {
    title: '提交', content: 'flag{abcd} 已确认',
  }, agent);
  assert.equal(submitted.ok, true, submitted.text);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  const staged = await host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final', reason: 'fact_001 含 flag', satisfiedBy: ['fact_001', 'fact_origin'],
  }, agent);
  assert.equal(staged.ok, true, staged.text);
  const committed = await host.callTool('fgs_commit', {}, agent);
  assert.equal(committed.ok, true, committed.text);
  const graph = loadYaml(fs.readFileSync(projectGraphPath(cwd), 'utf8'));
  assert.ok(graph.goals[0].satisfiedAt);

  const strict = boot({ satisfyFlagMode: 'all' });
  await seed(strict.host, strict.agent);
  await strict.host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '取 flag', from: ['fact_origin'] }],
  }, strict.agent);
  strict.host.ctx.setTurn(2);
  await strict.host.callTool('fgs_submit_fact', {
    title: '提交', content: 'flag{abcd} 已确认',
  }, strict.agent);
  await strict.host.callTool('fgs_commit_step', {}, strict.agent);
  await strict.host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final', reason: '混了无 flag 的 origin', satisfiedBy: ['fact_001', 'fact_origin'],
  }, strict.agent);
  const denied = await strict.host.callTool('fgs_commit', {}, strict.agent);
  assert.equal(denied.ok, false, denied.text);
  assert.match(denied.text, /已匹配: fact_001/);
  assert.match(denied.text, /fact_origin/);
});

test('注入的 fgs-graph 含 Decide 冷启动与 Execute findingType', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const provider = host.contexts.find((item) => item.name === 'fgs-graph').text;
  const decideText = provider({ scope: agent });
  assert.match(decideText, /优先开一条尝试直接满足 goal_final/);
  assert.match(decideText, /fgs_add_subgoal/);
  assert.match(decideText, /不调用环境工具/);
  assert.doesNotMatch(decideText, /过程发现用 findingType/);

  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '收束一条事实', from: ['fact_origin'] }],
  }, agent);
  const executeText = provider({ scope: agent });
  assert.match(executeText, /Execute/);
  assert.match(executeText, /过程发现用 findingType/);
  assert.match(executeText, /不要把 Finding 当成 goal_final/);
  assert.doesNotMatch(executeText, /优先开一条尝试直接满足 goal_final/);
});

test('提示词：冷启动直冲 Goal，SubGoal/Finding 各一句，且不写打法清单', () => {
  const decide = fs.readFileSync(new URL('../prompts/decide.system.md', import.meta.url), 'utf8');
  const execute = fs.readFileSync(new URL('../prompts/execute.system.md', import.meta.url), 'utf8');
  const decideLines = decide.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1);
  assert.ok(decideLines.length <= 24, `decide.system.md 超过行数预算: ${decideLines.length}`);
  assert.match(decide, /fact_origin/);
  assert.match(decide, /优先开一条尝试直接满足 goal_final/);
  assert.match(decide, /fgs_open_step/);
  assert.match(decide, /fgs_add_subgoal/);
  assert.doesNotMatch(decide, /开多条相邻但互补的侦察方向快速起量/);
  assert.doesNotMatch(decide, /SQL|上传|内网|webshell/i);
  assert.match(execute, /过程发现用 findingType/);
  assert.match(execute, /不要把 Finding 当成 goal_final/);
  assert.doesNotMatch(execute, /SQL|上传|内网|webshell/i);
  assert.equal(PLUGIN_GENERATION, 16);
  assert.match(BUILD_TAG, /^16\+/);
  assert.match(BUILD_TAG, /schema-ux/);
});
