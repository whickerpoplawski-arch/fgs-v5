/**
 * v4 独立对抗性验证 R1（第三方 verifier 会话，不共享写入者上下文）。
 *
 * 立场：**默认这 8 处修复没修好**。下面每条测试都尽量从「真实返回值 / 真实磁盘图」出发，
 * 而不是从源码常量自证。测试名里的【修复】= 该缺陷本轮已修好；【脆弱性】/【配置边界】= 如实记录
 * 已知但**本轮不改**的边界；另有部分用例在 F5 回退后改为锁定回退语义（见用例名里的「F5 已回退」）。
 *
 * 覆盖：
 *   F1  EGRESS_TOOLS 加 structured_output；bash 仍拒；逐个枚举默认 Decide 白名单与硬拒清单，
 *       并与 v3 基线清单做集合差，防「顺手放宽/收紧」；
 *   F2  forceCloseStep 兜底补交保留 findingType（按 YAML 解析后的对象断言，不靠字符串）；
 *   F3  过期草稿截断删除后，8 条过期草稿一条不丢；
 *   F4  cap 约束兜底 + 「本回合 0 次收束仍落观察 Fact」 + limited=false 不做 cap + cap=0 退化行为；
 *   F5  已回退：四个网络/委派类默认拒（白名单缺省）、写进 decideAllowTools 即放行；普通工具的扩展位有效；
 *   F6a FGS_RULES 顺序要求存在，且「放行/被拒」声明与 guard 行为逐项一致；io-spec 顺序文本进上下文；
 *   F6b C 的收尾：两个 io-spec YAML 能被自带 yaml.js 解析、注入恢复。
 *
 * 运行：node --test tests/verify_v4_adversarial.test.mjs
 */
import test from 'node:test';
// 每次 boot 都会注册一对 SIGTERM/SIGINT 监听（插件用 ctx.effect 持有，假宿主不自动清理），
// 属于测试脚手架噪声，与本验证无关。
process.setMaxListeners(0);
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { apply as applyPlugin, PLUGIN_GENERATION, BUILD_TAG } from '../index.js';
import { load as loadYaml } from '../yaml.js';
import {
  ensureActiveProject,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

/* --------------------------------------------------------------- 源码常量提取 */
// 这些常量没有 export，无法直接 import；为了「逐个枚举真实常量」而不是手抄一份，
// 这里从 index.js / 内置 v3 基线源码里把数组字面量抠出来（含 ...spread 解析）。
//
// 基线为什么是内置 fixture：`fgs-v3/index.js`（冻结的 gen9）原本放在**仓库之外**的兄弟目录，
// 只有作者本机才有 → 别人 git clone / 解压后这一整个测试文件会 ENOENT 直接失败。
// 现在把它作为 `tests/fixtures/fgs-v3-baseline.index.js` 收进仓库（与冻结基线逐字节相同），
// 测试因此自足、可移植。
const V4_SRC = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const V3_SRC = fs.readFileSync(new URL('./fixtures/fgs-v3-baseline.index.js', import.meta.url), 'utf8');

function constArraySource(src, name) {
  const marker = `const ${name} = `;
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `源码里找不到 const ${name}`);
  const open = src.indexOf('[', at + marker.length - 1);
  assert.ok(open >= 0, `${name} 不是数组字面量`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 数组括号不平衡`);
}

/** 解析 const NAME = [ 'a', ...OTHER, 'b' ]；返回字符串数组（递归展开 spread）。 */
function resolveConst(src, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const block = constArraySource(src, name);
  const re = /\.\.\.\s*([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)"/g;
  const out = [];
  let m = re.exec(block);
  while (m !== null) {
    if (m[1]) out.push(...resolveConst(src, m[1], seen));
    else out.push(m[2] ?? m[3]);
    m = re.exec(block);
  }
  return out;
}

const V4_ALLOW = resolveConst(V4_SRC, 'DEFAULT_DECIDE_ALLOW_TOOLS');
const V4_DENIED = resolveConst(V4_SRC, 'DEFAULT_DENIED_ENV_TOOLS');
const V4_EGRESS = resolveConst(V4_SRC, 'EGRESS_TOOLS');
const V3_ALLOW = resolveConst(V3_SRC, 'DEFAULT_DECIDE_ALLOW_TOOLS');
const V3_DENIED = resolveConst(V3_SRC, 'DEFAULT_DENIED_ENV_TOOLS');
const V3_EGRESS = resolveConst(V3_SRC, 'EGRESS_TOOLS');

const setDiff = (a, b) => a.filter((x) => !b.includes(x));

/* --------------------------------------------------------------- 脚手架 */

// 守卫按工具名判定；假宿主里未注册的工具在 callTool 里直接 UNKNOWN_TOOL、绕过守卫，
// 所以凡是待测工具都必须注册成假实现，才能观测到守卫的真实裁定。
const HOST_TOOLS = [
  ...new Set([
    ...V4_ALLOW, ...V4_DENIED, ...V4_EGRESS,
    // 未在任一清单里的「陌生环境工具」，用于验证白名单仍是封闭的
    'my_env_tool', 'my_custom_tool',
  ]),
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
  // 配置允许的扩展工具也要能真执行，测试里再单独注册。
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-A', cwd);
  host.emit('agent/created', { agent });
  return { host, agent, cwd, services };
}

function registerFake(host, name) {
  host.ctx.tools.register({
    name,
    description: `fake ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute() { return { ok: true, text: `${name} RAN` }; },
  });
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

