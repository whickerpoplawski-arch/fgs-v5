/**
 * v3 独立对抗性验证（第三方 verifier 会话，不共享作者上下文）。
 *
 * 目标：默认「这些修复有问题」，用真实返回值和真实图状态去找反例。
 * 覆盖四条声明：
 *   C1 fgs_commit_step 配额 = 「同一 step 每回合至多一次」+ maxCommitsPerRound，且跨会话硬拒不破；
 *   C2 Decide 轮只读控制面 + 规划类放行、环境/出网/委派类仍拒（从守卫真实返回值出发）；
 *   C3 注入面 mine/unclaimed/可接手 标注与 /fgs/state.counts.openTakeover 同源，且可领性一致；
 *   C4 草稿过期 ≠ 丢弃（补交落盘、内容不丢、不谎报无有效产出），未过期不误走补交。
 *
 * 注意（v4 变更）：本文件在 v3 时代是「只新增」；v4 轮为修复 5 个反例测试
 * （C1-e/C2-d/C4-c/C4-d/C4-e，把断言从「缺陷行为」翻正为「修复后行为」）**改动过这 5 个用例**，
 * 其余内容未动；其中 `C2-d` 已随 F5 回退恢复为 v3 原文（见 V4_CHANGES.md §0）。运行：
 *   node --test tests/verify_v3_adversarial.test.mjs
 */
