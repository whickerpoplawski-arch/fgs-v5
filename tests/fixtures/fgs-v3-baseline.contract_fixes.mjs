/**
 * 对抗性审计发现项的回归测试（每一条都对应一个真实被证伪过的契约点）。
 *
 * 这些用例是「审计用哪招打进来，就用哪招锁回去」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { apply as applyPlugin, EXECUTE_DENIED_GRAPH_TOOLS, GRAPH_MUTATION_TOOLS } from '../index.js';
import { Controller, GraphStore } from '../controller/index.js';
import { seedOriginOp, submitFactOp } from '../controller/ops.js';
import { preflight, preflightStats } from '../hooks/validate_write.js';
import { dropStepOp } from '../controller/ops.js';
import {
  callRoute,
  ensureActiveProject,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  projectJsonPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  for (const name of ['bash', 'read', 'web_fetch', 'web_search', 'subagent', 'workflow', 'todo_write', 'skill', 'send_message', 'present']) {
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
  const agent = makeFakeAgent('sess-audit', cwd);
  host.emit('agent/created', { agent });
  return { host, agent, cwd, services };
}

async function seed(host, agent) {
  const created = ensureActiveProject(host, agent);
  assert.equal(created.kind, 'success', JSON.stringify(created));
  const result = await host.callTool('fgs_seed', { brief: '{"target":"http://x"}' }, agent);
  assert.equal(result.ok, true, result.text);
}

/* ------------------------------------------------------- §4 Decide 白名单 */

test('§4：Decide 轮白名单生效——web/subagent/workflow 也一律被拒（不只是 bash）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  for (const name of ['bash', 'read', 'web_fetch', 'web_search', 'subagent', 'workflow']) {
    const result = await host.callTool(name, {}, agent);
    assert.equal(result.ok, false, `${name} 在 Decide 轮必须被拒`);
    assert.match(result.text, /CONTRACT §4/);
  }
  // 白名单里的只读/元工具仍然可用
  for (const name of ['todo_write', 'skill']) {
    const result = await host.callTool(name, {}, agent);
    assert.equal(result.ok, true, `${name} 应仍在 Decide 白名单里`);
  }
});

test('§4：进入 Execute 轮后环境工具恢复（白名单只在 Decide 生效）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'a', from: ['fact_origin'] }],
  }, agent);
  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, true);
  const read = await host.callTool('read', {}, agent);
  assert.equal(read.ok, true);
});

test('§4：decideAllowTools 可配置扩展白名单', async () => {
  const { host, agent } = boot({ decideAllowTools: ['web_search'] });
  await seed(host, agent);
  const allowed = await host.callTool('web_search', {}, agent);
  assert.equal(allowed.ok, true);
  const stillDenied = await host.callTool('web_fetch', {}, agent);
  assert.equal(stillDenied.ok, false);
});

test('§4：出站/汇报类工具（send_message/present）在 Decide 轮放行——否则收束后无法回报', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  // 本会话没有任何 open step 的 owner ⇒ 角色 = Decide
  const st = await host.callTool('fgs_status', {}, agent);
  assert.equal(st.ok, true);
  // 出站工具只搬运**已经产出**的信息，自身不能执行环境动作 ⇒ 必须放行。
  // 真实故障：worker 一旦 fgs_commit_step 收束完手上最后一个 step，角色自动翻回 Decide，
  // 此时 send_message 被拒 ⇒ 结果静默丢失（两个独立 agent 实测各自撞上同一条拒绝）。
  for (const name of ['send_message', 'present']) {
    const result = await host.callTool(name, {}, agent);
    assert.equal(result.ok, true, `${name} 是出站工具，Decide 轮必须放行：${result.text}`);
    assert.match(result.text, /RAN/);
  }
  // 入站/环境工具仍然被拒（它们能间接改变世界状态）
  for (const name of ['bash', 'subagent', 'workflow', 'web_fetch']) {
    const result = await host.callTool(name, {}, agent);
    assert.equal(result.ok, false, `${name} 在 Decide 轮必须仍被拒`);
    assert.match(result.text, /CONTRACT §4/);
  }
});

/* ------------------------------------------------ §5 回合语义（强制收束） */