function graphDoc(cwd, problemId = 'default') {
  return loadYaml(graphText(cwd, problemId));
}

function countFacts(cwd, problemId = 'default') {
  const doc = graphDoc(cwd, problemId);
  return (doc.facts ?? []).length;
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

function rulesText(host) {
  const def = host.sections.find((s) => s?.name === 'fgs-rules');
  assert.ok(def, 'systemPrompt 段 fgs-rules 必须已注册');
  return def.text;
}

function graphContextText(host, agent) {
  const def = host.contexts.find((c) => c?.name === 'fgs-graph');
  assert.ok(def, 'systemPrompt context fgs-graph 必须已注册');
  return def.text({ scope: agent });
}

/* ==================================================================== F1 */

test('F1-a：Decide 轮 structured_output 真放行（守卫不拒且工具真的执行），bash 仍拒', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const egress = await host.callTool('structured_output', {}, agent);
  assert.ok(egress.denied == null, `structured_output 不应被守卫拒绝：${egress.text}`);
  assert.equal(egress.ok, true, egress.text);
  assert.match(egress.text, /RAN/, '必须真的执行到工具，而不是只绕过守卫');

  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, false, `bash 在 Decide 仍必须被拒：${bash.text}`);
  assert.equal(typeof bash.denied, 'string');
});

test('F1-b：逐个枚举真实 DEFAULT_DECIDE_ALLOW_TOOLS，全部放行，且与硬拒清单无交集', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  assert.ok(V4_ALLOW.length >= 15, `白名单解析异常，只有 ${V4_ALLOW.length} 项`);
  assert.ok(V4_ALLOW.includes('structured_output'), '白名单必须含 structured_output');
  const overlap = V4_ALLOW.filter((t) => V4_DENIED.includes(t));
  assert.deepEqual(overlap, [],
    `白名单与硬拒清单交集非空（提示词说放行、guard 会拒）：${overlap.join(', ')}`);
  for (const name of V4_ALLOW) {
    const res = await host.callTool(name, {}, agent);
    // 守卫放行时 callTool 不带 denied（undefined）；被拒时是字符串。
    assert.ok(res.denied == null, `${name} 在 Decide 轮不应被守卫拒绝：${res.text}`);
    assert.equal(res.ok, true, `${name} 应放行并执行：${res.text}`);
    assert.match(res.text, /RAN/, `${name} 必须真的执行`);
  }
});

