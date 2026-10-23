/**
 * v4「最小修复」聚焦回归测试：每个缺陷至少一条直接断言。
 *
 *   F1   Decide 白名单放行 structured_output（出站通道），bash 仍硬拒；
 *   F2   turn-stopping 兜底补交过期草稿时保留 findingType；
 *   F3   连续 6 条过期草稿不再截断到最近 5 条（最早的也能补交）；
 *   F4   maxCommitsPerRound 约束兜底收束，但 0 次收束（含 cap=0）时仍落观察 Fact；
 *   F5   已回退：网络/委派类是否被拒完全取决于白名单（v4 不把它们加入硬拒清单）；
 *   F6a  顺序要求按角色分述：Decide 用 fgs_commit 落盘、Execute 用 fgs_submit_fact。
 *
 * 风格照抄 tests/verify_v3_adversarial.test.mjs 的 boot()/seed() 假宿主用法。
 * 运行：node --test tests/fix_v4_minimal.test.mjs
 */
import test from 'node:test';
// 每次 boot 都会注册一对 SIGTERM/SIGINT 监听（插件用 ctx.effect 持有，假宿主不自动清理），
// 属于测试脚手架噪声，与本验证无关。
process.setMaxListeners(0);
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { apply as applyPlugin } from '../index.js';
import {
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
  'send_message', 'present', 'structured_output',
  'bash', 'read', 'web_fetch', 'web_search', 'subagent', 'workflow',
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
  return { host, agent, cwd };
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
  const m = graphText(cwd, problemId).match(/- id: "fact_/g);
  return m ? m.length : 0;
}

async function openSteps(host, agent, defs) {
  const res = await host.callTool('fgs_commit', {
    operations: defs.map((d) => ({
      op: 'open_step', action: d.action, from: ['fact_origin'], stepId: d.stepId,
    })),
  }, agent);
  assert.equal(res.ok, true, res.text);
  return res;
}

/* ==================================================================== F1 */

test('F1：Decide 轮 structured_output 放行（出站通道），bash 仍被硬拒', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  // 本会话没有任何 open step 的 owner ⇒ 角色 = Decide
  const egress = await host.callTool('structured_output', {}, agent);
  assert.ok(egress.denied == null, `structured_output 不应被 Decide 守卫拒绝：${egress.text}`);
  assert.equal(egress.ok, true, egress.text);
  assert.match(egress.text, /RAN/);
  // 防回归：bash 仍是环境执行工具，Decide 必须拒。
  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, false, `bash 在 Decide 仍必须被拒：${bash.text}`);
  assert.equal(typeof bash.denied, 'string');
});

/* ==================================================================== F2 */

test('F2：turn-stopping 兜底补交过期草稿时保留 findingType', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '探路' }]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2); // 避开「刚打开」保护

  await host.callTool('fgs_submit_fact', {
    title: '漏洞发现', content: 'flag{y}', findingType: 'vuln',
  }, agent);
  await sleep(40);
  await host.callTool('fgs_status', {}, agent); // refreshRole → 草稿进入 expiredDrafts
  host.emit('agent/turn-stopping', { agent, turn: 2 });

  const text = graphText(cwd);
  assert.match(text, /草稿过期后补交/, '兜底路径仍应补交内容');
  assert.match(text, /flag\{y\}/, '内容不得丢');
  assert.match(text, /findingType: "vuln"/,
    '兜底补交必须保留 findingType（不得静默降级成 info）');
});

/* ==================================================================== F3 */

test('F3：连续 6 条过期草稿全部保留（不再截断到最近 5 条）', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  // 6 条草稿分别绑定 6 个 step：截断「只留最近 5 条」必然先丢最早那条（草稿0 → step_001）。
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

  // 只补交最早那条：它能落盘就证明最早的过期草稿没有被静默丢弃。
  host.ctx.setTurn(10);
  const closed = await host.callTool('fgs_commit_step', { stepId: 'step_001' }, agent);
  assert.equal(closed.ok, true, closed.text);
  const text = graphText(cwd);
  assert.match(text, /草稿0/, '最早的过期草稿必须仍在（F3 前会被截断丢弃）');
  assert.doesNotMatch(text, /无有效产出/, '有草稿可补交时不得谎报无有效产出');
});

/* ==================================================================== F4 */