test('§5（v3）：同一 step 每回合至多一次；换另一个 step 允许；超过 maxCommitsPerRound 被拒', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: Array.from({ length: 6 }, (_, i) => ({
      op: 'open_step', action: `第${i + 1}步`, from: ['fact_origin'], stepId: `step_00${i + 1}`,
    })),
  }, agent);
  host.ctx.setTurn(7);

  // 1) 收束 step_001
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'a', content: 'c' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);

  // 2) 【v3 核心变更】同一回合收束**另一个** step —— 允许。
  //    旧语义在这里一律拒（"要换 step 请结束本回合"），实测让已做完的第二题无处落盘，
  //    worker 于是绕开黑板（只写磁盘 + 直接刷分），唯一真记忆与真实进展脱钩。
  const otherDraft = await host.callTool('fgs_submit_fact', { title: 'b', content: 'c', stepId: 'step_002' }, agent);
  assert.equal(otherDraft.ok, true, otherDraft.text);
  assert.match(otherDraft.text, /producedBy=step_002/);
  assert.equal((await host.callTool('fgs_commit_step', { stepId: 'step_002' }, agent)).ok, true);

  // 3) 但**同一个 step** 不能在本回合收束两次
  const again = await host.callTool('fgs_commit_step', { stepId: 'step_002' }, agent);
  assert.equal(again.ok, false);
  assert.match(again.text, /已经收束过/);

  // 4) 撞 maxCommitsPerRound（默认 4）：step_003/004 补满额度
  for (const id of ['step_003', 'step_004']) {
    assert.equal((await host.callTool('fgs_submit_fact', { title: 'x' + id, content: 'c', stepId: id }, agent)).ok, true);
    assert.equal((await host.callTool('fgs_commit_step', { stepId: id }, agent)).ok, true);
  }
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'y', content: 'c', stepId: 'step_005' }, agent)).ok, true);
  const over = await host.callTool('fgs_commit_step', { stepId: 'step_005' }, agent);
  assert.equal(over.ok, false);
  assert.match(over.text, /maxCommitsPerRound/);

  // 5) 新回合 → 记账清空，可以继续（草稿跨回合保留，这正是补交通道）
  host.ctx.setTurn(8);
  assert.equal((await host.callTool('fgs_commit_step', { stepId: 'step_005' }, agent)).ok, true);
});

test('§5：回合收口时没调用 commit_step，也会强制落一条观察 Fact', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(3);
  await host.callTool('fgs_submit_fact', { title: '半成品草稿', content: '还没定稿' }, agent);

  // 模型直接结束回合（没有 commit_step）
  host.emit('agent/turn-stopping', { agent, turn: 3 });

  const graph = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(graph, /半成品草稿/, '草稿里的内容应被强制收束，而不是丢掉');
  assert.doesNotMatch(graph, /state: "open"/, 'step 必须被收束');

  // 同一回合再触发一次不会重复写
  const before = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  host.emit('agent/turn-stopping', { agent, turn: 3 });
  assert.equal(fs.readFileSync(projectGraphPath(cwd), 'utf8'), before);
});

test('§5：完全没有 submit_fact 时，回合收口强制写观察 Fact', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(11);
  host.emit('agent/turn-stopping', { agent, turn: 11 });
  assert.match(fs.readFileSync(projectGraphPath(cwd), 'utf8'), /观察/);
});

test('§5（v3）：显式 stepId 可换到另一个未收束的 step；指向不存在的 step 仍拒', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '第一步', from: ['fact_origin'] },
      { op: 'open_step', action: '第二步', from: ['fact_origin'] },
    ],
  }, agent);
  const first = await host.callTool('fgs_submit_fact', { title: 't', content: 'c' }, agent);
  assert.equal(first.ok, true, first.text);
  assert.match(first.text, /producedBy=step_001/);
  // 指向图上不存在的 step → 仍然拒（不许静默改到别的 step）
  const retarget = await host.callTool('fgs_submit_fact', { title: 't2', content: 'c2', stepId: 'step_999' }, agent);
  assert.equal(retarget.ok, false);
  assert.match(retarget.text, /不是 open step/);
  // v3：换到图上真实存在、且本回合还没收束过的另一个 step —— 允许，但 must 改绑到它
  const other = await host.callTool('fgs_submit_fact', { title: 't3', content: 'c3', stepId: 'step_002' }, agent);
  assert.equal(other.ok, true, other.text);
  assert.match(other.text, /producedBy=step_002/);
});