import test from 'node:test';
// 每次 boot 都会注册一对 SIGTERM/SIGINT 监听（插件用 ctx.effect 持有，假宿主不自动清理），
// 属于测试脚手架噪声，与本验证无关。
process.setMaxListeners(0);;
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { apply as applyPlugin, PLUGIN_GENERATION, BUILD_TAG } from '../index.js';
import { roleContextText } from '../hooks/sync_context.js';
import {
  callRoute,
  ensureActiveProject,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

/* --------------------------------------------------------------- 脚手架 */

// 守卫按工具名判定，未注册的工具在假宿主里会变成 UNKNOWN_TOOL 而绕过守卫，
// 所以必须把每条待测工具都注册成假实现，才能观测到守卫的真实裁定。
const HOST_TOOLS = [
  // 只读控制面（声明允许）
  'get_goal', 'list_agents', 'team_task_list', 'team_task_get', 'job_list', 'job_output',
  // 规划/会话控制面（声明允许）
  'todo_write', 'skill', 'ask_user_question', 'exit_plan_mode', 'create_goal', 'update_goal',
  // cordis 自省（声明允许）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 出站/汇报类（声明允许）
  'send_message', 'present',
  // 环境 / 文件 / 网络 / 委派（必须仍拒）
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'web_search',
  'subagent', 'workflow', 'lsp', 'read_image',
];

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  for (const name of HOST_TOOLS) {
    host.ctx.tools.register({
      name,
      description: `fake ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      async execute() { return { ok: true, text: `${name} RAN` }; },
    });
  }
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-A', cwd);
  host.emit('agent/created', { agent });
  return { host, agent, cwd, services };
}

function spawn(host, id, cwd) {
  const agent = makeFakeAgent(id, cwd);
  host.emit('agent/created', { agent });
  return agent;
}

async function seed(host, agent) {
  const created = ensureActiveProject(host, agent);
  assert.equal(created.kind, 'success', JSON.stringify(created));
  const result = await host.callTool('fgs_seed', { brief: '{"target":"http://x"}' }, agent);
  assert.equal(result.ok, true, result.text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function graphText(cwd, problemId = 'default') {
  return fs.readFileSync(projectGraphPath(cwd, problemId), 'utf8');
}

function countFacts(cwd, problemId = 'default') {
  // GraphStore 的 YAML 会把字符串 id 加引号：`- id: "fact_001"`。
  const m = graphText(cwd, problemId).match(/- id: "fact_/g);
  return m ? m.length : 0;
}

async function openSteps(host, agent, defs) {
  const res = await host.callTool('fgs_commit', {
    operations: defs.map((d) => ({
      op: 'open_step', action: d.action, from: ['fact_origin'], stepId: d.stepId,
      ...(d.priority ? { priority: d.priority } : {}),
    })),
  }, agent);
  assert.equal(res.ok, true, res.text);
  return res;
}

// 注意：注入面 `fgs-graph` 是 systemPrompt **context**（不是 section）——
// 这是本次验证读源码时发现的一个易错点，写测试时必须按 context 找。
function graphSection(host) {
  const ctxDef = host.contexts.find((c) => c?.name === 'fgs-graph');
  assert.ok(ctxDef, 'fgs-graph systemPrompt context 必须已注册');
  return ctxDef;
}

/* ==================================================================== C1 */

test('C1-a：同 step 每回合至多一次；换 step 允许；maxCommitsPerRound 生效且新回合重置', async () => {
  const { host, agent } = boot({ maxCommitsPerRound: 2 });
  await seed(host, agent);
  await openSteps(host, agent, [
    { stepId: 'step_001', action: 's1' },
    { stepId: 'step_002', action: 's2' },
    { stepId: 'step_003', action: 's3' },
  ]);
  host.ctx.setTurn(1);

  const first = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(first.ok, true, first.text);

  // 同一 step 在同回合再收一次 —— 必须拒，且给出可执行出路
  const again = await host.callTool('fgs_commit_step', { stepId: 'step_001' }, agent);
  assert.equal(again.ok, false, `同 step 同回合二次收束必须被拒：${again.text}`);
  assert.match(again.text, /本回合已经收束过/);

  // 换到另一个未收束的 step —— 必须放行（这正是缺陷 I 二阶效应的修复点）
  const second = await host.callTool('fgs_commit_step', { stepId: 'step_002' }, agent);
  assert.equal(second.ok, true, `换 step 应被允许：${second.text}`);

  // 达到 cap=2 后第三个被拒
  const third = await host.callTool('fgs_commit_step', { stepId: 'step_003' }, agent);
  assert.equal(third.ok, false, `cap 应生效：${third.text}`);
  assert.match(third.text, /maxCommitsPerRound/);

  // 新回合重置记账
  host.ctx.setTurn(2);
  const nextRound = await host.callTool('fgs_commit_step', { stepId: 'step_003' }, agent);
  assert.equal(nextRound.ok, true, `新回合必须重置配额：${nextRound.text}`);
});

test('C1-b：跨会话收束他人 step 仍硬拒（原不变量未被 v3 破坏）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: 'A 的 step' }]);
  const bob = spawn(host, 'sess-B', cwd);
  // B 先领一个自己的 step（否则 B 处于 Decide，角色门会先拦，测不到归属校验）
  await openSteps(host, bob, [{ stepId: 'step_002', action: 'B 的 step' }]);
  host.ctx.setTurn(4);

  const denied = await host.callTool('fgs_commit_step', { stepId: 'step_001' }, bob);
  assert.equal(denied.ok, false, `跨会话收束必须被拒：${denied.text}`);
  assert.match(denied.text, /另一个会话|已被/);

  // B 收束自己的 step 仍然可行 —— 证明拒绝是「归属」，不是「commit_step 坏了」
  const own = await host.callTool('fgs_commit_step', { stepId: 'step_002' }, bob);
  assert.equal(own.ok, true, own.text);
});

test('C1-c：同一回合已收束一个后，turn-stopping 兜底仍会收束另一个属于自己的 open step', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 10 });
  await seed(host, agent);
  await openSteps(host, agent, [
    { stepId: 'step_001', action: 's1' },
    { stepId: 'step_002', action: 's2' },
  ]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2); // 让 stepsOpenedRound 属于上一回合，避免命中「刚打开」保护

  const first = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(first.ok, true, first.text);

  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  const after = countFacts(cwd);
  assert.equal(after, before + 1, '已收束别的 step 不应阻止本回合继续收束另一个自己的 open step');
  assert.match(graphText(cwd), /step_002 无有效产出/);
});

test('C1-d：回合收口不得吞掉「本回合刚打开」的 step', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '刚规划的第一步' }]);
  host.ctx.setTurn(1);
  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 1 });
  assert.equal(countFacts(cwd), before, '刚打开的 step 不得被兜底吞成观察 Fact');
  assert.match(graphText(cwd), /state: "open"/);
});

test('C1-e【修复】maxCommitsPerRound 约束 turn-stopping 兜底（同回合实际收束数 ≤ cap）', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 2 });
  await seed(host, agent);
  await openSteps(host, agent, [
    { stepId: 'step_001', action: 's1' },
    { stepId: 'step_002', action: 's2' },
    { stepId: 'step_003', action: 's3' },
  ]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2); // step 属于上一回合，绕过「刚打开」保护

  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  const over = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(over.ok, false, over.text);
  assert.match(over.text, /maxCommitsPerRound/);

  // 旧断言（缺陷行为）：assert.match(text, /step_003 无有效产出/) ——
  // 当时 forceCloseStep 不做 commitsThisRound>=cap 检查，兜底又落一条，本回合实收 3 > cap 2。
  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  const text = graphText(cwd);
  assert.equal(countFacts(cwd), before, '达到 cap 后兜底不得再收束（同回合实收 ≤ cap）');
  assert.doesNotMatch(text, /step_003 无有效产出/, '第 3 个 step 不得被兜底收束');
  assert.match(text, /state: "open"/, 'step_003 必须保持 open，留到下一回合');
});

/* ==================================================================== C2 */

// 声明允许的工具（守卫必须“真放行”：denied===null 且真的执行到工具）
const DECIDE_ALLOWED = [
  'get_goal', 'list_agents', 'team_task_list', 'team_task_get', 'job_list', 'job_output',
  'todo_write', 'skill', 'ask_user_question', 'exit_plan_mode', 'create_goal', 'update_goal',
  'cordis_inspect_list', 'cordis_inspect_query', 'send_message', 'present',
];
// 必须仍被拒的工具（环境/文件/网络/委派）
const DECIDE_DENIED = [
  'bash', 'read', 'write', 'edit', 'glob', 'grep',
  'web_fetch', 'web_search', 'subagent', 'workflow',
];

test('C2-a：从守卫真实返回值逐个枚举允许清单（denied 必须为 null 且工具真的执行）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const observed = {};
  for (const name of DECIDE_ALLOWED) {
    const res = await host.callTool(name, {}, agent);
    observed[name] = { ok: res.ok, denied: res.denied, text: res.text };
    // 守卫放行时 callTool 根本不带 denied 字段（undefined）；被拒时才是字符串。
    assert.ok(res.denied == null, `${name} 在 Decide 轮不应被守卫拒绝：${res.text}`);
    assert.equal(res.ok, true, `${name} 应放行并执行：${res.text}`);
    assert.match(res.text, /RAN/);
  }
  assert.equal(Object.keys(observed).length, DECIDE_ALLOWED.length);
});

test('C2-b：环境/文件/网络/委派类在 Decide 轮仍被守卫拒绝（>=3 个，含 bash）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  let deniedCount = 0;
  for (const name of DECIDE_DENIED) {
    const res = await host.callTool(name, {}, agent);
    assert.equal(res.ok, false, `${name} 必须被拒：${res.text}`);
    assert.equal(typeof res.denied, 'string', `${name} 守卫应返回 denied 字符串`);
    assert.match(res.text, /CONTRACT §4/);
    deniedCount += 1;
  }
  assert.ok(deniedCount >= 3, '至少要覆盖 3 个必须仍被拒的工具');
});

test('C2-c：把 bash 加进 decideAllowTools 也不能放行（deniedEnvTools 优先命中）', async () => {
  const { host, agent } = boot({ decideAllowTools: ['bash'] });
  await seed(host, agent);
  const res = await host.callTool('bash', {}, agent);
  assert.equal(res.ok, false, `bash 即便被显式加入白名单也必须仍拒: ${res.text}`);
  assert.equal(typeof res.denied, 'string');
});

test('C2-d【对抗】委派/网络类不在 deniedEnvTools 里：一旦写进 decideAllowTools 就会被放行', async () => {
  // 源码事实：DEFAULT_DENIED_ENV_TOOLS 只含 bash/文件/lsp/terminal 等；
  // subagent/workflow/web_fetch/web_search 仅靠「不在白名单」被拒。
  // 因此 V3_CHANGES 里「仍然拒：…网络/委派类（deniedEnvTools）」的括号说明并不准确。
  const names = ['subagent', 'workflow', 'web_fetch', 'web_search'];
  const first = boot();
  await seed(first.host, first.agent);
  for (const name of names) {
    const res = await first.host.callTool(name, {}, first.agent);
    assert.equal(res.ok, false, `${name} 默认必须被拒`);
  }
  const second = boot({ decideAllowTools: names });
  await seed(second.host, second.agent);
  for (const name of names) {
    const res = await second.host.callTool(name, {}, second.agent);
    assert.equal(res.ok, true,
      `${name} 一旦被加入 decideAllowTools 就会在 Decide 放行 —— 说明它并不在硬拒清单里`);
  }
});

/* ==================================================================== C3 */

test('C3-a：roleContextText 的标记逻辑（mine / unclaimed / held-by / 可接手）与任务池计数', () => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const graph = {
    facts: [], goals: [],
    steps: [
      { id: 'step_010', state: 'open', priority: 'high', action: 'expired', owner: 'other', claimedAt: iso(40 * 60 * 1000) },
      { id: 'step_011', state: 'open', priority: 'high', action: 'fresh', owner: 'other', claimedAt: iso(1000) },
      { id: 'step_012', state: 'open', priority: 'low', action: 'free', owner: null },
      { id: 'step_013', state: 'open', priority: 'high', action: 'mine', owner: 'me' },
    ],
  };
  const store = { preview: () => '(preview)', toYaml: () => '(yaml)' };
  const text = roleContextText({
    role: 'decide', store, graph, sid: 'me', stepLeaseMs: 30 * 60 * 1000, now,
  });
  assert.match(text, /step_010\[high\]\(可接手\(租约已过期\)\)/);
  assert.match(text, /step_011\[high\]\(held-by=other\)/);
  assert.match(text, /step_012\[low\]\(unclaimed\)/);
  assert.match(text, /step_013\[high\]\(mine\)/);
  assert.match(text, /可接手\(租约已过期\)=1/);
  assert.match(text, /unclaimed=1/);
  assert.match(text, /mine=1/);
});

test('C3-b：注入面标「可接手」的 step，fgs_claim_step 必须真的能领走（租约过期）', async () => {
  const { host, agent, cwd } = boot({ stepLeaseMs: 40 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_020', action: '孤儿' }]);
  const bob = spawn(host, 'sess-B', cwd);
  await sleep(80); // 超过 40ms 租约

  const inject = graphSection(host).text({ scope: bob });
  assert.match(inject, /step_020\[(?:high|normal|low)\]\(可接手\(租约已过期\)\)/, inject);

  const claimed = await host.callTool('fgs_claim_step', { stepId: 'step_020' }, bob);
  assert.equal(claimed.ok, true, `标注可接手的必须真能领走：${claimed.text}`);
  assert.match(graphText(cwd), /owner: "sess-B"/);

  // 与 /fgs/state.counts.openTakeover 同源：此刻已被 B 领走 ⇒ 对 B 视角 takeover=0
  const route = host.routes.find((r) => r.path === '/fgs/state');
  const snap = await callRoute(route, '/fgs/state?sessionId=sess-B');
  assert.equal(snap.json.counts.openTakeover, 0);
});

test('C3-c：注入面标 held-by 的 step，fgs_claim_step 必须领不走（租约内）', async () => {
  const { host, agent, cwd } = boot({ stepLeaseMs: 30 * 60 * 1000 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_021', action: '在租约内' }]);
  const bob = spawn(host, 'sess-B', cwd);

  const inject = graphSection(host).text({ scope: bob });
  assert.match(inject, /step_021\[(?:high|normal|low)\]\(held-by=sess-A\)/, inject);

  const claimed = await host.callTool('fgs_claim_step', { stepId: 'step_021' }, bob);
  assert.equal(claimed.ok, false, `标注 held-by 的不得被领走：${claimed.text}`);
  assert.match(claimed.text, /租约未过期/);
});

test('C3-d：/fgs/state.counts.openTakeover 在租约过期图上的真实取值（与注入面一致）', async () => {
  const { host, agent, cwd } = boot({ stepLeaseMs: 40 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_022', action: '孤儿' }]);
  const bob = spawn(host, 'sess-B', cwd);
  await sleep(80);

  const inject = graphSection(host).text({ scope: bob });
  assert.match(inject, /可接手\(租约已过期\)=1/, inject);

  const route = host.routes.find((r) => r.path === '/fgs/state');
  const snap = await callRoute(route, '/fgs/state?sessionId=sess-B');
  assert.equal(snap.json.counts.openTakeover, 1, JSON.stringify(snap.json.counts));
  assert.equal(snap.json.counts.openOwnedByOthersFresh, 0);
});

/* ==================================================================== C4 */

test('C4-a：过期草稿仍以「(草稿过期后补交)」落盘、内容不丢、且不谎报无有效产出', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_030', action: '探路' }]);
  host.ctx.setTurn(3);

  const drafted = await host.callTool('fgs_submit_fact', {
    title: '关键发现', content: 'curl http://x && flag{keep-me}', findingType: 'info',
  }, agent);
  assert.equal(drafted.ok, true, drafted.text);
  await sleep(40); // 超过 ttl=5ms

  const closed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(closed.ok, true, closed.text);
  const text = graphText(cwd);
  assert.match(text, /flag\{keep-me\}/, '过期草稿内容必须仍然落盘');
  assert.match(text, /草稿过期后补交/, '必须标明补交，不得静默冒充正常产出');
  assert.doesNotMatch(text, /无有效产出/, '不得再谎报「无有效产出」');
  assert.match(text, /findingType: "info"/, 'commit_step 补交路径应保留 findingType');
});

test('C4-b：未过期草稿不得误走补交分支（标题原样、无补交前缀）', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 60 * 60 * 1000 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_031', action: '探路' }]);
  host.ctx.setTurn(3);

  await host.callTool('fgs_submit_fact', { title: '正常产出', content: 'body' }, agent);
  const closed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(closed.ok, true, closed.text);
  const text = graphText(cwd);
  assert.match(text, /正常产出/);
  assert.doesNotMatch(text, /草稿过期后补交/, '未过期不得走补交分支');
  assert.doesNotMatch(text, /无有效产出/);
});

test('C4-c【修复】过期草稿走 turn-stopping 兜底补交时 findingType 被保留', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_032', action: '探路' }]);
  host.ctx.setTurn(3);
  host.ctx.setTurn(4); // 避开「刚打开」保护

  await host.callTool('fgs_submit_fact', {
    title: '漏洞发现', content: 'flag{x}', findingType: 'vuln',
  }, agent);
  await sleep(40);
  // 触发一次 refreshRole → 让草稿真正进入 expiredDrafts（否则 forceClose 会直接吃掉 execDraft）
  await host.callTool('fgs_status', {}, agent);
  host.emit('agent/turn-stopping', { agent, turn: 4 });

  const text = graphText(cwd);
  assert.match(text, /草稿过期后补交/, '兜底路径仍应补交内容');
  assert.match(text, /flag\{x\}/, '内容不得丢');
  // 旧断言（缺陷行为）：assert.doesNotMatch(text, /findingType: vuln/) ——
  // 当时 forceCloseStep 的 submitFactOp 没传 findingType，vuln 静默降级成 info。
  // 注意 YAML 会给字符串加引号，必须按带引号形式断言，否则会空转通过。
  assert.match(text, /findingType: "vuln"/, '兜底补交必须保留 findingType（不得降级成 info）');
});

test('C4-d【修复】连续 6 条过期草稿全部保留、无静默丢失（每条都能补交落盘）', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  // 6 条草稿分别绑定 6 个 step：草稿按提交顺序 push。若仍保留「只留最近 5 条」的截断，
  // 最早那条（草稿0 → step_001）会被挤掉，step_001 收束时就只能谎报「无有效产出」。
  await openSteps(host, agent, Array.from({ length: 6 }, (_, i) => ({
    stepId: `step_00${i + 1}`, action: `探路${i}`,
  })));

  for (let i = 0; i < 6; i += 1) {
    const res = await host.callTool('fgs_submit_fact', {
      title: `草稿${i}`, content: `内容${i}`, stepId: `step_00${i + 1}`,
    }, agent);
    assert.equal(res.ok, true, `submit_fact #${i} 应成功：${res.text}`);
    await sleep(15);
    await host.callTool('fgs_status', {}, agent); // 触发 refreshRole → 过期回收
  }

  // 换回合逐个补交：每个 step 一条，6 条都必须以「(草稿过期后补交)」落盘。
  for (let i = 0; i < 6; i += 1) {
    host.ctx.setTurn(10 + i);
    const closed = await host.callTool('fgs_commit_step', { stepId: `step_00${i + 1}` }, agent);
    assert.equal(closed.ok, true, `收束 step_00${i + 1} 失败：${closed.text}`);
  }

  const text = graphText(cwd);
  // 旧断言（缺陷行为）：assert.doesNotMatch(text, /草稿0/) ——
  // 当时 expireStaleDraft 把 expiredDrafts 截断到最近 5 条，草稿0 被静默丢弃，
  // 而每次 submit_fact 都返回 ok:true。
  for (let i = 0; i < 6; i += 1) {
    assert.match(text, new RegExp(`草稿${i}`), `过期草稿${i} 必须保留（不得静默丢失）`);
  }
  assert.doesNotMatch(text, /无有效产出/, '6 条草稿都在，不应有任何 step 谎报无有效产出');
});

test('C4-e：本文件跑在 v4（gen 14）上——代次自证', () => {
  assert.equal(PLUGIN_GENERATION, 16);
  assert.match(BUILD_TAG, /commit-per-step/);
  assert.match(BUILD_TAG, /orphan-visibility/);
  assert.match(BUILD_TAG, /readonly-decide-tools/);
});