test('F1-c：逐个枚举真实 DEFAULT_DENIED_ENV_TOOLS，Decide 轮一个都不许漏拒', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  assert.ok(V4_DENIED.includes('bash'), 'bash 必须在硬拒清单里');
  for (const name of V4_DENIED) {
    const res = await host.callTool(name, {}, agent);
    assert.equal(res.ok, false, `${name} 在 Decide 必须被拒：${res.text}`);
    assert.equal(typeof res.denied, 'string', `${name} 应返回 denied 字符串`);
    assert.match(res.text, /CONTRACT §4/);
  }
  // 陌生环境工具：不在白名单 ⇒ 仍被封闭白名单拒（证明扩展没有变成「全放行」）
  const stranger = await host.callTool('my_env_tool', {}, agent);
  assert.equal(stranger.ok, false, `白名单之外的陌生工具必须被拒：${stranger.text}`);
  assert.equal(typeof stranger.denied, 'string');
});

test('F1-d：与 v3 基线对比，只有白名单/出站各多一个 structured_output；硬拒清单不得变化（F5 已回退）', async () => {
  // allow：只允许新增 structured_output（跟着 EGRESS 走），不得顺手放宽别的工具
  assert.deepEqual(setDiff(V4_ALLOW, V3_ALLOW), ['structured_output'],
    `白名单相对 v3 多出的项不止 structured_output：${setDiff(V4_ALLOW, V3_ALLOW).join(', ')}`);
  assert.deepEqual(setDiff(V3_ALLOW, V4_ALLOW), [],
    `白名单相对 v3 少了项（顺手收紧）：${setDiff(V3_ALLOW, V4_ALLOW).join(', ')}`);
  // egress：只允许新增 structured_output
  assert.deepEqual(setDiff(V4_EGRESS, V3_EGRESS), ['structured_output']);
  assert.deepEqual(setDiff(V3_EGRESS, V4_EGRESS), []);
  // denied：F5（把四个网络/委派类加入硬拒清单）已按复核结论**回退** ⇒ 必须与 v3 完全一致
  assert.deepEqual([...setDiff(V4_DENIED, V3_DENIED)].sort(), [],
    `硬拒清单相对 v3 多出了项（F5 应已回退）：${setDiff(V4_DENIED, V3_DENIED).join(', ')}`);
  assert.deepEqual(setDiff(V3_DENIED, V4_DENIED), [],
    `硬拒清单相对 v3 少了项（放宽）：${setDiff(V3_DENIED, V4_DENIED).join(', ')}`);
});

test('F1-e：Execute 轮 structured_output 同样放行（声称「两类活动都放行」为真）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '探路' }]);
  const res = await host.callTool('structured_output', {}, agent);
  assert.ok(res.denied == null, `Execute 轮 structured_output 不应被拒：${res.text}`);
  assert.equal(res.ok, true, res.text);
});

/* ==================================================================== F2 */

test('F2-a：兜底补交过期草稿必须保留 findingType（解析 YAML 对象断言，防引号空转）', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '探路' }]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2); // 避开「刚打开」保护

  const drafted = await host.callTool('fgs_submit_fact', {
    title: '漏洞发现', content: 'ZZF2MARKER', findingType: 'vuln',
  }, agent);
  assert.equal(drafted.ok, true, drafted.text);
  await sleep(40);
  await host.callTool('fgs_status', {}, agent); // refreshRole → 草稿进入 expiredDrafts
  host.emit('agent/turn-stopping', { agent, turn: 2 });

  const doc = graphDoc(cwd);
  const fact = (doc.facts ?? []).find((f) => String(f.content ?? '').includes('ZZF2MARKER'));
  assert.ok(fact, `兜底补交的 Fact 必须落盘；图里没有 ZZF2MARKER。原文:\n${graphText(cwd)}`);
  assert.match(String(fact.title ?? ''), /草稿过期后补交/, '必须标明是过期补交');
  assert.equal(fact.findingType, 'vuln',
    `findingType 必须原样保留，实际=${JSON.stringify(fact.findingType)}`);
  // 反向：不许被静默降级成 info（旧缺陷的表现）
  assert.notEqual(fact.findingType, 'info');
});

