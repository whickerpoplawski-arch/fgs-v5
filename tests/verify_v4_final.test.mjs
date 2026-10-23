/**
 * FGS v4 最终对抗性验证 G1 —— 回退干净性 + 保留修复有效性（独立第三方）。
 *
 * 立场（默认怀疑）：
 *   A. 「回退没退干净」——逐项与冻结基线 fgs-v3（源码 + 行为两种证据）对照；
 *   B. 「保留的修复其实没用」——F1/F2/F3/F4/D1/F6a/C 全部真跑（真实返回值 / 真实磁盘图）。
 *
 * 本文件只读仓库自身；冻结基线 fgs-v3 的相关产物已作为 tests/fixtures/fgs-v3-baseline.* 收进仓库，
 * 因此可移植（不再依赖仓库外的兄弟目录）。
 * 运行：node --test tests/verify_v4_final.test.mjs
 */
import test from 'node:test';
// 每次 boot 都注册一对 SIGTERM/SIGINT 监听（假宿主不自动清理），属脚手架噪声。
process.setMaxListeners(0);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

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

/* ============================================================ 基线源码读取
 * 口径说明：`DEFAULT_DENIED_ENV_TOOLS` / `BUILD_TAG` 没有 export，无法 import，
 * 因此从源码按「括号配平」抠数组字面量、按字符串字面量拼接抠 tag；同时把 v3 的
 * 冻结字面量硬编码一份，使断言不依赖 v3 目录是否存在（存在时再做一次交叉核对）。
 */
const V4_INDEX = new URL('../index.js', import.meta.url);
// 冻结基线 gen9 的源码/io-spec/旧测试已收进 tests/fixtures（与 fgs-v3 逐字节相同），测试自足可移植。
const V3_INDEX = new URL('./fixtures/fgs-v3-baseline.index.js', import.meta.url);
const V3_AVAILABLE = fs.existsSync(V3_INDEX)
  && fs.existsSync(new URL('./fixtures/fgs-v3-baseline.contract_fixes.mjs', import.meta.url));
const V3_SRC = V3_AVAILABLE ? fs.readFileSync(V3_INDEX, 'utf8') : '';