/* ------------------------------------------------------------- §7 蒸馏门 */

test('§7：超阈值 content 必须是「单个路径」，路径+大段正文 / 无空白长串都拒', () => {
  const store = new GraphStore(tmpDir(), { factContentMaxBytes: 100 });
  const ctl = new Controller(store, { verifyHook: null });
  ctl.commit(ctl.apply(seedOriginOp({ title: '题目信息:', content: '{"target":"http://x"}' })));
  ctl.commit(ctl.apply({
    type: 'open_step',
    action: '取产物',
    from: ['fact_origin'],
    actor: 'agent',
    priority: 'normal',
    stepId: null,
  }));

  const auditProbe = `${'中'.repeat(4094)}/`; // 审计用过的绕过串
  assert.throws(
    () => ctl.apply(submitFactOp({ title: 't', content: auditProbe, producedBy: 'step_001' })),
    /不是单个文件路径/,
  );
  assert.throws(
    () => ctl.apply(submitFactOp({
      title: 't',
      content: `/workspace/out.txt ${'中'.repeat(4000)}`,
      producedBy: 'step_001',
    })),
    /不是单个文件路径/,
  );
  // 真·路径放行
  const okGraph = ctl.apply(submitFactOp({
    title: 't',
    content: 'workspace/artifacts/nmap_full.txt',
    producedBy: 'step_001',
  }));
  assert.equal(okGraph.facts[1].content, 'workspace/artifacts/nmap_full.txt');
});

/* ----------------------------------------------------- §1/§2 ID 与 Goal */

test('§2/v2：Sub Goal 合法（kind=sub + parentId），非法 goal id 与非法 step id 仍被拒', () => {
  const store = new GraphStore(tmpDir());
  store.ensureDir();
  fs.writeFileSync(store.graphPath, [
    'facts:',
    '- id: "fact_origin"',
    '  title: "题目信息:"',
    '  createdAt: "2026-01-01T00:00:00.000Z"',
    'goals:',
    '- id: "goal_final"',
    '  kind: "final"',
    '  criterion: "c"',
    '  createdAt: "2026-01-01T00:00:00.000Z"',
    // v2：Sub Goal 是一等公民 —— id 须 goal_xxx、kind 须 sub、parentId 须已存在
    '- id: "goal_sub_001"',
    '  kind: "sub"',
    '  criterion: "阶段目标"',
    '  createdAt: "2026-01-01T00:00:00.000Z"',
    '  parentId: "goal_final"',
    '  state: "open"',
    // 非法：id 不符合 goal_xxx
    '- id: "goalsub"',
    '  kind: "sub"',
    '  criterion: "c"',
    '  createdAt: "2026-01-01T00:00:00.000Z"',
    'steps:',
    '- id: "step_abc"',
    '  action: "a"',
    '  from: ["fact_origin"]',
    '  actor: "agent"',
    '  priority: "normal"',
    '  state: "open"',
    '  createdAt: "2026-01-01T00:00:00.000Z"',
    '',
  ].join('\n'), 'utf8');
  const errs = store.validate(store.load());
  assert.ok(!errs.some((e) => /goal_sub_001/.test(e)), `合法的 Sub Goal 不应被拒: ${errs.join(' | ')}`);
  assert.ok(errs.some((e) => /Sub Goal id 非法/.test(e)), `应拒 goalsub: ${errs.join(' | ')}`);
  assert.ok(errs.some((e) => /step id 非法/.test(e)), `应拒 step_abc: ${errs.join(' | ')}`);
  assert.throws(() => store.save(store.load()), /拒写/);
});

/* --------------------------------------------------------- §3 预检真的跑 */