test('F2-b：兜底走「未过期草稿」路径时 findingType 同样保留（同一行修复的另一半）', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 60 * 60 * 1000 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '探路' }]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  await host.callTool('fgs_submit_fact', {
    title: '未过期漏洞', content: 'ZZF2BMARKER', findingType: 'vuln',
  }, agent);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  const doc = graphDoc(cwd);
  const fact = (doc.facts ?? []).find((f) => String(f.content ?? '').includes('ZZF2BMARKER'));
  assert.ok(fact, `未过期草稿也应被兜底收束：\n${graphText(cwd)}`);
  assert.equal(fact.findingType, 'vuln', `findingType 实际=${JSON.stringify(fact.findingType)}`);
  assert.doesNotMatch(String(fact.title ?? ''), /草稿过期后补交/, '未过期不得冒充补交');
});

/* ==================================================================== F3 */

test('F3-a：8 条过期草稿（每 step 一条）全部补交落盘，一条不丢', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  const N = 8;
  await openSteps(host, agent, Array.from({ length: N }, (_, i) => ({
    stepId: `step_0${String(i + 1).padStart(2, '0')}`, action: `探路${i}`,
  })));

  for (let i = 0; i < N; i += 1) {
    const res = await host.callTool('fgs_submit_fact', {
      title: `草稿${i}`,
      content: `ZZF3MARK${i}END`,
      stepId: `step_0${String(i + 1).padStart(2, '0')}`,
    }, agent);
    assert.equal(res.ok, true, `submit_fact #${i} 应成功：${res.text}`);
    await sleep(12); // 越过 5ms TTL
    await host.callTool('fgs_status', {}, agent); // refreshRole → 过期回收
  }

  const before = countFacts(cwd);
  assert.equal(before, 1, `此刻图上只应有 fact_origin，实际 ${before}`);

  for (let i = 0; i < N; i += 1) {
    host.ctx.setTurn(100 + i); // 换回合，逐条补交
    const stepId = `step_0${String(i + 1).padStart(2, '0')}`;
    const closed = await host.callTool('fgs_commit_step', { stepId }, agent);
    assert.equal(closed.ok, true, `收束 ${stepId} 失败：${closed.text}`);
    const text = graphText(cwd);
    assert.match(text, new RegExp(`ZZF3MARK${i}END`),
      `第 ${i} 条过期草稿（${stepId}）必须被补交落盘，不得静默丢弃`);
  }

  const after = countFacts(cwd);
  assert.equal(after, 1 + N, `8 条草稿应各落一条 Fact（origin+8），实际 ${after}`);
  const text = graphText(cwd);
  for (let i = 0; i < N; i += 1) {
    assert.match(text, new RegExp(`草稿${i}\\b`), `草稿${i} 的标题必须保留`);
  }
  assert.doesNotMatch(text, /无有效产出/, '图里仍有内容可补交，不得谎报无有效产出');
});

test('F3-b：过期草稿只被消费一次，不会在后续回合被重复落盘', async () => {
  // 截断删除后数组会单调增长；这里攻击「takeExpiredDraft 是否只取一次」。
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  await openSteps(host, agent, [
    { stepId: 'step_001', action: 'a' },
    { stepId: 'step_002', action: 'b' },
  ]);
  for (let i = 0; i < 2; i += 1) {
    await host.callTool('fgs_submit_fact', {
      title: `草稿${i}`, content: `ZZF3BREP${i}`, stepId: `step_00${i + 1}`,
    }, agent);
    await sleep(12);
    await host.callTool('fgs_status', {}, agent);
  }
  host.ctx.setTurn(50);
  assert.equal((await host.callTool('fgs_commit_step', { stepId: 'step_001' }, agent)).ok, true);
  host.ctx.setTurn(51);
  assert.equal((await host.callTool('fgs_commit_step', { stepId: 'step_002' }, agent)).ok, true);
  host.ctx.setTurn(52);
  // step_001 已收束；再针对它 commit 应失败（step 不再 open），且不得把 ZZF3BREP0 再落一次
  const again = await host.callTool('fgs_commit_step', { stepId: 'step_001' }, agent);
  assert.equal(again.ok, false, `已收束的 step 不得再次落盘：${again.text}`);
  const text = graphText(cwd);
  const hits = text.match(/ZZF3BREP0/g) ?? [];
  assert.equal(hits.length, 1, `同一过期草稿只能落盘一次，实际出现 ${hits.length} 次`);
});

/* ==================================================================== F4 */