/** 从源码里取出 `const NAME = [ ... ]` 的数组字面量（括号配平，含 spread 名）。 */
function constArrayBlock(src, name) {
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

/** 解析数组字面量为字符串数组（递归展开 `...OTHER`）。 */
function resolveConst(src, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const block = constArrayBlock(src, name);
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

const V4_SRC = fs.readFileSync(V4_INDEX, 'utf8');
const V4_DENIED = resolveConst(V4_SRC, 'DEFAULT_DENIED_ENV_TOOLS');

/** 冻结基线 fgs-v3 的 DEFAULT_DENIED_ENV_TOOLS（逐字抄自 v3 源码，防「无 v3 目录就断言空转」）。 */
const V3_DENIED_FROZEN = [
  'bash', 'pwsh', 'bash_persistent', 'pwsh_persistent',
  'read', 'write', 'edit', 'glob', 'grep', 'ls', 'find', 'read_image', 'lsp', 'terminal_open',
];
/** F5/D7 曾加入、后按 §0 回退的 4 个网络/委派类；它们必须不在硬拒清单里。 */
const ROLLED_BACK_TOOLS = ['web_fetch', 'web_search', 'subagent', 'workflow'];

const sorted = (a) => [...a].sort();
const setDiff = (a, b) => a.filter((x) => !b.includes(x));

/** 取 `export const NAME = 'a' + 'b' ...;` 拼接出来的完整字符串。 */
function concatStringConst(src, name) {
  const at = src.indexOf(`export const ${name} = `);
  assert.ok(at >= 0, `源码里找不到 export const ${name}`);
  const end = src.indexOf(';', at);
  const head = src.slice(at, end);
  const parts = [...head.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(parts.length > 0, `${name} 未解析出字符串字面量`);
  return parts.join('');
}

/** 与 v3 逐字比较某段函数源码。 */
function functionSource(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, `源码里找不到 ${header}`);
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, `${header} 的结束括号找不到`);
  return src.slice(at, end + 2);
}

/* ============================================================ 脚手架（与既有测试同构） */

const HOST_TOOLS = [
  ...V4_DENIED,
  ...ROLLED_BACK_TOOLS,
  'structured_output', 'send_message', 'present',
  'my_env_tool', 'web_search',
];

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  for (const name of new Set(HOST_TOOLS)) {
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

function graphDoc(cwd, problemId = 'default') {
  return loadYaml(graphText(cwd, problemId));
}

function countFacts(cwd, problemId = 'default') {
  return (graphDoc(cwd, problemId).facts ?? []).length;
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

/* ==================================================================== A1 */

test('A1-源码：DEFAULT_DENIED_ENV_TOOLS 与 v3 集合完全相等（不许多、不许少）', () => {
  assert.deepEqual(sorted(V4_DENIED), sorted(V3_DENIED_FROZEN),
    `v4 硬拒清单与冻结基线不一致：多=${setDiff(V4_DENIED, V3_DENIED_FROZEN)} 少=${setDiff(V3_DENIED_FROZEN, V4_DENIED)}`);
  assert.equal(new Set(V4_DENIED).size, V4_DENIED.length, '清单里出现重复项');
  for (const t of ROLLED_BACK_TOOLS) {
    assert.ok(!V4_DENIED.includes(t), `F5 应已回退：${t} 不得出现在硬拒清单里`);
  }
  if (V3_AVAILABLE) {
    const v3 = resolveConst(V3_SRC, 'DEFAULT_DENIED_ENV_TOOLS');
    assert.deepEqual(sorted(V4_DENIED), sorted(v3), '源码级：与 fgs-v3/index.js 的集合必须逐项相等');
  }
});

test('A1-行为：硬拒成员即使写进 decideAllowTools 也被「环境执行工具」文案拒；4 个回退项写进白名单即放行', async () => {
  const all = [...V4_DENIED, ...ROLLED_BACK_TOOLS, 'my_env_tool'];
  // (1) 全部写进白名单：硬拒必须优先命中（文案区分：deniedEnvTools→「禁止环境执行工具」）
  const ext = boot({ decideAllowTools: all });
  await seed(ext.host, ext.agent);
  for (const name of V4_DENIED) {
    const res = await ext.host.callTool(name, {}, ext.agent);
    assert.equal(res.ok, false, `${name} 在硬拒清单里，写进白名单也必须被拒：${res.text}`);
    assert.match(res.text, /禁止环境执行工具/, `${name} 必须命中 deniedEnvTools 硬拒文案`);
  }
  for (const name of ROLLED_BACK_TOOLS) {
    const res = await ext.host.callTool(name, {}, ext.agent);
    assert.ok(res.denied == null, `${name} 不在硬拒清单（F5 已回退），写进白名单应放行：${res.text}`);
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /RAN/, `${name} 必须真的执行`);
  }
  // (2) 默认配置：硬拒成员与「白名单缺省被拒」的文案必须可区分
  const def = boot();
  await seed(def.host, def.agent);
  for (const name of V4_DENIED) {
    const res = await def.host.callTool(name, {}, def.agent);
    assert.equal(res.ok, false, `${name} 默认必须被拒`);
    assert.match(res.text, /禁止环境执行工具/, `${name} 默认应命中硬拒文案`);
  }
  for (const name of [...ROLLED_BACK_TOOLS, 'my_env_tool']) {
    const res = await def.host.callTool(name, {}, def.agent);
    assert.equal(res.ok, false, `${name} 默认（不在白名单）必须被拒`);
    assert.doesNotMatch(res.text, /禁止环境执行工具/,
      `${name} 只是「白名单缺省」被拒，绝不能是硬拒（F5 回退口径）`);
  }
});

/* ==================================================================== A2 */

test('A2-源码：draftSummary 过期分支与 v3 逐字相同（单条、无的多条亮数）', () => {
  const v4Fn = functionSource(V4_SRC, 'function draftSummary(run) {');
  if (V3_AVAILABLE) {
    const v3Fn = functionSource(V3_SRC, 'function draftSummary(run) {');
    assert.equal(v4Fn, v3Fn, 'draftSummary 与 v3 必须逐字相同（D6 多条亮数已回退）');
  }
  assert.doesNotMatch(v4Fn, /已回收\s*\d+\s*条草稿|已回收 N 条草稿/, 'draftSummary 源码里不得残留「已回收 N 条草稿」文案');
  assert.match(v4Fn, /上一条草稿已过 stepDraftTtlMs 被回收/, 'v3 单条文案必须保留');
});

test('A2-行为：单条过期草稿走 v3 单条文案，注入文本不出现「已回收 N 条草稿」', async () => {
  const { host, agent } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '探路' }]);
  await host.callTool('fgs_submit_fact', { title: '过期草稿', content: 'STALEMARK' }, agent);
  await sleep(40);
  await host.callTool('fgs_status', {}, agent); // refreshRole → 过期回收

  const text = graphContextText(host, agent);
  assert.match(text, /上一条草稿已过 stepDraftTtlMs 被回收/, `过期草稿文案丢失:\n${text}`);
  assert.match(text, /内容仍保留/, '必须亮出内容仍保留');
  assert.match(text, /fact\(step_001\)/, '必须带 stepId');
  assert.doesNotMatch(text, /已回收\s*\d+\s*条草稿/, 'D6 已回退，不得出现条数亮出');
  assert.doesNotMatch(text, /已回收 N 条/, '不得出现 D6 计划中的占位文案');
});