test('§3：Controller.apply 确实调用了 hooks/validate_write.preflight', () => {
  const store = new GraphStore(tmpDir());
  const ctl = new Controller(store, { verifyHook: null });
  ctl.commit(ctl.apply(seedOriginOp({ title: '题目信息:', content: '{"target":"http://x"}' })));
  const before = preflightStats.calls;
  assert.throws(() => ctl.apply(dropStepOp({ stepId: 'step_001', reason: '' })), /reason/);
  assert.ok(preflightStats.calls > before, 'preflight 必须被调用（计数器证明路径）');
  // 直接调 preflight 也拒
  assert.throws(() => preflight(dropStepOp({ stepId: 'step_001', reason: '  ' })), /reason/);
});

/* ------------------------------------------------- §9 io-specs 真的进上下文 */

test('§9：io-specs/<role>.io.yaml 的内容真的被注入运行时上下文', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const provider = host.contexts[0].text;
  const decideText = provider({ scope: agent });
  assert.match(decideText, /I\/O 预制规范/);
  assert.match(decideText, /io-specs\/decide\.io\.yaml/);
  assert.match(decideText, /fgs_commit/);

  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'a', from: ['fact_origin'] }],
  }, agent);
  const executeText = provider({ scope: agent });
  assert.match(executeText, /io-specs\/execute\.io\.yaml/);
  assert.match(executeText, /一轮只吃一个 open step/);
});

/* --------------------------- v2：提示词里的工具清单必须与 tools.guard 一致 */

/**
 * 对抗性回归：v2 起「图操作工具两类活动都放行」，但 sync_context 里那句
 * 「规划类工具（…）本轮会被拒」原本是**手写清单**，没跟着 guard 改。
 * 后果实测过：提示词说会被拒、guard 其实放行 → 模型**自我审查**，
 * 明明可用的 fgs_open_step / fgs_commit 也不敢用，「图不僵死」在执行侧直接落空。
 * 这里把「注入文本」与「guard 的真实行为」做**双向一致性**断言，堵死再次漂移。
 */
test('v2：Execute 注入文本声明的「会被拒/放行」必须与 tools.guard 真实行为逐项一致', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'a', from: ['fact_origin'] }],
  }, agent);
  const text = host.contexts[0].text({ scope: agent });
  assert.match(text, /Execute/, '此时必须处于 Execute 轮');

  // 1) 文本层：放行清单必须逐项出现；被拒清单只能是 goal 级工具。
  const allowLine = text.split('\n').find((l) => l.includes('照常放行'));
  assert.ok(allowLine, 'Execute 文本必须显式声明图操作工具「照常放行」');
  for (const t of GRAPH_MUTATION_TOOLS) {
    assert.ok(allowLine.includes(t), `放行清单缺少 ${t}`);
  }
  const denyLine = text.split('\n').find((l) => l.includes('会被拒的图工具'));
  assert.ok(denyLine, 'Execute 文本必须显式列出真正会被拒的图工具');
  for (const t of EXECUTE_DENIED_GRAPH_TOOLS) {
    assert.ok(denyLine.includes(t), `被拒清单缺少 ${t}`);
  }
  for (const t of GRAPH_MUTATION_TOOLS) {
    assert.ok(!denyLine.includes(t), `${t} 被 guard 放行，绝不能出现在「会被拒」清单里`);
  }

  // 2) 行为层：拿文本里的两个清单，逐一真调，验证 guard 与文本完全对齐。
  for (const tool of GRAPH_MUTATION_TOOLS) {
    const res = await host.callTool(tool, {}, agent);
    const denied = /角色隔离|会被拒/.test(res.text ?? '');
    assert.equal(denied, false, `${tool} 应被放行，实际被拒: ${res.text}`);
  }
  for (const tool of EXECUTE_DENIED_GRAPH_TOOLS) {
    const res = await host.callTool(tool, {}, agent);
    const denied = /角色隔离/.test(res.text ?? '');
    assert.equal(denied, true, `${tool} 应被角色守卫拒绝，实际放行: ${res.text}`);
  }
});

/* ------------------- v2：上下文预算（图只追加 ⇒ 注入不能无限膨胀） */