test('F4-a：cap=2 时兜底不得再收第 3 个（同回合实收 ≤ cap）', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 2 });
  await seed(host, agent);
  await openSteps(host, agent, [
    { stepId: 'step_001', action: 's1' },
    { stepId: 'step_002', action: 's2' },
    { stepId: 'step_003', action: 's3' },
  ]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2); // 避开「刚打开」保护
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  const over = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(over.ok, false, over.text);
  assert.match(over.text, /maxCommitsPerRound/);

  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.equal(countFacts(cwd), before, '达到 cap 后兜底不得再收束');
  const text = graphText(cwd);
  assert.doesNotMatch(text, /step_003 无有效产出/);
  assert.match(text, /state: "open"/, 'step_003 必须保持 open，留到下一回合');
});

test('F4-b（不变量 1）：本回合 0 次收束时，cap 不得把兜底整体关掉——仍必须落观察 Fact', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 2 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '没人做的 step' }]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  assert.equal(countFacts(cwd), 1, '起点只有 fact_origin');
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.equal(countFacts(cwd), 2, '0 次收束时回合收口仍必须落一条观察 Fact');
  assert.match(graphText(cwd), /无有效产出（观察）/);
});

test('F4-c（不变量 2）：turn 未知（limited=false）路径不做 cap 判断，保持原行为', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 1 });
  await seed(host, agent);
  await openSteps(host, agent, [
    { stepId: 'step_001', action: 's1' },
    { stepId: 'step_002', action: 's2' },
  ]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  assert.equal((await host.callTool('fgs_commit_step', { stepId: 'step_001' }, agent)).ok, true,
    'cap=1 时本回合第 1 次收束应成功');
  // 对照：turn 已知时，cap 已满 ⇒ 兜底必须拒绝
  const beforeLimited = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.equal(countFacts(cwd), beforeLimited,
    'turn 已知（limited=true）且 cap 已满时，兜底不得收束');
  // 移除 turn 投影 ⇒ turnOf 返回 null ⇒ limited=false（等价于信号兜底收尾路径）
  delete host.ctx.services.sessionProjections;
  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent });
  const after = countFacts(cwd);
  assert.equal(after, before + 1,
    'limited=false 时必须跳过 cap 判断（否则会话被硬卡住）——本回合已收 1 个仍应能兜底第 2 个');
});

test('F4-d【修复】cap=0 不得把本回合的第一次兜底一并关掉（不变量 1 保住）', async () => {
  // 旧断言（缺陷行为，F4 修复初期）：cap=0 时 forceCloseStep 里 0>=0 命中 ⇒ 0 次收束也不再落观察 Fact，
  // 且工具路径同样拒收 ⇒ 该 run 的 open step 永久孤儿。v4 的 D2 修复在 cap 判断上加 `cap > 0` 前置后，
  // 「本回合第 1 次兜底」不再被抑制；工具路径仍按 cap=0 拒收（与 commit_step 的既有语义保持对称）。
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 0 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: 's1' }]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.equal(countFacts(cwd), before + 1,
    'cap=0 已修：0 次收束的回合兜底仍必须落一条观察 Fact（不变量 1）');
  assert.match(graphText(cwd), /无有效产出（观察）/, '落的是显式观察 Fact');
  // 注：兜底落盘后该 step 已收束 ⇒ 角色翻回 Decide，此时再调 fgs_commit_step 会被**角色隔离**拒
  // （而非 cap 文案），故不再断言工具路径的 cap 文案，只断言 step 已被收束（不再 open）。
  assert.doesNotMatch(graphText(cwd), /state: "open"/, 'step_001 应已被收束，不再是 open');
});

test('F4-e：cap 取值在工具与兜底之间同源（Infinity 这类非有限值双双退化为 4）', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: Infinity });
  await seed(host, agent);
  await openSteps(host, agent, Array.from({ length: 6 }, (_, i) => ({
    stepId: `step_00${i + 1}`, action: `s${i}`,
  })));
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  for (let i = 0; i < 4; i += 1) {
    const r = await host.callTool('fgs_commit_step', {}, agent);
    assert.equal(r.ok, true, `第 ${i + 1} 次收束（cap 退化=4）应成功：${r.text}`);
  }
  const fifth = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(fifth.ok, false, `Infinity 被当作 4 处理，第 5 次必须被拒：${fifth.text}`);
  assert.match(fifth.text, /maxCommitsPerRound/);
  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.equal(countFacts(cwd), before, '兜底与工具同源：退化 cap=4，已满则兜底也不再收');
});