/* ==================================================================== A3 */

test('A3：两个 io-spec 的「硬拒/汇报通道」注释已消失，notes 只剩顺序要求 + 原 4 条', () => {
  for (const role of ['decide', 'execute']) {
    const raw = fs.readFileSync(new URL(`../io-specs/${role}.io.yaml`, import.meta.url), 'utf8');
    // 回退项：D3「硬拒不是地板/整体替换」、D4「汇报通道不是存储通道」、D7-extra 的 3 个图工具补列
    assert.doesNotMatch(raw, /汇报通道/, `${role}.io.yaml 不得残留 D4「汇报通道」注释`);
    assert.doesNotMatch(raw, /硬拒优先|硬拒不是地板|无条件优先/, `${role}.io.yaml 不得残留 D3「硬拒优先」注释`);
    assert.doesNotMatch(raw, /默认清单被整体替换/, `${role}.io.yaml 不得残留 D3 的「整体替换」措辞`);
    assert.doesNotMatch(raw, /fgs_claim_step\s*\/\s*fgs_add_subgoal/, `${role}.io.yaml 不得残留 D7-extra 的加列注释`);

    const doc = loadYaml(raw);
    assert.equal(doc.role, role, `${role}.io.yaml 的 role 必须正确`);
    assert.ok(Array.isArray(doc.notes), 'notes 必须是数组');
    assert.equal(doc.notes.length, 5, `${role}.io.yaml notes 应为「原 4 条 + 顺序要求」=5，实际 ${doc.notes.length}`);
    assert.match(String(doc.notes[4]), /^顺序：/, '第 5 条必须是顺序要求');
    assert.match(String(doc.notes[4]), /structured_output/, '顺序要求必须点名 structured_output');
    assert.ok(doc.tools.includes('structured_output'), `${role}.io.yaml 的 tools 必须保留 structured_output（F1 绑定）`);

    if (V3_AVAILABLE) {
      const v3doc = loadYaml(fs.readFileSync(new URL(`./fixtures/fgs-v3-baseline.${role}.io.yaml`, import.meta.url), 'utf8'));
      assert.deepEqual(doc.notes.slice(0, 4), v3doc.notes, `${role}.io.yaml 原有 4 条 notes 必须与 v3 逐字相同`);
      assert.deepEqual(setDiff(v3doc.tools, doc.tools), [], `${role}.io.yaml 相对 v3 不得删掉任何 tools`);
      assert.deepEqual(setDiff(doc.tools, v3doc.tools), ['structured_output'],
        `${role}.io.yaml 相对 v3 只允许新增 structured_output（D7-extra 已回退）`);
    }
  }
  // 顺序要求的角色正确性（io-spec 侧）：Decide=commit、Execute=submit_fact
  const decideNotes = loadYaml(fs.readFileSync(new URL('../io-specs/decide.io.yaml', import.meta.url), 'utf8')).notes.join('\n');
  const executeNotes = loadYaml(fs.readFileSync(new URL('../io-specs/execute.io.yaml', import.meta.url), 'utf8')).notes.join('\n');
  assert.match(decideNotes, /fgs_commit/, 'Decide 顺序要求必须落到 fgs_commit');
  assert.doesNotMatch(decideNotes, /fgs_submit_fact/, 'Decide notes 不得要求 fgs_submit_fact');
  assert.match(executeNotes, /fgs_submit_fact/, 'Execute 顺序要求必须落到 fgs_submit_fact');
});