test('F4：cap 约束兜底收束，但「本回合 0 次收束」时仍必须落观察 Fact', async () => {
  // (a) cap=2 且本回合已收束 2 个 ⇒ 兜底不得再收第 3 个（同回合实收 ≤ cap）
  const a = boot({ maxCommitsPerRound: 2 });
  await seed(a.host, a.agent);
  await openSteps(a.host, a.agent, [
    { stepId: 'step_001', action: 's1' },
    { stepId: 'step_002', action: 's2' },
    { stepId: 'step_003', action: 's3' },
  ]);
  a.host.ctx.setTurn(1);
  a.host.ctx.setTurn(2); // step 属于上一回合，绕过「刚打开」保护
  assert.equal((await a.host.callTool('fgs_commit_step', {}, a.agent)).ok, true);
  assert.equal((await a.host.callTool('fgs_commit_step', {}, a.agent)).ok, true);

  const before = countFacts(a.cwd);
  a.host.emit('agent/turn-stopping', { agent: a.agent, turn: 2 });
  assert.equal(countFacts(a.cwd), before, '达到 cap 后兜底不得再收束');
  assert.match(graphText(a.cwd), /state: "open"/, 'step_003 必须保持 open');
  assert.doesNotMatch(graphText(a.cwd), /step_003 无有效产出/);

  // (b) 本回合一次都没收束 ⇒ 兜底仍必须落一条观察 Fact（cap 不能把兜底整体关掉）
  const b = boot({ maxCommitsPerRound: 2 });
  await seed(b.host, b.agent);
  await openSteps(b.host, b.agent, [{ stepId: 'step_001', action: '没人做的 step' }]);
  b.host.ctx.setTurn(1);
  b.host.ctx.setTurn(2);
  b.host.emit('agent/turn-stopping', { agent: b.agent, turn: 2 });
  assert.match(graphText(b.cwd), /无有效产出（观察）/,
    '0 次收束时回合收口仍必须落观察 Fact');
});

/* ==================================================================== F5 */

test('F5（已回退）：网络/委派类只受白名单约束——默认拒，写进 decideAllowTools 即放行', async () => {
  // v4 曾把它们加入 DEFAULT_DENIED_ENV_TOOLS（硬拒），经复核判定为「审计可达但实战不可达」的越界改动，
  // 已回退。这里锁定回退后的 v3 语义，防止将来无意中又改回去：
  //   默认配置：不在白名单 ⇒ 拒；写进 decideAllowTools ⇒ 放行（扩展位有效）。
  const def = boot();
  await seed(def.host, def.agent);
  for (const name of ['web_fetch', 'workflow', 'web_search', 'subagent']) {
    const res = await def.host.callTool(name, {}, def.agent);
    assert.equal(res.ok, false, `默认配置下 ${name} 必须被拒：${res.text}`);
  }
  const ext = boot({ decideAllowTools: ['web_fetch', 'workflow'] });
  await seed(ext.host, ext.agent);
  for (const name of ['web_fetch', 'workflow']) {
    const res = await ext.host.callTool(name, {}, ext.agent);
    assert.ok(res.denied == null, `写进 decideAllowTools 后 ${name} 应放行（扩展位语义）：${res.text}`);
    assert.equal(res.ok, true, res.text);
  }
});

/* =================================================================== F6a */

test('F6a：顺序要求按角色分述 —— Decide 用 fgs_commit 落盘、Execute 用 fgs_submit_fact', async () => {
  const { host } = boot();
  const injected = host.sections.map((section) => section.text).join('\n');
  // F1 之后 structured_output 必须被声明为「两类活动都放行」的出站工具。
  assert.match(injected,
    /出站\/汇报类工具（send_message \/ present \/ structured_output）\*\*两类活动都放行\*\*/);
  // 必须**按段落**断言，不能拿整段注入文本做模糊匹配：
  // 以 Execute 段落锚点把 fgs-rules 切成 Decide 段 / Execute 段。
  const rules = host.sections.find((section) => section.name === 'fgs-rules')?.text ?? '';
  const executeAt = rules.indexOf('- 本会话持有（owner = 本会话）一个 open step → Execute');
  assert.ok(executeAt > 0, 'fgs-rules 必须含 Execute 段落锚点');
  const decideSeg = rules.slice(0, executeAt);
  const executeSeg = rules.slice(executeAt);
  // Decide 段：不得要求 fgs_submit_fact（Decide 轮调它会被 guard 硬拒，提示词不得与 guard 打架）；
  // 必须要求用 fgs_commit 把本轮图改动落盘。
  assert.doesNotMatch(decideSeg, /必须先 fgs_submit_fact/);
  assert.match(decideSeg, /必须先用 fgs_commit 把本轮图改动落盘/);
  // Execute 段：必须先 fgs_submit_fact 落草稿（能收束就再 fgs_commit_step）。
  assert.match(executeSeg, /必须先 fgs_submit_fact 落草稿/);
  assert.match(injected, /宿主记录结构化输出后即视本 run 结束/);
});

/* ==================================================================== D6 */

/* ==================================================================== D2 */

test('D2：maxCommitsPerRound: 0 不得抑制本回合的第一次兜底（不变量 1 保住）', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 0 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '没人做的 step' }]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.match(graphText(cwd), /无有效产出（观察）/,
    'cap=0 时 turn-stopping 仍必须落一条观察 Fact（回合必须以一条新 Fact 收束）');
});