test('F4-f【边界】cap 是按「宿主 turn」记账的：turn 前进后兜底会按新回合重新计数', async () => {
  // 如实记录边界（非缺陷判定）：cap 的「回合」= observeRound(run, turnOf(...))。
  // 如果 turn-stopping 观测到的 turn 与 commit_step 时不同，commitsThisRound 被重置，
  // 兜底就能再收一个 —— 即 cap 不是 run-keyed，而是 turn-keyed。
  // 真实宿主中 turn-stopping 与同回合 commit 应拿到同一个 lastTurn，故此场景为人工构造。
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 2 });
  await seed(host, agent);
  await openSteps(host, agent, [
    { stepId: 'step_001', action: 's1' },
    { stepId: 'step_002', action: 's2' },
    { stepId: 'step_003', action: 's3' },
  ]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  const before = countFacts(cwd);
  host.ctx.setTurn(3); // 宿主 turn 真的前进（turn-stopping 读的是 sessionProjections，不是 payload.turn）
  host.emit('agent/turn-stopping', { agent, turn: 3 }); // turn 前进 ⇒ 被当作新回合
  const after = countFacts(cwd);
  assert.equal(after, before + 1,
    'turn 前进时 cap 重置并允许兜底再收一条（边界行为，非本轮缺陷判定）');
});

/* ==================================================================== F5 */

test('F5-a（F5 已回退）：四个网络/委派类默认被拒（白名单缺省），写进 decideAllowTools 即放行', async () => {
  // v4 曾把这四个工具加入 DEFAULT_DENIED_ENV_TOOLS，复核判定为越界改动并已回退。
  // 本用例锁定回退后的语义，并保留一条真正的不变量：bash/read 仍在硬拒清单里（写进白名单也不放行）。
  const allowed = ['web_fetch', 'web_search', 'subagent', 'workflow'];
  const def = boot();
  await seed(def.host, def.agent);
  for (const name of allowed) {
    const res = await def.host.callTool(name, {}, def.agent);
    assert.equal(res.ok, false, `默认配置下 ${name} 仍必须被拒：${res.text}`);
  }
  const ext = boot({ decideAllowTools: [...allowed, 'bash', 'read'] });
  await seed(ext.host, ext.agent);
  for (const name of allowed) {
    const res = await ext.host.callTool(name, {}, ext.agent);
    assert.ok(res.denied == null, `${name} 写进 decideAllowTools 后应放行（扩展位语义）：${res.text}`);
  }
  for (const name of ['bash', 'read']) {
    const res = await ext.host.callTool(name, {}, ext.agent);
    assert.equal(res.ok, false, `${name} 在硬拒清单里，写进白名单也必须被拒：${res.text}`);
    assert.equal(typeof res.denied, 'string', `${name} 应命中 deniedEnvTools 硬拒`);
    assert.match(res.text, /CONTRACT §4/);
  }
});

test('F5-b：普通工具的扩展位没有被整体废掉（自定义工具写进白名单仍真放行）', async () => {
  const { host, agent } = boot({ decideAllowTools: ['my_custom_tool', 'todo_write'] });
  await seed(host, agent);
  for (const name of ['my_custom_tool', 'todo_write']) {
    const res = await host.callTool(name, {}, agent);
    assert.ok(res.denied == null, `${name} 写进 decideAllowTools 后不应被拒：${res.text}`);
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /RAN/);
  }
  // 同一个陌生工具，不写进白名单时必须被拒 —— 证明放行来自「扩展位」而非「白名单失效」
  const other = boot();
  await seed(other.host, other.agent);
  const denied = await other.host.callTool('my_custom_tool', {}, other.agent);
  assert.equal(denied.ok, false, '未写进白名单的陌生工具必须仍被拒');
  assert.equal(typeof denied.denied, 'string');
});