/* ==================================================================== A4 */

test('A4：tests/contract_fixes.test.mjs 与 v3 逐字节相同，§4 仍是 web_search 示例', () => {
  const v4 = fs.readFileSync(new URL('./contract_fixes.test.mjs', import.meta.url));
  const v4text = v4.toString('utf8');
  const section = v4text.slice(
    v4text.indexOf('§4：decideAllowTools 可配置扩展白名单'),
    v4text.indexOf('§5'),
  );
  assert.match(section, /web_search/, '§4 必须用回 v3 的 web_search 示例');
  assert.doesNotMatch(section, /team_task_create/, 'C-2 的示例迁移（team_task_create）必须已回退');
  if (V3_AVAILABLE) {
    const v3 = fs.readFileSync(new URL('./fixtures/fgs-v3-baseline.contract_fixes.mjs', import.meta.url));
    assert.equal(
      createHash('sha256').update(v4).digest('hex'),
      createHash('sha256').update(v3).digest('hex'),
      'contract_fixes.test.mjs 必须与 v3 完全同一份（C-2 已整体回退）',
    );
    assert.ok(v4.equals(v3), '逐字节比较失败');
  }
});

/* ==================================================================== A5 */

test('A5：gen=14；BUILD_TAG 去掉 +deny-net-delegate 且保留 v3 全部 token', () => {
  assert.equal(PLUGIN_GENERATION, 16, 'PLUGIN_GENERATION 必须为 16');
  assert.match(BUILD_TAG, /^16\+/, 'BUILD_TAG 前缀必须是 16+');
  assert.ok(!BUILD_TAG.includes('deny-net-delegate'), `BUILD_TAG 仍含已回退标记: ${BUILD_TAG}`);
  const tokens = BUILD_TAG.split('+');
  assert.deepEqual(tokens.filter((t, i) => tokens.indexOf(t) !== i), [], 'BUILD_TAG token 重复');

  const v3Tag = concatStringConst(V3_SRC || V4_SRC, 'BUILD_TAG'); // v3 缺失时退化为无意义自比
  if (V3_AVAILABLE) {
    for (const tok of v3Tag.split('+')) {
      if (tok === '9') continue; // 代次位允许 9→10 变化
      assert.ok(tokens.includes(tok), `BUILD_TAG 丢失 v3 原有 token: ${tok}`);
    }
  }
  for (const tok of ['cairn-v2', 'commit-per-step', 'orphan-visibility', 'readonly-decide-tools',
    'claim-opened', 'ctx-budget', 'egress-tools']) {
    assert.ok(tokens.includes(tok), `BUILD_TAG 丢失关键 token: ${tok}`);
  }
  // 保留项 F3/F4 的标记应在
  assert.ok(tokens.includes('draft-no-loss'), 'F3 保留项标记 draft-no-loss 缺失');
  assert.ok(tokens.includes('cap-in-forceclose'), 'F4 保留项标记 cap-in-forceclose 缺失');
});