test('v2：GraphStore.focused 有硬预算，且当前 step 因果链的正文必须保留', () => {
  const store = new GraphStore(tmpDir());
  const facts = [{ id: 'fact_origin', title: '题目信息:', content: 'ORIGIN_BODY' }];
  for (let i = 1; i <= 200; i += 1) {
    facts.push({
      id: `fact_${String(i).padStart(3, '0')}`,
      title: `fact title ${i}`,
      content: `PAYLOAD_${i}_END ${'x'.repeat(60)}`,
      producedBy: 'step_001',
    });
  }
  const graph = {
    facts,
    goals: [{ id: 'goal_final', kind: 'final', criterion: 'c', createdAt: 't' }],
    steps: [
      { id: 'step_001', action: 'a', from: ['fact_001'], state: 'open', priority: 'high', createdAt: 't' },
      { id: 'step_002', action: 'b', from: ['fact_002'], state: 'open', priority: 'high', createdAt: 't' },
    ],
  };
  // 前置：全图注入确实会超预算（否则这条测试没有意义）
  assert.ok(store.toYaml(graph).length > 12000, '前置条件：全图注入应当远超预算');

  const text = store.focused(graph, { stepId: 'step_001', maxChars: 12000 });
  assert.ok(text.length <= 12000, `注入必须受预算约束，实际 ${text.length}`);
  // 因果链必需：当前 step(from=fact_001) 与自家链上的 fact_002 正文都要在
  assert.match(text, /PAYLOAD_1_END/);
  assert.match(text, /PAYLOAD_2_END/);
  // 旁支 fact 只留 id+title，正文不得注入
  assert.ok(!text.includes('PAYLOAD_200_END'), '非因果链 fact 的正文不该进上下文');
  assert.match(text, /title: "fact title 200"/);
});

test('v2：Execute 轮注入走 focused（超预算时给出显式截断标记，不静默丢）', async () => {
  const { host, agent } = boot({ injectMaxChars: 300 });
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'a', from: ['fact_origin'] }],
  }, agent);
  const text = host.contexts[0].text({ scope: agent });
  assert.match(text, /Execute/);
  assert.match(text, /注入已按因果邻域截断/, '超预算必须显式标记，不能静默截断');
});

test('v2：任务池压缩 —— 上百个 open step 时只有当前 step 保留完整 action（否则注入又会被任务池撑爆）', () => {
  const store = new GraphStore(tmpDir());
  const long = 'X'.repeat(300);
  const steps = [];
  for (let i = 1; i <= 200; i += 1) {
    steps.push({
      id: `step_${String(i).padStart(3, '0')}`, action: `TASK_${i}_${long}`,
      from: ['fact_origin'], state: 'open', priority: 'high', createdAt: 't',
    });
  }
  const graph = {
    facts: [{ id: 'fact_origin', title: 'o', content: 'O' }],
    goals: [{ id: 'goal_final', kind: 'final', criterion: 'c', createdAt: 't' }],
    steps,
  };
  const text = store.focused(graph, { stepId: 'step_001', maxChars: 24000 });
  assert.ok(text.includes(`TASK_1_${long}`), '当前 step 必须保留完整 action');
  // 任务池尾部：**id 必须可见**（否则 worker「看不见任务」），action 允许被丢
  assert.ok(text.includes('step_200'), '尾部 step 的 id 必须仍可见（否则无法认领）');
  assert.ok(!text.includes(`TASK_200_${long}`), '其他 step 的 action 必须被截断');
  // Decide 的 preview 同样要压（worker 每次回到 Decide 都会读一次）
  assert.ok(!store.preview(graph).includes(`TASK_200_${long}`), 'preview 也必须压任务池');
  assert.ok(store.toYaml(graph).length > text.length * 3, '压缩比要足够显著');
});

/* ------------- v2：派发任务池必须能「不自动认领」（Cairn Dispatcher 前提） */

/**
 * 对抗性回归：v2 的批量 commit 会把**本回合新开的每个 step 自动认领给提交者**。
 * 后果实测过：派发者批量 open 63 个任务 step 后全部 `owner=派发者`，`openUnclaimed` 恒为 0，
 * 别的 worker **一个任务都领不到**（「未认领或租约过期的 step 可被任何会话认领」变成死条款），
 * 只能干等 stepLeaseMs(30min)。这里锁死：传 claimOpened:false 必须真的留下未认领的 step。
 */
