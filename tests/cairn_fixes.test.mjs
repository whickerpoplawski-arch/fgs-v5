/**
 * Cairn 核心思想驱动的回归测试（对应真实跑分中实测到的缺陷）。
 *
 * 依据：
 *  - v1《无径之径》 : 黑板是唯一外化记忆；Dispatcher 是协议唯一写入者；Intent 认领有超时释放
 *  - v2《Cairn_Y》  : FGS 图只追加；Decide/Execute 是**独立运行过程**、不是固定角色；
 *                     两者都是注入不同 Tool/Prompt 的 Agent Loop，无跨会话记忆
 *
 * 每条用例都对应一个"审计用哪招打进来，就用哪招锁回去"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import { GraphStore } from '../controller/index.js';
import {
  ensureActiveProject,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

/** 直接读图（用于 append-only 计数断言）。 */
function storeOf(cwd) {
  return new GraphStore(path.dirname(projectGraphPath(cwd)), {});
}

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  for (const name of ['bash', 'read', 'web_fetch', 'web_search', 'subagent', 'workflow', 'todo_write', 'skill']) {
    host.ctx.tools.register({
      name,
      description: `fake ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      async execute() {
        return { ok: true, text: `${name} RAN` };
      },
    });
  }
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-a', cwd);
  host.emit('agent/created', { agent });
  return { host, agent, cwd };
}

async function seed(host, agent) {
  const created = ensureActiveProject(host, agent);
  assert.equal(created.kind, 'success', JSON.stringify(created));
  const result = await host.callTool('fgs_seed', { brief: '{"target":"http://x"}' }, agent);
  assert.equal(result.ok, true, result.text);
}

/** 同 workspace、不同会话（模拟 DSH 的 subagent / 另一个 worker）。 */
function secondAgent(host, cwd, id = 'sess-b') {
  const b = makeFakeAgent(id, cwd);
  host.emit('agent/created', { agent: b });
  return b;
}

/* ------------------------------------------------------------------ D1 */

test('D1：一个会话不得收束另一个会话持有的 open step（不写回别人的 Step）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'A 的探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(2);
  // A 第一次调用即由图派发并认领该 step（owner = sess-a）
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'A 的发现', content: 'x' }, agent)).ok, true);

  const graphText = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(graphText, /owner:\s*"?sess-a"?/, '认领必须落到图上（图是唯一外化记忆）');

  // B：同 workspace 的另一个会话，不得抢写 A 的 step
  const b = secondAgent(host, cwd);
  host.ctx.setTurn(3);
  const denied = await host.callTool('fgs_submit_fact', { title: 'B 抢写', content: 'y' }, b);
  assert.equal(denied.ok, false, 'B 不得收束 A 的 step');
  assert.match(denied.text, /角色隔离|已被另一个会话/);

  // 图上不能出现 B 的 fact（否则就是 6/6 跨会话错位绑定的复现）
  assert.doesNotMatch(fs.readFileSync(projectGraphPath(cwd), 'utf8'), /B 抢写/);
});

/* ------------------------------------------------------------------ D2 */

test('D2：别的会话把本会话的 step 收束后，本会话必须立即回到 Decide（角色不得缓存）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(2);
  // 此时本会话是 Execute：环境工具放行
  assert.equal((await host.callTool('bash', {}, agent)).ok, true, 'Execute 轮应放行环境工具');

  // 模拟「另一个会话/进程把该 step 收束掉」——直接改图，等同别的 writer 落盘。
  // 这正是真实跑分里发生的事：step 归因于本会话开的，却被别的会话 commit_step 收掉。
  const p = projectGraphPath(cwd);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('state: "open"', 'state: "done"'));

  // 旧实现：run.role 仍是缓存的 execute ⇒ bash 放行、fgs_open_step 被拒 = 死锁
  //         且 §4「Decide 禁止环境工具」静默失效
  // 新实现：每次由 (图, 本会话) 现算 ⇒ 回 Decide，环境工具必须被拒
  const denied = await host.callTool('bash', {}, agent);
  assert.equal(denied.ok, false, 'step 已关闭 ⇒ 必须回 Decide；环境工具应被拒');
  assert.match(denied.text, /Decide|禁止/);

  // 而且不得卡死：回到 Decide 后可以规划新 step（旧实现这里会被角色门拒掉）
  const reopened = await host.callTool('fgs_open_step', { action: '新方向', from: ['fact_origin'] }, agent);
  assert.equal(reopened.ok, true, `回到 Decide 必须能继续规划: ${reopened.text}`);
});

/* ------------------------------------------------------------------ D3 */

test('D3：同回合「先收束、再开新 step、并立刻收束」不得留下孤儿 step 与僵尸草稿', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  host.ctx.setTurn(5);

  // 第一步：开 + 收束（消耗本回合的第一次收束）
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '第一步', from: ['fact_origin'] }],
  }, agent);
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'a', content: 'c' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);

  // 同一回合内再开一个 step 并立刻收束（旧实现：第二次 commit_step 一律被拒 ⇒
  // step_002 变孤儿 + 草稿永久滞留，实测在 /fgs/state 里挂了 1.5 小时）
  assert.equal((await host.callTool('fgs_open_step', { action: '第二步', from: ['fact_origin'] }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit', {}, agent)).ok, true);
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'b', content: 'c' }, agent)).ok, true);
  const second = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(second.ok, true, `本回合刚开的 step 应可在本回合收束: ${second.text}`);

  const graphText = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.doesNotMatch(graphText, /state: "open"/, '不得留下孤儿 open step');
  assert.match(graphText, /"b"/, '第二段发现必须真的落盘，而不是丢在草稿里');
  // 草稿必须被清空（无僵尸草稿）
  assert.ok(!(await host.callTool('fgs_status', {}, agent)).text.includes('草稿:'), '不应残留草稿');
});

/* ------------------------------------------------------------------ D5 */

test('D5：fgs_status 显式拒绝未知参数（不得静默吞掉垃圾入参后返回摘要）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const bad = await host.callTool('fgs_status', { action: 'bad ref probe', from: ['fact_999'] }, agent);
  assert.equal(bad.ok, false, '垃圾入参必须被显式拒绝');
  assert.match(bad.text, /不接受任何参数/);
  // 无参仍正常
  assert.equal((await host.callTool('fgs_status', {}, agent)).ok, true);
});

/* ------------------------------------------------------------------ v2 */

test('v2：open step 必须显示认领状态（谁在推进 / 是否可接手）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  const text = (await host.callTool('fgs_status', {}, agent)).text;
  assert.match(text, /\(mine\)/, '本会话持有的 step 应标注 mine');
  assert.match(text, /goals=/, '应同时报 goals 计数（Sub Goal 是一等公民）');
});

/* ------------------------------------------------- Sub Goal（v2 一等公民）*/

test('v2：Sub Goal 可动态增删，且「图只追加」——删除即标记 dropped，不删历史', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);

  assert.equal((await host.callTool('fgs_add_subgoal', { criterion: '拿到入口权限' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit', {}, agent)).ok, true);
  let g = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(g, /goal_sub_001/);
  assert.match(g, /kind: "sub"/);
  assert.match(g, /parentId: "goal_final"/);
  assert.match(g, /拿到入口权限/);

  assert.equal((await host.callTool('fgs_drop_subgoal', {
    goalId: 'goal_sub_001', reason: '已被最终目标覆盖',
  }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit', {}, agent)).ok, true);
  g = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(g, /goal_sub_001/, 'Sub Goal 节点不得被删除（图只追加）');
  assert.match(g, /state: "dropped"/);
  assert.match(g, /已被最终目标覆盖/);
  // 父 goal 不能被 Sub Goal 的增删改动
  assert.match(g, /kind: "final"/);
});

test('v2：drop_subgoal 必须给 reason；不能删 goal_final', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_add_subgoal', { criterion: 'x' }, agent);
  await host.callTool('fgs_commit', {}, agent);
  const noReason = await host.callTool('fgs_drop_subgoal', { goalId: 'goal_sub_001' }, agent);
  assert.equal(noReason.ok, false, '缺 reason 应在入草稿时就被拒（fail fast）');
  // 删 goal_final：preflight 阶段拿不到图、判不了 kind，所以能进草稿；
  // 但**落盘时**必须被 Controller 拒 —— 这才是有意义的硬约束。
  const wrongTarget = await host.callTool('fgs_drop_subgoal', { goalId: 'goal_final', reason: 'r' }, agent);
  assert.equal(wrongTarget.ok, true, 'preflight 阶段无法判断目标 kind，允许进草稿');
  const wrongCommit = await host.callTool('fgs_commit', {}, agent);
  assert.equal(wrongCommit.ok, false, '落盘时必须拒绝删 goal_final');
  assert.match(wrongCommit.text, /只能删 Sub Goal/);
});

/* ------------------------------------------------------- Finding（v2 新增）*/

test('v2：Finding = 搜索过程的结构化产物（带类型的 Fact），且类型可动态定义', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '找漏洞', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(2);
  assert.equal((await host.callTool('fgs_submit_fact', {
    title: '发现 SQLi', content: '注入点 /login 的 username', findingType: 'vuln',
  }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);

  const g = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(g, /findingType: "vuln"/, 'Finding 必须落到图上');
  const st = (await host.callTool('fgs_status', {}, agent)).text;
  assert.match(st, /findings=1/);
  assert.match(st, /finding fact_001 \[vuln\]/);
});

test('v2：findingTypes 白名单可动态定义；不在白名单内的类型被拒', async () => {
  const { host, agent } = boot({ findingTypes: ['vuln', 'misconfig'] });
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '找漏洞', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(2);
  const bad = await host.callTool('fgs_submit_fact', {
    title: 'h', content: 'c', findingType: 'not-in-whitelist',
  }, agent);
  assert.equal(bad.ok, false, '白名单外的 findingType 必须拒写');
  assert.match(bad.text, /findingType 非法/);
  assert.equal((await host.callTool('fgs_submit_fact', {
    title: 'ok', content: 'c', findingType: 'vuln',
  }, agent)).ok, true);
});

/* ------------------------------------------------ append-only 不变量 */

test('v2：图只追加——drop_step / drop_subgoal 都不减少节点数', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  const store = storeOf(cwd);
  const count = () => {
    const g = store.load();
    return { f: g.facts.length, go: g.goals.length, st: g.steps.length };
  };
  const c0 = count();

  await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: 'A', from: ['fact_origin'] },
      { op: 'open_step', action: 'B', from: ['fact_origin'] },
    ],
  }, agent);
  const c1 = count();
  assert.equal(c1.st, c0.st + 2);

  // 本会话已认领 A；显式 drop 掉 B（B 仍是 open）
  assert.equal((await host.callTool('fgs_drop_step', {
    stepId: 'step_002', reason: '死胡同',
  }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit', {}, agent)).ok, true);
  const c2 = count();
  assert.equal(c2.st, c1.st, 'drop_step 不得删除节点');

  await host.callTool('fgs_add_subgoal', { criterion: '阶段性目标' }, agent);
  await host.callTool('fgs_commit', {}, agent);
  const c3 = count();
  assert.equal(c3.go, c2.go + 1);
  await host.callTool('fgs_drop_subgoal', { goalId: 'goal_sub_001', reason: '不需要了' }, agent);
  await host.callTool('fgs_commit', {}, agent);
  const c4 = count();
  assert.equal(c4.go, c3.go, 'drop_subgoal 不得删除节点');
  assert.equal(c4.f, c0.f, '全程没有 fact 被删除');
});

/* ------------------------------------------- 显式派发（v2：Step↔Run 绑定）*/

test('v2：接手别人的 step 必须显式 fgs_claim_step（不隐式认领）', async () => {
  const { host, agent, cwd } = boot({ stepLeaseMs: 0 }); // 关掉租约 ⇒ 任何人可接手
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);

  // B：图上有 open step，但**没有派发给它** ⇒ 必须是 Decide（不得自动变成 Execute）
  const b = secondAgent(host, cwd);
  host.ctx.setTurn(2);
  const asDecide = (await host.callTool('fgs_status', {}, b)).text;
  assert.match(asDecide, /Decide/, 'B 未持有 step ⇒ 必须仍是 Decide');

  // 但 B 可以显式认领，认领后进入 Execute
  assert.equal((await host.callTool('fgs_claim_step', { stepId: 'step_001' }, b)).ok, true);
  const after = (await host.callTool('fgs_status', {}, b)).text;
  assert.match(after, /Execute/, '认领后 B 应进入 Execute');
  const g = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(g, /owner:\s*"?sess-b"?/, '认领必须把 owner 写进图（可审计的派发边）');
});

/* --------------------------------- v2：Decide 必须能在有 open step 时工作 */

test('v2：图上存在 open step 时，仍必须能执行 Decide 职责（否则图会僵死）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '第一步', from: ['fact_origin'] }],
  }, agent);
  // 此刻本会话持有 step_001（Execute）。但它仍需要能补规划 —— 这正是 v2
  // 「图有变化时触发 Decide」的语义。开第二个 step 是 Decide 的职责。
  const second = await host.callTool('fgs_open_step', { action: '第二步', from: ['fact_origin'] }, agent);
  assert.equal(second.ok, true, `持有 step 时开新 step 应可达（旧实现会被角色门拒）: ${second.text}`);
});