/* ==================================================================== B1 (F1) */

test('B1(F1)：structured_output 在 Decide/Execute 两类活动都真放行；bash Decide 拒、Execute 放行', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  // Decide（本会话无 open step）
  const d1 = await host.callTool('structured_output', {}, agent);
  assert.ok(d1.denied == null, `Decide 轮 structured_output 不应被拒: ${d1.text}`);
  assert.equal(d1.ok, true, d1.text);
  assert.match(d1.text, /structured_output RAN/, '必须真的执行，而不是只绕过守卫');
  const bashDecide = await host.callTool('bash', {}, agent);
  assert.equal(bashDecide.ok, false, `Decide 轮 bash 仍必须拒: ${bashDecide.text}`);
  assert.equal(typeof bashDecide.denied, 'string');
  // Execute（本会话持有 open step）
  await openSteps(host, agent, [{ stepId: 'step_001', action: '探路' }]);
  const e1 = await host.callTool('structured_output', {}, agent);
  assert.ok(e1.denied == null, `Execute 轮 structured_output 不应被拒: ${e1.text}`);
  assert.equal(e1.ok, true, e1.text);
  assert.match(e1.text, /structured_output RAN/);
  const bashExec = await host.callTool('bash', {}, agent);
  assert.ok(bashExec.denied == null, `Execute 轮 bash 应放行: ${bashExec.text}`);
  assert.equal(bashExec.ok, true, bashExec.text);
});

/* ==================================================================== B2 (F2) */

test('B2(F2)：过期草稿 + turn-stopping 兜底 ⇒ 图中 Fact 的 findingType === "vuln"（YAML 对象断言）', async () => {
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '探路' }]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2); // 避开「刚打开」保护
  const drafted = await host.callTool('fgs_submit_fact', {
    title: '漏洞发现', content: 'ZZG1F2MARK', findingType: 'vuln',
  }, agent);
  assert.equal(drafted.ok, true, drafted.text);
  await sleep(40);
  await host.callTool('fgs_status', {}, agent);
  host.emit('agent/turn-stopping', { agent, turn: 2 });

  const doc = graphDoc(cwd);
  const fact = (doc.facts ?? []).find((f) => String(f.content ?? '').includes('ZZG1F2MARK'));
  assert.ok(fact, `兜底补交的 Fact 必须落盘；图里没有 ZZG1F2MARK:\n${graphText(cwd)}`);
  assert.match(String(fact.title ?? ''), /草稿过期后补交/, '必须标明过期补交');
  assert.equal(fact.findingType, 'vuln', `findingType 必须原样保留，实际=${JSON.stringify(fact.findingType)}`);
  assert.notEqual(fact.findingType, 'info');
});

/* ==================================================================== B3 (F3) */