test('v2：claimOpened:false 必须让新开的 step 保持未认领（否则 Cairn 派发语义无法表达）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  const dispatched = await host.callTool('fgs_commit', {
    claimOpened: false,
    operations: [
      { op: 'open_step', stepId: 'step_001', action: '解 a-01', from: ['fact_origin'], priority: 'high' },
      { op: 'open_step', stepId: 'step_002', action: '解 a-02', from: ['fact_origin'], priority: 'high' },
    ],
  }, agent);
  assert.equal(dispatched.ok, true, dispatched.text);
  // 派发者本人不应因此变成 Execute（它没有持有任何 step）
  const mine = host.contexts[0].text({ scope: agent });
  assert.match(mine, /Decide/, '派发者不应自动认领 → 应仍是 Decide');

  // 另一个会话必须能领走（这正是 worker 拉取任务池的行为）
  const other = makeFakeAgent('sess-worker', cwd);
  host.emit('agent/created', { agent: other });
  const claimed = await host.callTool('fgs_claim_step', { stepId: 'step_001' }, other);
  assert.match(claimed.text, /已认领|claimed/i, `未认领的 step 必须可被别的会话领走: ${claimed.text}`);

  // 对照：默认（claimOpened 省略 = true）时，派发者自己会持有，别的会话领不走
  const { host: h2, agent: a2, cwd: c2 } = boot();
  await seed(h2, a2);
  await h2.callTool('fgs_commit', {
    operations: [{ op: 'open_step', stepId: 'step_001', action: 'x', from: ['fact_origin'] }],
  }, a2);
  const other2 = makeFakeAgent('sess-worker2', c2);
  h2.emit('agent/created', { agent: other2 });
  const denied = await h2.callTool('fgs_claim_step', { stepId: 'step_001' }, other2);
  assert.match(denied.text, /已被|租约|不得|拒/i, '默认自动认领后，别的会话应领不走');
});

/* ---------------------------- 旧的 io-spec 注入点（保留） */

test('§9：工具出参按 maxResultChars 截断（噪声不进模型）', async () => {
  const { host, agent } = boot({ maxResultChars: 120 });
  await seed(host, agent);
  const preview = await host.callTool('fgs_preview', {}, agent);
  assert.equal(preview.ok, true);
  assert.match(preview.content[0].text, /truncated/);
});

/* ------------------------------------------------------ §9 跨会话不泄漏 */

test('§9：/fgs/state 按 sessionId 取图，不会把别的会话黑板给当前面板', async () => {
  const { host, agent } = boot();
  const other = makeFakeAgent('sess-other', tmpDir());
  await seed(host, agent);
  const mine = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-audit');
  assert.equal(mine.json.active, true);
  assert.equal(mine.json.sessionId, 'sess-audit');
  const theirs = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-other');
  assert.equal(theirs.json.active, false, '别的会话不得看到本会话的黑板');
  // 不带 sessionId 时保留 lastRun 回退（curl/运维方便）
  const fallback = await callRoute(host.routes[0], '/fgs/state');
  assert.equal(fallback.json.active, true);
});

/* ---------------------------------------------- §5 刚打开的 step 不被吞 */