test('F5-c【配置边界】：自定义 deniedEnvTools 会顶掉默认硬拒清单（逃生門如实记录）', async () => {
  // normalizeConfig: 只要 deniedEnvTools 非空数组就整体替换默认值。
  // ⇒ 显式传 deniedEnvTools:['bash'] 且 decideAllowTools 含 web_search 时，web_search 会放行。
  const { host, agent } = boot({
    deniedEnvTools: ['bash'],
    decideAllowTools: ['web_search'],
  });
  await seed(host, agent);
  registerFake(host, 'web_search');
  const res = await host.callTool('web_search', {}, agent);
  assert.ok(res.denied == null,
    '复现配置边界：自定义 deniedEnvTools 覆盖默认清单后，web_search 不再被硬拒');
  assert.equal(res.ok, true, res.text);
});

/* ==================================================================== F6a */

test('F6a-a：FGS_RULES 含顺序要求，且「放行/被拒」声明与 guard 行为逐项一致', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const rules = rulesText(host);

  // 顺序要求必须同时提到这两者，且不得夹带「会被拒」之类与 guard 打架的说法
  const orderLine = rules.split('\n').find((l) => l.includes('structured_output') && l.includes('fgs_submit_fact')
    && /之前/.test(l));
  assert.ok(orderLine, `FGS_RULES 缺少「先 fgs_submit_fact 再 structured_output」的顺序要求。原文:\n${rules}`);
  assert.doesNotMatch(orderLine, /会被拒|被拒绝|禁止调用/, '顺序要求不得写成「会被拒」（F1 后两类活动都放行）');

  // 声明「两类活动都放行」的出站工具 → guard 必须真的放行
  const egressLine = rules.split('\n').find((l) => l.includes('两类活动都放行') && l.includes('send_message'));
  assert.ok(egressLine, 'FGS_RULES 必须显式声明出站/汇报类工具两类活动都放行');
  const egressNames = [...egressLine.matchAll(/[a-z_]+/g)].map((m) => m[0])
    .filter((n) => ['send_message', 'present', 'structured_output'].includes(n));
  assert.ok(egressNames.length >= 3, `出站声明行没列全三个出站工具：${egressLine}`);
  for (const name of egressNames) {
    const res = await host.callTool(name, {}, agent);
    assert.ok(res.denied == null, `提示词说 ${name} 放行，guard 却拒了：${res.text}`);
    assert.equal(res.ok, true, res.text);
  }

  // 声明 Decide 禁止的环境工具（包括 以及 …。）→ guard 必须真的拒
  const envLine = rules.split('\n').find((l) => l.includes('包括') && l.includes('web_fetch'));
  assert.ok(envLine, 'FGS_RULES 必须列出 Decide 禁止的环境执行工具');
  assert.ok(!envLine.includes('structured_output'),
    'structured_output 是出站工具，绝不能出现在「禁止的环境工具」那一行（历史缺陷 A）');
  const envNames = [...envLine.matchAll(/[a-z_]+/g)].map((m) => m[0])
    .filter((n) => V4_DENIED.includes(n));
  assert.ok(envNames.length >= 3, `被拒声明行没解析出工具名：${envLine}`);
  for (const name of envNames) {
    const res = await host.callTool(name, {}, agent);
    assert.equal(res.ok, false, `提示词说 ${name} 会被拒，guard 却放行了：${res.text}`);
  }
});

test('F6a-b：顺序要求必须出现在**逐回合上下文**里（io-spec 注入恢复后的语义要求）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const decideText = graphContextText(host, agent);
  assert.match(decideText, /I\/O 预制规范/, 'io-spec 必须真的进逐回合上下文（§9 语义）');
  assert.match(decideText, /io-specs\/decide\.io\.yaml/);
  assert.match(decideText, /顺序：交 structured_output 之前/, `decide io-spec 顺序要求缺失:\n${decideText}`);
  assert.match(decideText, /fgs_commit/, 'decide io-spec 顺序要求应落到「先把图改动 commit 落盘」');

  await openSteps(host, agent, [{ stepId: 'step_001', action: 'a' }]);
  const executeText = graphContextText(host, agent);
  assert.match(executeText, /io-specs\/execute\.io\.yaml/);
  assert.match(executeText, /顺序：交 structured_output 之前必须先 fgs_submit_fact/,
    `execute io-spec 顺序要求缺失:\n${executeText}`);
});