test('B3(F3)：8 条过期草稿全部能补交落盘（一条不丢）', async () => {
  const N = 8;
  const stepId = (i) => `step_0${String(i + 1).padStart(2, '0')}`;
  const { host, agent, cwd } = boot({ stepDraftTtlMs: 5 });
  await seed(host, agent);
  await openSteps(host, agent, Array.from({ length: N }, (_, i) => ({ stepId: stepId(i), action: `探路${i}` })));

  for (let i = 0; i < N; i += 1) {
    const res = await host.callTool('fgs_submit_fact', {
      title: `草稿${i}`, content: `ZZG1F3MARK${i}END`, stepId: stepId(i),
    }, agent);
    assert.equal(res.ok, true, `submit_fact #${i} 应成功: ${res.text}`);
    await sleep(15); // 越过 5ms TTL
    await host.callTool('fgs_status', {}, agent); // refreshRole → 过期回收
  }
  assert.equal(countFacts(cwd), 1, '此刻图上只应有 fact_origin');

  for (let i = 0; i < N; i += 1) {
    host.ctx.setTurn(100 + i);
    const closed = await host.callTool('fgs_commit_step', { stepId: stepId(i) }, agent);
    assert.equal(closed.ok, true, `收束 ${stepId(i)} 失败: ${closed.text}`);
  }
  const doc = graphDoc(cwd);
  assert.equal((doc.facts ?? []).length, 1 + N, `8 条草稿应各落一条 Fact（origin+8），实际 ${doc.facts.length}`);
  for (let i = 0; i < N; i += 1) {
    const found = (doc.facts ?? []).some((f) => String(f.content ?? '').includes(`ZZG1F3MARK${i}END`));
    assert.ok(found, `第 ${i} 条过期草稿（${stepId(i)}）必须落盘，不得静默丢弃`);
  }
  assert.doesNotMatch(graphText(cwd), /无有效产出/, '有草稿可补交时不得谎报无有效产出');
});

/* ==================================================================== B4 (F4) */

test('B4a(F4)：cap=2 时同回合实收 ≤ cap（兜底不得再收第 3 个）', async () => {
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
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.equal(countFacts(cwd), before, '达到 cap 后兜底不得再收束（同回合实收 ≤ cap）');
  const text = graphText(cwd);
  assert.doesNotMatch(text, /step_003 无有效产出/);
  assert.match(text, /state: "open"/, 'step_003 必须保持 open，留到下一回合');
});

test('B4b(F4-不变量1)：本回合 0 次收束时，cap 不得把兜底关掉——仍必须落观察 Fact', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 2 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '没人做的 step' }]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.equal(countFacts(cwd), before + 1, '0 次收束时回合收口仍必须落一条观察 Fact');
  assert.match(graphText(cwd), /无有效产出（观察）/);
});

test('B4c(F4-d 翻转)：cap=0 不再抑制本回合的第一次兜底', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 0 });
  await seed(host, agent);
  await openSteps(host, agent, [{ stepId: 'step_001', action: '没人做的 step' }]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.equal(countFacts(cwd), before + 1,
    'cap=0 已修：`cap > 0` 前置使 0 次收束的回合兜底仍必须落观察 Fact（不变量 1）');
  assert.match(graphText(cwd), /无有效产出（观察）/);
});

test('B4d(F4-不变量2)：turn 未知（limited=false）路径不受 cap 影响', async () => {
  const { host, agent, cwd } = boot({ maxCommitsPerRound: 1 });
  await seed(host, agent);
  await openSteps(host, agent, [
    { stepId: 'step_001', action: 's1' },
    { stepId: 'step_002', action: 's2' },
  ]);
  host.ctx.setTurn(1);
  host.ctx.setTurn(2);
  assert.equal((await host.callTool('fgs_commit_step', { stepId: 'step_001' }, agent)).ok, true, 'cap=1 第 1 次收束应成功');
  // limited=true 且 cap 已满 ⇒ 兜底必须拒
  const beforeLimited = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent, turn: 2 });
  assert.equal(countFacts(cwd), beforeLimited, 'turn 已知且 cap 已满时兜底不得收束');
  // 移除 turn 投影 ⇒ turnOf 返回 null ⇒ limited=false（等价信号兜底收尾路径）
  delete host.ctx.services.sessionProjections;
  const before = countFacts(cwd);
  host.emit('agent/turn-stopping', { agent });
  assert.equal(countFacts(cwd), before + 1, 'limited=false 必须跳过 cap 判断，仍能兜底');
});

/* ==================================================================== B5 (D1/F6a) */