test('§5：本轮刚打开的 step 不会在回合收口被吞成观察 Fact（live E2E 实测缺陷）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  host.ctx.setTurn(5);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '还没轮到执行的第一步', from: ['fact_origin'] }],
  }, agent);

  // 同一回合收口：不得写任何 Fact，step 必须保持 open 留给下一回合
  host.emit('agent/turn-stopping', { agent, turn: 5 });
  const graphPath = projectGraphPath(cwd);
  let graph = fs.readFileSync(graphPath, 'utf8');
  assert.match(graph, /state: "open"/, '刚打开的 step 必须留给下一回合，不能被吞掉');
  assert.doesNotMatch(graph, /观察/, '不得为「刚打开、还没执行」的 step 写观察 Fact');
  assert.doesNotMatch(graph, /无有效产出/);

  // 下一回合它仍然可以被正常推进并收束
  host.ctx.setTurn(6);
  assert.equal((await host.callTool('fgs_submit_fact', { title: 't', content: 'c' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  graph = fs.readFileSync(graphPath, 'utf8');
  assert.match(graph, /state: "done"/);
  assert.match(graph, /title: "t"/);
});

test('§5：跨回合后仍然会为「没人做」的旧 step 补观察 Fact（修复不得关掉这条硬规则）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  host.ctx.setTurn(5);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);

  // 回合 5 放过它（刚打开），回合 6 结束还没人做 → 必须补观察 Fact
  host.emit('agent/turn-stopping', { agent, turn: 5 });
  host.ctx.setTurn(6);
  host.emit('agent/turn-stopping', { agent, turn: 6 });
  const graph = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(graph, /无有效产出（观察）/);
  assert.doesNotMatch(graph, /state: "open"/);
});

/* ------------------------------------- §9 面板快照：空图与角色一致性 */

test('§9：图文件被移除后快照报 active:false，不再渲染成 execute + 0/0/0', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'x', from: ['fact_origin'] }],
  }, agent);
  const before = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-audit');
  assert.equal(before.json.active, true);
  assert.equal(before.json.role, 'execute');
  assert.ok(before.json.buildTag, '快照必须带 buildTag，重启后一眼确认代码生效');

  // 绕过插件删掉图文件（本轮 live 实测就是这一步让面板陷入矛盾状态）
  fs.rmSync(projectGraphPath(cwd), { force: true });
  fs.rmSync(projectJsonPath(cwd), { force: true });

  const after = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-audit');
  assert.equal(after.json.active, false, '空图必须按「未启动」上报，而不是 execute + 0/0/0');
  assert.equal(after.json.counts, undefined);
  assert.equal(after.json.role, undefined);

  const status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /未启动/);
  assert.doesNotMatch(status.text, /Execute/);
});

test('§9：快照角色从图推导，不报内存缓存值', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'x', from: ['fact_origin'] }],
  }, agent);
  // 绕过插件直接改图：把唯一的 open step 标成 done（模拟图被外部改动）
  const graphPath = projectGraphPath(cwd);
  fs.writeFileSync(
    graphPath,
    fs.readFileSync(graphPath, 'utf8').replace('state: "open"', 'state: "done"'),
  );
  const res = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-audit');
  assert.equal(res.json.counts.open, 0);
  assert.equal(res.json.role, 'decide', '角色必须跟着图走，不能停在缓存里的 execute');
});

/* ==========================================================================
 * 超时场景的回归：真实跑分里唯一真正丢过数据的路径
 *
 * 背景（实测）：一道多 flag 题跑了 23 分钟，黑板停在 `state: open`、0 条 fact，
 * 真正拿到的 1/2 flag 只留在平台侧。根因不是模型"忘了"，而是 §5 的收口钩子
 * 挂在 `agent/turn-stopping` 上 —— 而 supervisor 超时是**在回合中途**发 SIGTERM，
 * 该事件永远不会触发。下面三个用例把这条路径锁死。
 * ========================================================================== */

test('§5（v3）：配额拒收必须给出可执行的出路（否则第 2 个 flag 会静默丢失）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: Array.from({ length: 6 }, (_, i) => ({
      op: 'open_step', action: `第${i + 1}步`, from: ['fact_origin'], stepId: `step_00${i + 1}`,
    })),
  }, agent);
  host.ctx.setTurn(31);

  // 用满单回合额度（默认 4）
  for (const id of ['step_001', 'step_002', 'step_003', 'step_004']) {
    assert.equal((await host.callTool('fgs_submit_fact', { title: 't' + id, content: 'c', stepId: id }, agent)).ok, true);
    assert.equal((await host.callTool('fgs_commit_step', { stepId: id }, agent)).ok, true);
  }
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'x', content: 'c', stepId: 'step_005' }, agent)).ok, true);
  const over = await host.callTool('fgs_commit_step', { stepId: 'step_005' }, agent);
  assert.equal(over.ok, false);
  // 只报错没用 —— 实测模型收到旧文案后会**再试一次**，然后这一段的发现照样丢；
  // 更糟的是它会**绕开黑板**（写磁盘 + 直接刷分），所以出路必须把这条路堵死。
  assert.match(over.text, /结束本回合/, '必须给出"结束本回合"的出路');
  assert.match(over.text, /fgs_submit_fact/, '必须给出"先写成草稿"的出路');
  assert.match(over.text, /绕过黑板/, '必须明确禁止绕过黑板');
});