/* ==================================================================== F6b / C 收尾 */

test('F6b-a：两个 io-spec YAML 能被插件自带 yaml.js 解析成功（loadIoSchema 不返回 null）', () => {
  for (const role of ['decide', 'execute']) {
    const raw = fs.readFileSync(new URL(`../io-specs/${role}.io.yaml`, import.meta.url), 'utf8');
    let doc;
    assert.doesNotThrow(() => { doc = loadYaml(raw); },
      `${role}.io.yaml 必须能被 yaml.js 解析（多行纯量会抛「YAML 缩进异常」）`);
    assert.ok(Array.isArray(doc?.notes), `${role}.io.yaml 的 notes 必须是数组`);
    assert.ok(doc.notes.some((n) => String(n).includes('structured_output')),
      `${role}.io.yaml notes 必须含顺序要求`);
  }
});

test('F6b-b：apply 时 loadIoSchema 不得静默降级（新增 console.warn 诊断不得触发）', async () => {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  let host; let agent;
  try {
    ({ host, agent } = boot());
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warns.filter((w) => w.includes('io-spec')), [],
    `io-spec 解析失败触发了诊断告警：${warns.join(' | ')}`);
  await seed(host, agent);
  const text = graphContextText(host, agent);
  assert.match(text, /I\/O 预制规范/,
    'loadIoSchema 返回 null 时注入会消失——这里必须真的看到 io-spec 段');
});

test('F6b-c（§4 已回退）：扩展位示例恢复为 web_search，且它仍真的在测「扩展位」', async () => {
  // 回退记录：F5 曾把 web_search 加入硬拒清单，逼得 contract_fixes §4 迁移示例工具；
  // F5 回退后该用例已恢复 v3 原文（web_search），本用例独立复验它没有变成空转：
  // web_search 不在默认白名单里 ⇒ 只有 decideAllowTools 生效时才放行。
  const { host, agent } = boot({ decideAllowTools: ['web_search'] });
  await seed(host, agent);
  assert.ok(!V4_ALLOW.includes('web_search'), 'web_search 本就在默认白名单里 ⇒ 该用例会空转');
  assert.ok(!V4_DENIED.includes('web_search'), 'F5 已回退：web_search 不应在硬拒清单里');
  registerFake(host, 'web_search');
  const allowed = await host.callTool('web_search', {}, agent);
  assert.ok(allowed.denied == null, `写进 decideAllowTools 后必须放行：${allowed.text}`);
  assert.equal(allowed.ok, true, allowed.text);
  const other = boot();
  await seed(other.host, other.agent);
  registerFake(other.host, 'web_search');
  const denied = await other.host.callTool('web_search', {}, other.agent);
  assert.equal(denied.ok, false, '未写进白名单时必须拒（证明放行来自扩展位）');
});

test('F6b【脆弱性】：yaml.js 仍不支持多行纯量——io-spec notes 一旦换行会再次静默丢注入', () => {
  // §9 之所以一度全红，就是因为 notes 用了「多行纯量」而仓库自带 yaml.js 解析不了。
  // C 的收尾只是把文本改成单行，并没有让解析器变得鲁棒；这里把该脆弱性钉死。
  assert.throws(() => loadYaml('notes:\n  - 第一行\n    第二行\n'), /缩进/,
    'yaml.js 仍拒绝多行纯量（io-spec 作者必须写单行，否则注入静默消失）');
});

/* ==================================================================== 代次 */

test('代次自证：PLUGIN_GENERATION=15，BUILD_TAG 保留原关键子串', () => {
  assert.equal(PLUGIN_GENERATION, 16);
  for (const sub of ['cairn-v2', 'commit-per-step', 'orphan-visibility',
    'readonly-decide-tools', 'claim-opened', 'ctx-budget', 'egress-tools']) {
    assert.match(BUILD_TAG, new RegExp(sub.replace(/[+]/g, '\\+')), `BUILD_TAG 丢失子串 ${sub}`);
  }
  assert.match(BUILD_TAG, /^16\+/);
});