test('B5(D1/F6a)：注入文本按角色分述——Decide 段不得要求 fgs_submit_fact 且须 fgs_commit 落盘；Execute 段须 submit_fact', () => {
  const { host } = boot();
  const rules = rulesText(host);
  const anchor = '- 本会话持有（owner = 本会话）一个 open step → Execute';
  const at = rules.indexOf(anchor);
  assert.ok(at > 0, 'fgs-rules 必须含 Execute 段落锚点');
  const decideSeg = rules.slice(0, at);
  const executeSeg = rules.slice(at);

  // Decide 段：不得把 fgs_submit_fact 写成「必须先做」（Decide 轮调用会被角色隔离硬拒）
  assert.doesNotMatch(decideSeg, /必须先 fgs_submit_fact/, 'Decide 段不得出现「必须先 fgs_submit_fact」');
  assert.doesNotMatch(decideSeg, /先\s*fgs_submit_fact\s*落草稿/, 'Decide 段不得要求先落草稿');
  assert.match(decideSeg, /必须先用 fgs_commit 把本轮图改动落盘/, 'Decide 段必须要求先用 fgs_commit 落盘');

  // Execute 段：必须要求先 fgs_submit_fact 落草稿
  assert.match(executeSeg, /必须先 fgs_submit_fact 落草稿/, 'Execute 段必须出现 submit_fact 顺序要求');
  assert.doesNotMatch(executeSeg, /必须先用 fgs_commit 把本轮图改动落盘/,
    'Execute 段不得复用 Decide 的措辞（角色不得串台）');

  // 每次交付 structured_output 的顺序要求都必须点名宿主语义原因
  assert.equal((rules.match(/宿主记录结构化输出后即视本 run 结束/g) ?? []).length, 2,
    '两类活动各应有 1 条「宿主记录后 run 结束」的原因句');
});

/* ==================================================================== B6 (C) */

test('B6(C)：io-spec 能被自带 yaml.js 解析，且 apply 后注入上下文真的出现完整【I/O 预制规范】', async () => {
  // 解析层：两个文件都必须 load 成功且结构完整
  const docs = {};
  for (const role of ['decide', 'execute']) {
    const raw = fs.readFileSync(new URL(`../io-specs/${role}.io.yaml`, import.meta.url), 'utf8');
    assert.doesNotThrow(() => { docs[role] = loadYaml(raw); },
      `${role}.io.yaml 必须能被 yaml.js 解析（多行纯量会抛「YAML 缩进异常」）`);
    assert.ok(docs[role] && Array.isArray(docs[role].notes), `${role}.io.yaml 结构不完整`);
  }
  // 行为层：注入文本必须出现该段，且 notes 全文（不是只出现标题）
  const { host, agent } = boot();
  await seed(host, agent);
  const decideText = graphContextText(host, agent);
  assert.match(decideText, /【I\/O 预制规范（decide，io-specs\/decide\.io\.yaml）】/,
    `Decide 注入必须含 io-spec 段（解析失败会整段消失）:\n${decideText}`);
  assert.match(decideText, /禁止: fgs_submit_fact, fgs_commit_step/, 'Decide forbidden_tools 必须注入');
  for (const note of docs.decide.notes) {
    assert.ok(decideText.includes(note), `Decide 注入缺少 note 原文: ${note}`);
  }

  await openSteps(host, agent, [{ stepId: 'step_001', action: 'a' }]);
  const executeText = graphContextText(host, agent);
  assert.match(executeText, /【I\/O 预制规范（execute，io-specs\/execute\.io\.yaml）】/,
    `Execute 注入必须含 io-spec 段:\n${executeText}`);
  assert.match(executeText, /一轮只吃一个 open step/, 'Execute 原有 note 必须注入');
  for (const note of docs.execute.notes) {
    assert.ok(executeText.includes(note), `Execute 注入缺少 note 原文: ${note}`);
  }
  // 解析失败时 index.js 会 console.warn；这里用「注入段存在」反证 loadIoSchema 没返回 null
  assert.doesNotMatch(executeText, /FGS 图读取失败/);
});