test('§5 兜底：回合被信号中断（turn-stopping 永不触发）时也必须收束黑板', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(41);

  // 前置条件：step 确实是 open 的（复刻实测里那个冻结状态）
  const before = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(before, /state: "open"/);

  // ⚠️ 刻意**不**触发 `agent/turn-stopping` —— 模拟 supervisor 在回合中途 SIGTERM。
  // 哨兵监听者让 listenerCount>1，从而抑制插件"摘掉自己重新触发信号"的分支
  //（否则测试进程会被真的 SIGTERM 杀掉）。
  const sentinel = () => {};
  process.on('SIGTERM', sentinel);
  try {
    process.emit('SIGTERM');
  } finally {
    process.removeListener('SIGTERM', sentinel);
  }

  const after = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.notEqual(after, before, '黑板必须被写入，不能留在 open');
  assert.doesNotMatch(after, /state: "open"/, 'step 必须被收束');
  // 诚实性：不能谎称"无有效产出" —— 这一轮可能已经拿到 flag，只是没来得及落盘。
  assert.match(after, /中断/, '必须标注为"被信号中断"');
  assert.doesNotMatch(after, /无有效产出/, '不得假称无产出');
});

test('§5 兜底：有草稿时落草稿内容，而不是中断占位', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(51);
  // 模型写下了草稿但还没来得及 commit_step 就被信号打断
  await host.callTool('fgs_submit_fact', {
    title: '已确认：/admin 需要 ?pwd=',
    content: 'robots.txt 泄露路径；/admin 无参返回 403',
  }, agent);

  const sentinel = () => {};
  process.on('SIGTERM', sentinel);
  try {
    process.emit('SIGTERM');
  } finally {
    process.removeListener('SIGTERM', sentinel);
  }

  const after = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(after, /已确认：\/admin 需要 \?pwd=/, '草稿内容必须被保住');
  assert.match(after, /robots\.txt 泄露路径/, '草稿正文必须落盘');
  assert.doesNotMatch(after, /中断/, '有草稿时不该写中断占位');
});

test('§5 兜底：每次挂载恰好注册一个 SIGTERM 监听（不重复注册）', () => {
  const n = process.listenerCount('SIGTERM');
  boot();
  assert.equal(process.listenerCount('SIGTERM'), n + 1);
});




/* ------------------------------------------------ 缺陷 M：草稿过期 ≠ 丢弃 */

/**
 * 实测代价（live gen 8）：我在 05:47 `fgs_submit_fact` 成功，但会话被挂起，
 * 直到 07:07 才轮到 `fgs_commit_step` —— 60 分钟的 `stepDraftTtlMs` 已把草稿清空，
 * 于是兜底落了一条「step_083 无有效产出（观察）」。**黑板把模型已经交付的内容忘了，
 * 还谎报这一步没有产出。** 这条测试锁死修复：过期只能触发「补交」，不能丢内容。
 */
test('缺陷 M（v3）：草稿过期后内容不得消失——兜底收束要以「(草稿过期后补交)」落盘', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(3);
  const drafted = await host.callTool('fgs_submit_fact', {
    title: '重要发现',
    content: 'flag{abc-123} 与关键命令 curl ...',
  }, agent);
  assert.equal(drafted.ok, true, drafted.text);

  // 模拟「会话被挂起超过 stepDraftTtlMs」（实测 80 分钟后才轮到 commit_step）
  await new Promise((r) => setTimeout(r, 40));

  const closed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(closed.ok, true, closed.text);

  const yaml = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(yaml, /flag\{abc-123\}/, '过期草稿的内容必须仍然落进图里');
  assert.match(yaml, /草稿过期后补交/, '必须标明是补交，而不是静默冒充正常产出');
  assert.doesNotMatch(yaml, /无有效产出/, '不得再谎报「无有效产出」');
});