/* ==================================================================== C9 */

/** 多重集差：返回 cur 比 base 多出来的行（用于发现回退残余的注释/空行）。 */
function multisetExtras(base, cur) {
  const pool = new Map();
  for (const l of base.split('\n')) pool.set(l, (pool.get(l) ?? 0) + 1);
  const extras = [];
  for (const l of cur.split('\n')) {
    const n = pool.get(l) ?? 0;
    if (n > 0) pool.set(l, n - 1);
    else extras.push(l);
  }
  return extras;
}

test('C9：残留自相矛盾扫描——真问题用 diagnostic 记录，io-spec 干净性判红', (t) => {
  const issues = [];

  // (1) CONTRACT.md 是否仍保留 §0 判为「已回退」的 D4 政策行
  const contract = fs.readFileSync(new URL('../CONTRACT.md', import.meta.url), 'utf8');
  const d4 = contract.split('\n').find((l) => l.includes('汇报通道不是存储通道'));
  if (d4) issues.push(`CONTRACT.md 仍保留 §0 判为「已回退」的 D4 行: ${d4.trim().slice(0, 90)}…`);

  // (2) V4_CHANGES.md 抬头（§0 之前）是否仍写带 +deny-net-delegate 的 BUILD_TAG
  const changes = fs.readFileSync(new URL('../docs/V4_CHANGES.md', import.meta.url), 'utf8');
  const head = changes.split('\n').slice(0, 14).find((l) => l.includes('BUILD_TAG ='));
  if (head && head.includes('deny-net-delegate')) {
    issues.push('V4_CHANGES.md 抬头 BUILD_TAG 仍含 +deny-net-delegate（实际代码已去掉，§0 第 35 行自相矛盾）');
  }

  // (3) verify_v4_adversarial.test.mjs 头部注释是否仍宣称 F5「仍硬拒」（与该文件 F5-a 用例互斥）
  const va = fs.readFileSync(new URL('./verify_v4_adversarial.test.mjs', import.meta.url), 'utf8');
  const f5head = va.split('\n').find((l) => /^\s*\*\s*F5\s/.test(l));
  if (f5head && f5head.includes('仍硬拒')) {
    issues.push(`verify_v4_adversarial.test.mjs 头部注释仍称 F5「仍硬拒」，而 F5-a 断言「即放行」: ${f5head.trim()}`);
  }

  // (4) io-spec 相对 v3 是否残留纯空注释行（D3 回退残余）
  if (V3_AVAILABLE) {
    for (const role of ['decide', 'execute']) {
      const base = fs.readFileSync(new URL(`./fixtures/fgs-v3-baseline.${role}.io.yaml`, import.meta.url), 'utf8');
      const cur = fs.readFileSync(new URL(`../io-specs/${role}.io.yaml`, import.meta.url), 'utf8');
      for (const extra of multisetExtras(base, cur)) {
        if (/^\s*#\s*$/.test(extra)) issues.push(`${role}.io.yaml 残留空注释行（D3 回退残余）: ${JSON.stringify(extra)}`);
      }
    }
  }

  for (const i of issues) t.diagnostic(`[残留] ${i}`);
  if (issues.length === 0) t.diagnostic('[残留] 未发现（若你看到本行，说明上面几条确实都干净了）');

  // 判红项：io-spec 自身必须干净（回退项若重新出现在 io-spec 即为回归）
  for (const role of ['decide', 'execute']) {
    const raw = fs.readFileSync(new URL(`../io-specs/${role}.io.yaml`, import.meta.url), 'utf8');
    assert.doesNotMatch(raw, /汇报通道|硬拒优先|已回收/, `${role}.io.yaml 残留回退项`);
  }
});
