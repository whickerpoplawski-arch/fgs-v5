/**
 * fgs-deepseek — DSH 原生插件（Host 半）。
 *
 * 把 CONTRACT.md 的 FGS 黑板接进 DeepSeek Harness：
 *   - 单写者 Controller + YAML 图持久化（controller/）
 *   - 写图强制过 hooks（hooks/validate_write）+ FLAG 外部校验（hooks/flag_verify）
 *   - Decide / Execute 双 toolset，按图状态自动切换角色并物理隔离（CONTRACT §4、§5）
 *   - 每步运行时上下文注入最新图投影（hooks/sync_context，CONTRACT §9）
 *
 * 会话 ≠ 项目：一场比赛落在 workspace 的 `.fgs/`，每道题一个
 * `.fgs/projects/<problemId>/`（独立图、workspace、run）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  Controller,
  GraphStore,
  WriteRejected,
} from './controller/index.js';
import { ProjectRegistry } from './controller/projects.js';
import {
  addSubGoalOp,
  changePriorityOp,
  claimStepOp,
  dropSubGoalOp,
  dropStepOp,
  openStepOp,
  reopenOp,
  satisfyGoalOp,
  seedOriginOp,
  submitFactOp,
} from './controller/ops.js';
import { makeVerifyHook } from './hooks/flag_verify.js';
import { roleContextText, roleLabel } from './hooks/sync_context.js';
import { preflight } from './hooks/validate_write.js';
import { truncateOutput } from './env/windows.js';
import { load as loadYaml } from './yaml.js';

/** 稳定 Loader 身份。 */
export const name = 'fgs-deepseek';

/**
 * 运行代次标记：只用于确认「磁盘上的新代码是否已被 Host 真正加载」。
 * 改代码后如果 /fgs/state 报的还是旧代次，说明进程仍跑着旧模块（需要重启/重载）。
 */
export const PLUGIN_GENERATION = 9;

/**
 * 面向人的构建标识：每次改动都必须往上滚一格。
 * 只用 PLUGIN_GENERATION 不够——重启会把当时代次加载成「当前」，
 * 之后再改代码，重启前后代次相同就区分不出新旧了（本项目踩过一次）。
 * `/fgs/state` 会原样返回 buildTag，重启后 curl 一眼即可确认新代码生效。
 */
export const BUILD_TAG = '9+cairn-v2+commit-per-step+orphan-visibility'
  + '+readonly-decide-tools+claim-opened+ctx-budget+egress-tools';

/** 本插件只硬依赖 tools；其余服务可选接入。 */
export const inject = ['tools'];

/* ------------------------------------------------------------- 常量 / 配置 */

const CONTROL_TOOLS = ['fgs_seed', 'fgs_status'];
/**
 * Project 控制面（建题 / 换题 / 列题）。
 * 它不能进 GRAPH_TOOL_NAMES 的「没有活动 Project 就拒」分支——没有活动 Project 时
 * 恰恰是唯一需要调用它的时刻。所以 guard 对它无条件放行（任何角色、任何状态）。
 */
const PROJECT_TOOLS = ['fgs_project'];
const DECIDE_TOOLS = [
  'fgs_open_step',
  'fgs_claim_step',
  'fgs_drop_step',
  'fgs_add_subgoal',
  'fgs_drop_subgoal',
  'fgs_change_step_priority',
  'fgs_preview',
  'fgs_commit',
  'fgs_satisfy_goal',
  'fgs_reopen',
];
const EXECUTE_TOOLS = ['fgs_submit_fact', 'fgs_commit_step'];

/**
 * v2（Cairn_Y）：Decide 的职责是「在一个任务开始时，或者图上信息有增加或者变化时」
 * **对 Step 做添加 / 废弃 / 优先级调整**，并「提出和删除 Sub Goal」——这些事情
 * 必然发生在**有 open step 的时候**。所以这些「操作 FGS 图」的工具不能只在 Decide 放行，
 * 否则会话一旦持有 step 就再也不能补规划，图会僵死。
 *
 * 它们只动**共享记忆（FGS 图）**，不动世界状态；真正需要物理隔离的是 §4：
 * **没有派发到 Step 的会话，不得使用环境执行工具**（bash/write/web/委派…）。
 * Decide 独占保留 goal 级判断：satisfy_goal / reopen。
 */
export const GRAPH_MUTATION_TOOLS = [
  'fgs_open_step',
  'fgs_claim_step',
  'fgs_drop_step',
  'fgs_change_step_priority',
  'fgs_add_subgoal',
  'fgs_drop_subgoal',
  'fgs_commit',
  'fgs_preview',
];
const GRAPH_TOOL_NAMES = [...CONTROL_TOOLS, ...DECIDE_TOOLS, ...EXECUTE_TOOLS];

/**
 * Execute 轮**真正**会被 guard 拒的图工具 = Decide 图工具集 − 两类活动都放行的图操作工具。
 * 唯一真源：由上面两个列表派生，绝不手写。sync_context 渲染进提示词的就是它，
 * 这样提示词与 tools.guard 永远一致 —— 历史上正是因为两处各写一份，才出现
 * 「提示词说会被拒、guard 其实放行」→ 模型自我审查、图操作事实上不可达的缺陷。
 */
export const EXECUTE_DENIED_GRAPH_TOOLS = DECIDE_TOOLS.filter((t) => !GRAPH_MUTATION_TOOLS.includes(t));

/** 角色可见 toolset（CONTRACT §4、§5）。 */
const ROLE_TOOLS = {
  decide: [...CONTROL_TOOLS, ...DECIDE_TOOLS],
  execute: [...CONTROL_TOOLS, ...EXECUTE_TOOLS],
};

/** Decide 会话禁止的环境执行工具（CONTRACT §4：禁止 bash 及一切环境执行工具）。 */
const DEFAULT_DENIED_ENV_TOOLS = [
  'bash',
  'pwsh',
  'bash_persistent',
  'pwsh_persistent',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'ls',
  'find',
  'read_image',
  'lsp',
  'terminal_open',
];

/**
 * Decide 轮**白名单**（CONTRACT §4：只做规划/改图）。
 *
 * 用白名单而不是「列举已知环境工具」：DSH 的工具面随 profile 变化，
 * 枚举永远漏（subagent/workflow 能间接起 bash，web_fetch/web_search 能出网）。
 * 这里列出的是「规划时仍然合理」的只读/元工具；其余一律在 Decide 被拒。
 * 环境执行需要先 fgs_open_step + fgs_commit 进 Execute 轮。
 *
 * **入站 vs 出站**（第三轮实测补充）：step 门禁真正要拦的是「能改变世界状态的入站工具」
 * （bash/文件/网络/subagent/workflow —— 它们能间接执行环境动作）。而 `send_message` /
 * `present` 是**出站/汇报类**工具：它们只搬运**已经产出**的信息，自身不能执行任何环境动作；
 * 接收方仍必须自己持有 step 才能碰环境。把出站工具一并禁掉会造成一个真实的协调死锁：
 *   - worker 一旦 `fgs_commit_step` 收束完手上最后一个 step，角色**自动翻回 Decide**，
 *     此刻它连「向父会话回报结果」都做不到（两个独立 agent 各自实测撞上同一拒绝，
 *     其中一个被迫多开了一个纯粹「为了获准说话」的空转 step）；想不到这一步 ⇒ 结果静默丢失，
 *     而插件侧只留一条 Decide 拒绝、看不出子代理其实已经完工。
 *   - Planner 也无法唤醒空闲/新起的 worker。
 * 故出站类工具在两类活动都放行（它们不动世界状态，符合 §4 的本意）。
 */
const EGRESS_TOOLS = ['send_message', 'present'];

/**
 * v3（缺陷 J 的补全）：Decide 的判定原则从「白名单里没有就拒」改成
 * **只有「能改变外部世界」的工具才拒**。§4 的本意是「Decide 不做环境动作」，
 * 而不是「Decide 连只读和规划类工具都不能用」。
 * 真实轨迹证据（4 例）：Decide 轮里 get_goal / create_goal 这类**宿主控制面只读或规划工具**
 * 被白名单连坐拒绝，模型只好开一个纯为「获准说话」的空转 step 绕过去。
 */
const READONLY_CONTROL_TOOLS = [
  'get_goal',
  'list_agents',
  'team_task_list',
  'team_task_get',
  'job_list',
  'job_output',
];
/** 规划/会话控制面：只动宿主自己的 goal/待办，不动靶场与文件系统。 */
const PLAN_CONTROL_TOOLS = [
  'todo_write',
  'skill',
  'ask_user_question',
  'exit_plan_mode',
  'create_goal',
  'update_goal',
];

const DEFAULT_DECIDE_ALLOW_TOOLS = [
  ...PLAN_CONTROL_TOOLS,
  ...READONLY_CONTROL_TOOLS,
  'cordis_inspect_list',
  'cordis_inspect_query',
  ...EGRESS_TOOLS,
];

const DEFAULT_CONFIG = Object.freeze({
  stateDir: '.fgs',
  factContentMaxBytes: 8 * 1024,
  factTitleMaxChars: 120,
  verifyMode: 'regex',
  // 真实竞赛（百度）用小写 flag{...}；早期默认是全大写且无 i，导致真 flag 也被硬门拒收。
  flagPattern: 'flag\\{[^}\\s]{4,}\\}',
  flagFlags: 'i',
  expectedFlag: '',
  verifyCommand: '',
  deniedEnvTools: DEFAULT_DENIED_ENV_TOOLS,
  decideAllowTools: DEFAULT_DECIDE_ALLOW_TOOLS,
  maxResultChars: 8_000,
  exposeHttpState: true,
  httpPath: '/fgs/state',
  // Cairn《无径之径》§系统架构：「Intent 认领有心跳超时与自动释放」。
  // stepLeaseMs = 认领租约；超期即视为可被**其他**会话重新认领（自动释放）。
  // stepDraftTtlMs = 未收束草稿的存活上限；超期在 refreshRole 时清理，防僵尸草稿。
  stepLeaseMs: 30 * 60 * 1000,
  stepDraftTtlMs: 60 * 60 * 1000,
  // v2：Finding = 搜索过程的结构化产物；类型**可动态定义**。
  // 留空数组 = 不限制取值（自由定义）；给定 = 白名单。
  findingTypes: [],
  // v2 上下文预算：Execute 轮注入「因果邻域投影」的字符上限。
  // 图是只追加的 ⇒ 若按整图注入，每个回合的上下文成本会单调增长（实测会让模型
  // 主动少碰黑板），这里给出硬上限 + 显式截断标记。见 GraphStore.focused()。
  injectMaxChars: 24000,
  // v3（缺陷 I 二阶效应）：单回合内**允许收束多少个不同的 step**。
  // 旧语义是「一回合只能收束一个 step」，实测让做完第二题的 worker 无处落盘，
  // 于是它绕开黑板（结果只写磁盘、flag 直接刷分）——唯一真记忆与真实进展脱钩。
  // 现在改为「同一 step 每回合至多一次 + 每回合总上限 N」，既不再逼人绕过黑板，
  // 又保留「单个 run 不许无限膨胀」的原意。
  maxCommitsPerRound: 4,
});

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

const FGS_RULES = [
  '## FGS 黑板（fgs-deepseek）',
  '',
  '本项目使用 FGS 黑板：事实(Fact) → 步骤(Step) → 新事实(Fact)。Goal 不连边，只被 satisfy_goal 引用。',
  '图是唯一真记忆，按题隔离在 workspace 的 .fgs/projects/<problemId>/graph.yaml；顶层键只有 facts/goals/steps。',
  '建题/换题用 fgs_project（action=new|switch|list；new 时给 brief 就直接种题），人也可以打 /fgs new <problemId> [brief]。',
  '磁盘上已种题的 Project 会被自动认领（重启/换会话后不用重新种题）；没有活动 Project 时不能改图。',
  '',
  '角色由图的 open step 自动决定，工具集随之切换（越权调用在 dispatch 层被硬拒）：',
  '- 本会话**没有被派发到的**（owner ≠ 本会话的）open step → Decide：只做规划/改图，禁止环境执行工具，',
  '  包括 bash/read/write/edit/glob/grep 以及 web_fetch/web_search/subagent/workflow。',
  `  出站/汇报类工具（${EGRESS_TOOLS.join(' / ')}）**两类活动都放行**：`,
  '  它们只搬运已产出的信息、不能执行环境动作；因此收束完最后一个 step 后仍可向父会话回报结果。',
  `  用 ${DECIDE_TOOLS.join(' / ')} 记草稿，`,
  '  最后用 fgs_commit 一次性提交（草稿为空时 commit 可传 operations[] 批量）。',
  '  注意：接手别人的 step 必须**显式** fgs_claim_step（v2 起不再隐式认领）。',
  '- 本会话持有（owner = 本会话）一个 open step → Execute：一轮只推进一个 open step，用 fgs_submit_fact 落新 Fact，',
  '  再用 fgs_commit_step 收束；无产出也必须落一条显式失败/观察 Fact。',
  `  图操作工具（${GRAPH_MUTATION_TOOLS.join(' / ')}）在两类活动**都放行**`,
  '  （它们只动共享记忆/图，不动世界状态）；',
  `  Execute 下只有 goal 级工具 ${EXECUTE_DENIED_GRAPH_TOOLS.join(' / ')} 会被拒。`,
  '',
  '任务派发（Cairn 语义）：step 由「开它的会话」持有（owner）；未认领或租约过期的 step 可被任何会话认领。',
  '一个会话绝不去收束别的会话持有的 step —— 这正是「黑板因果链错位」的根因，已在协议层拒写。',
  '',
  'v2 Cairn_Y 语义：FGS 图 = Fact（当前世界状态）/ Goal（搜索的终止条件，**含可动态增删的 Sub Goal**）',
  '  / Step（如何从已有事实产生新事实的因果过程）；**图只追加**（删除即标记 dropped，不删历史）。',
  'Finding = 搜索过程的结构化产物（渗透/代码审计类任务里就是漏洞）：用 fgs_submit_fact 的 findingType 标记。',
  '',
  '硬约束：',
  '- open_step 必须给 from（存在的 fact id）；step.from 为空直接拒写。',
  '- drop_step 必须给 reason；satisfy_goal 必须给 {goalId, reason, satisfiedBy}，缺一拒收。',
  '- Fact title ≤ 120 字；content 超过 8KiB 时必须写成产物文件路径（禁止把整页 HTML / nmap 全文塞进 fact）。',
  '- satisfy_goal 提交前必须过外部 FLAG 校验 hook，不过则不写 satisfied*。',
  '- reopen 清空 satisfied* 并追加 feedback Fact，永不删除历史。',
].join('\n');

/* --------------------------------------------------------------- 小工具 */

function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  cfg.deniedEnvTools = Array.isArray(cfg.deniedEnvTools) && cfg.deniedEnvTools.length > 0
    ? cfg.deniedEnvTools
    : DEFAULT_DENIED_ENV_TOOLS;
  return cfg;
}

function sessionIdOf(agent) {
  return agent?.id ?? agent?.session?.id ?? agent?.session?.header?.id ?? 'unknown';
}

function cwdOf(agent) {
  return agent?.session?.header?.cwd ?? agent?.cwd ?? process.cwd();
}

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

function ok(body) {
  return { ok: true, text: body };
}

function fail(body) {
  return { ok: false, text: body };
}

function toolResultSchema() {
  return {
    type: 'object',
    properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    required: ['ok', 'text'],
    additionalProperties: false,
  };
}

/* ---------------------------------------------------------- run 状态管理 */

function fgsRootOf(agent, cfg) {
  return path.resolve(cwdOf(agent), cfg.stateDir);
}

function hasCwd(agent) {
  return Boolean(agent?.session?.header?.cwd || agent?.cwd);
}

/** run 以 (sessionId, problemId) 为键，题与题的草稿/角色/回合互不共享。 */
function runKey(sessionId, problemId) {
  return `${sessionId}::${problemId}`;
}

function registryFor(agent, cfg, registries) {
  if (!hasCwd(agent)) return null;
  const root = fgsRootOf(agent, cfg);
  let registry = registries.get(root);
  if (!registry) {
    registry = new ProjectRegistry(root);
    registry.migrateLegacy();
    registries.set(root, registry);
  }
  return registry;
}

/** 磁盘上的图是否已种题。认领判断必须看磁盘，不能看内存里有没有 run。 */
function projectSeeded(registry, problemId, cfg) {
  try {
    const graph = new GraphStore(registry.projectRoot(problemId), cfg).load();
    return graph.facts.length > 0 || graph.goals.length > 0 || graph.steps.length > 0;
  } catch {
    return false;
  }
}

/**
 * 认领（attach）：图工具 / 状态查询 / 运行时上下文的统一入口。
 *
 * 为什么必须「按磁盘自动认领」：run 只在 create=true（fgs_seed / /fgs new）时建，
 * 而重启或换会话后内存里没有 run，磁盘上的 Project 却已经种好题。此时旧实现会：
 *   guard   → 「FGS 未启动：先 fgs_seed 种题，再使用图工具」
 *   fgs_seed→ 「已经种过题」并报错
 * 两句提示自相矛盾，只看错误信息的自主 agent 会卡死在这个循环里
 * （只有「对一个已报错的操作再重试一次」才偶然恢复）。
 *
 * reason 取值：no-cwd | no-project | detached | unseeded | attached | live
 * detached 只由 /fgs off 打上，用来挡住 /fgs off 之后的自动再认领。
 */
function attachRun(agent, cfg, runs, registries, detached, problemId = undefined) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return { registry: null, problemId: null, run: null, reason: 'no-cwd' };
  const explicit = problemId !== undefined && problemId !== null && String(problemId) !== '';
  const id = explicit ? registry.normalizeId(problemId) : registry.getActive();
  if (!id || !registry.isValidId(id) || !registry.exists(id)) {
    return { registry, problemId: id ?? null, run: null, reason: 'no-project' };
  }
  const key = runKey(sessionIdOf(agent), id);
  const live = runs.get(key) ?? null;
  if (live) {
    live.touchedAt = Date.now();
    return { registry, problemId: id, run: live, reason: 'live' };
  }
  if (detached?.has?.(key)) return { registry, problemId: id, run: null, reason: 'detached' };
  if (!projectSeeded(registry, id, cfg)) {
    return { registry, problemId: id, run: null, reason: 'unseeded' };
  }
  const run = runFor(agent, cfg, runs, registries, true, id);
  return { registry, problemId: id, run, reason: 'attached' };
}

/* ------------------------------------------- Project 控制面（命令 + 工具共用） */

/** 建立 Project；给了 brief 就顺带种题。命令 /fgs new 与 fgs_project 共用。 */
function projectNew(agent, cfg, runs, registries, detached, rawId, brief, extra = {}) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return { ok: false, text: '无法定位 workspace（agent 没有 cwd）。' };
  const id = registry.normalizeId(rawId);
  if (!registry.isValidId(id)) {
    return { ok: false, text: `problemId 非法: ${rawId ?? ''}（须为 [a-z0-9_-]{1,64}）` };
  }
  const existed = registry.exists(id);
  try {
    if (!existed) {
      const title = brief ? String(brief).split('\n')[0].slice(0, 120) : id;
      registry.create({ id, title });
    } else if (!brief) {
      return { ok: false, text: `Project 已存在: ${id}（换题用 fgs_project action=switch，或 /fgs switch ${id}）` };
    }
    registry.setActive(id);
  } catch (error) {
    return { ok: false, text: error.message };
  }
  detached?.delete?.(runKey(sessionIdOf(agent), id));
  if (!brief) return { ok: true, text: `已建立 Project ${id} → ${registry.projectRoot(id)}` };

  const fresh = runFor(agent, cfg, runs, registries, true, id);
  if (!fresh) return { ok: false, text: `无法启动 Project ${id}。` };
  fresh.reachable = true;
  const graph = fresh.store.load();
  if (graph.facts.some((f) => f.id === 'fact_origin')) {
    // 保留「同一个 Project 只种一次」的失败语义（/fgs init 重复调用依赖它）；
    // 关键是把出路写清楚：这时 run 已经认领，直接开 step 就行。
    refreshRole(fresh);
    return {
      ok: false,
      text: `已经种过题：${path.join(fresh.root, 'graph.yaml')} 已存在 fact_origin。`
        + `\nProject ${id} 已认领，直接用 fgs_open_step 继续推进即可。`,
    };
  }
  const content = extra.target ? JSON.stringify({ target: extra.target, brief }, null, 2) : brief;
  try {
    const next = fresh.controller.apply(
      seedOriginOp({
        title: '题目信息:',
        content,
        ...(extra.criterion ? { criterion: extra.criterion } : {}),
      }),
      graph,
    );
    fresh.controller.commit(next);
    syncProjectMeta(registry, fresh, next);
  } catch (error) {
    return { ok: false, text: `种题失败: ${error.message}` };
  }
  refreshRole(fresh);
  return { ok: true, text: `已种题 → ${path.join(fresh.root, 'graph.yaml')}` };
}

/** 切换活动 Project（磁盘已种题则顺带认领）。 */
function projectSwitch(agent, cfg, runs, registries, detached, rawId) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return { ok: false, text: '无法定位 workspace（agent 没有 cwd）。' };
  const id = registry.normalizeId(rawId);
  if (!id || !registry.exists(id)) return { ok: false, text: `Project 不存在: ${id}` };
  try {
    registry.setActive(id);
  } catch (error) {
    return { ok: false, text: error.message };
  }
  detached?.delete?.(runKey(sessionIdOf(agent), id));
  const { run } = attachRun(agent, cfg, runs, registries, detached, id);
  const seeded = projectSeeded(registry, id, cfg);
  const tail = seeded
    ? (run ? `已认领，角色 ${run.role === 'execute' ? 'Execute' : 'Decide'}` : '已种题')
    : '尚未种题，用 fgs_seed 种题';
  return { ok: true, text: `已切换活动 Project → ${id}（${tail}）。` };
}

/** 列出全部 Project 及其角色/进度。 */
function projectList(agent, cfg, runs, registries) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return { ok: false, text: '无法定位 workspace（agent 没有 cwd）。' };
  const items = registry.list();
  if (items.length === 0) {
    return { ok: true, text: '（无 Project）用 fgs_project action=new problemId=<id> brief=<题目> 建立。' };
  }
  const activeId = registry.getActive();
  const lines = items.map((item) => {
    const mark = item.id === activeId ? '*' : ' ';
    try {
      const store = new GraphStore(registry.projectRoot(item.id), cfg);
      const graph = store.load();
      const seeded = graph.facts.length > 0 || graph.goals.length > 0 || graph.steps.length > 0;
      const role = seeded ? roleLabel(derivedRole(graph)) : 'unseeded';
      const open = openStepsOf(graph).length;
      const satisfied = goalSatisfied(graph) ? 'yes' : 'no';
      return `${mark} ${item.id}  title=${item.title}  role=${role}  open=${open}  satisfied=${satisfied}  state=${item.state}`;
    } catch (error) {
      return `${mark} ${item.id}  [读取失败: ${error.message}]`;
    }
  });
  return { ok: true, text: lines.join('\n') };
}

function createRun(agent, cfg, registry, problemId) {
  const root = registry.projectRoot(problemId);
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const store = new GraphStore(root, cfg);
  const controller = new Controller(store, {
    verifyHook: makeVerifyHook(cfg),
    // 认领时的租约检查：被别的会话在租约内持有的 step 不得抢写。
    claimOptions: { leaseMs: cfg.stepLeaseMs ?? 0 },
    // v2「Finding 可以动态定义」：留空 = 自由定义；给定则限定取值。
    findingTypes: cfg.findingTypes ?? [],
  });
  return {
    sid: sessionIdOf(agent),
    problemId,
    root,
    fgsRoot: registry.root,
    workspaceDir: path.join(root, 'workspace'),
    store,
    controller,
    cfg,
    role: 'decide',
    decideDraft: [],
    execDraft: null,
    execDraftAt: null,
    currentStepId: null,
    reachable: false,
    touchedAt: Date.now(),
    roundSeq: 0,
    roundTurn: null,
    lastCommitRound: null,
    // v3：按 step 记账（而不是按回合一刀切）。
    committedRound: null,
    committedStepIds: new Set(),
    commitsThisRound: 0,
    stepsOpenedRound: null,
    stepsOpenedIds: null,
  };
}

/**
 * problemId 省略时取活动 Project。没有活动 Project 返回 null
 * （改图必须先 /fgs new 或 /fgs switch）。
 */
function runFor(agent, cfg, runs, registries, create = false, problemId = undefined) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return null;
  const explicit = problemId !== undefined && problemId !== null && String(problemId) !== '';
  const id = explicit ? registry.normalizeId(problemId) : registry.getActive();
  if (!id || !registry.isValidId(id) || !registry.exists(id)) return null;
  const key = runKey(sessionIdOf(agent), id);
  let run = runs.get(key);
  if (run) {
    run.touchedAt = Date.now();
    return run;
  }
  if (!create) return null;
  run = createRun(agent, cfg, registry, id);
  // 磁盘上可能已有图（迁移 / 重启后再 seed）：角色以图为准，不停留在默认 decide。
  try {
    refreshRole(run);
  } catch {
    /* 图损坏时仍交出 run，后续读会报错 */
  }
  runs.set(key, run);
  return run;
}

/**
 * 把宿主 turn 折进「本 run 自己的 roundSeq」。
 * 比对「一轮一步」只用 roundSeq，不拿全局 turn 数字当共享轴（G8）：
 * 同一会话里两道题即使看到同一个 turn，也各有各的 roundSeq / lastCommitRound。
 * turn 不可用时 limited=false，退化为不按回合硬拦（与旧行为一致）。
 * 方案 B 会改由编排器显式 +1；M1 仍用宿主 turn 作为本 run 的时钟输入。
 */
function observeRound(run, turn) {
  if (!Number.isFinite(turn)) return { round: run.roundSeq ?? 0, limited: false };
  if (run.roundTurn === null || run.roundTurn === undefined) {
    run.roundTurn = turn;
  } else if (run.roundTurn !== turn) {
    run.roundSeq = (run.roundSeq ?? 0) + 1;
    run.roundTurn = turn;
    // v3：进入新回合 ⇒ 清空本回合的收束记账（缺陷 I 二阶效应的修复）。
    run.committedRound = null;
    run.committedStepIds = new Set();
    run.commitsThisRound = 0;
  }
  return { round: run.roundSeq, limited: true };
}

function deriveProjectState(graph) {
  if (goalSatisfied(graph)) return 'solved';
  const facts = graph?.facts ?? [];
  const steps = graph?.steps ?? [];
  if (!facts.some((f) => f.id === 'fact_origin')) return 'created';
  if (steps.length === 0) return 'seeded';
  return 'running';
}

function syncProjectMeta(registry, run, graph) {
  if (!registry || !run) return;
  const state = deriveProjectState(graph);
  const prev = registry.readMeta(run.problemId) ?? {};
  registry.writeMeta(run.problemId, {
    id: run.problemId,
    title: prev.title ?? run.problemId,
    state,
    model: prev.model ?? null,
    budget: prev.budget ?? null,
    roundSeq: run.roundSeq ?? 0,
    createdAt: prev.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  registry.setProblemState(run.problemId, state);
}

function lastRun(runs) {
  let best = null;
  for (const run of runs.values()) {
    if (best === null || run.touchedAt > best.touchedAt) best = run;
  }
  return best;
}

function runsForSession(runs, sid) {
  const found = [];
  for (const run of runs.values()) {
    if (run.sid === sid) found.push(run);
  }
  return found;
}

function liveRun(runs, { sid, fgsRoot, problemId }) {
  let best = null;
  for (const run of runs.values()) {
    if (problemId && run.problemId !== problemId) continue;
    if (fgsRoot && run.fgsRoot !== fgsRoot) continue;
    if (sid && run.sid !== sid) continue;
    if (best === null || run.touchedAt > best.touchedAt) best = run;
  }
  return best;
}

/** 没有内存 run 时按磁盘图做只读快照（草稿为空）。 */
function diskSnapshot(registry, problemId, cfg) {
  const store = new GraphStore(registry.projectRoot(problemId), cfg);
  const meta = registry.readMeta(problemId);
  return graphSnapshot({
    sid: null,
    problemId,
    root: store.root,
    fgsRoot: registry.root,
    workspaceDir: path.join(store.root, 'workspace'),
    roundSeq: meta?.roundSeq ?? 0,
    store,
    reachable: false,
    currentStepId: null,
    decideDraft: [],
    execDraft: null,
    role: 'decide',
  });
}

function resolveHttpSnapshot({ runs, registries, cfg, sessionId, problemId }) {
  const sid = sessionId || null;
  const sessionRuns = sid ? runsForSession(runs, sid) : [];
  if (sid && sessionRuns.length === 0) return inactivePayload();

  let registry = null;
  if (sessionRuns.length > 0) registry = registries.get(sessionRuns[0].fgsRoot) ?? null;
  if (!registry) {
    const latest = lastRun(runs);
    if (latest) registry = registries.get(latest.fgsRoot) ?? null;
  }
  if (!registry) {
    for (const candidate of registries.values()) {
      if (candidate.getActive()) registry = candidate;
    }
  }

  if (problemId) {
    if (!registry) return inactivePayload();
    const id = registry.normalizeId(problemId);
    if (!registry.isValidId(id) || !registry.exists(id)) return inactivePayload();
    const run = liveRun(runs, { sid, fgsRoot: registry.root, problemId: id });
    return run ? graphSnapshot(run) : diskSnapshot(registry, id, cfg);
  }

  const activeId = registry?.getActive() ?? null;
  if (activeId) {
    const run = liveRun(runs, { sid, fgsRoot: registry.root, problemId: activeId });
    if (run) return graphSnapshot(run);
    if (!sid) return diskSnapshot(registry, activeId, cfg);
    return inactivePayload();
  }
  const fallback = sid ? (sessionRuns.sort((a, b) => b.touchedAt - a.touchedAt)[0] ?? null) : lastRun(runs);
  return fallback ? graphSnapshot(fallback) : inactivePayload();
}

function openStepsOf(graph) {
  return (graph.steps ?? [])
    .filter((s) => s.state === 'open')
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
      || String(a.createdAt).localeCompare(String(b.createdAt))
      || String(a.id).localeCompare(String(b.id)));
}

function goalSatisfied(graph) {
  const goal = (graph.goals ?? []).find((g) => g.id === 'goal_final');
  return Boolean(goal?.satisfiedAt);
}

function stepOwnerOf(step) {
  return step?.owner ?? null;
}

/** 该 step 是否仍被某个会话在租约内持有。 */
function claimFresh(step, now, leaseMs) {
  if (!stepOwnerOf(step)) return false;
  if (!(leaseMs > 0)) return true; // 租约关闭 ⇒ 视为一直持有
  const t = Date.parse(step?.claimedAt ?? '');
  if (!Number.isFinite(t)) return false;
  return now - t < leaseMs;
}

/**
 * 任务派发（Cairn《无径之径》§系统架构 / §Agent 间协调）：
 * 「Dispatcher 是协议的唯一写入者」「Intent 认领有心跳超时与自动释放」
 * 「Worker 没有身份，只有任务。任务从图里来，不从角色定义里来。」
 *
 * 本会话可分派的任务优先级：**自己已认领的 open step** > **未认领 / 租约已过期的 open step**。
 * 图上有 open step 但全部被其他会话在租约内持有时，本会话**没有任务** ⇒ 退回 Decide
 * （它可以去规划新 step，而不是被锁死在一个不属于它的 step 上）。
 */
function pickDispatchable(graph, sid, leaseMs, now = Date.now()) {
  const open = openStepsOf(graph);
  const mine = open.filter((s) => stepOwnerOf(s) === sid);
  if (mine.length) return { step: mine[0], kind: 'owned' };
  const free = open.filter((s) => !claimFresh(s, now, leaseMs));
  if (free.length) return { step: free[0], kind: 'claim' };
  return { step: null, kind: open.length > 0 ? 'held-by-others' : 'none' };
}

/** 认领一个 open step（写图，Controller 校验租约）。 */
function claimStep(run, graph, stepId) {
  const next = run.controller.apply(claimStepOp({ stepId, owner: run.sid }), graph);
  run.controller.commit(next);
  return next;
}

/**
 * 僵尸草稿回收：草稿是「跨回合保留」的（见 fgs_commit_step 的提示），
 * 但会话一旦结束就再也没人来收束它 —— 实测会留下永久僵尸草稿。
 * 这里按 stepDraftTtlMs 兜底清理，并在 run 上记 draftExpired 供面板显示。
 */
function expireStaleDraft(run, cfg) {
  if (!run.execDraft) return false;
  const ttl = cfg.stepDraftTtlMs ?? 0;
  if (!(ttl > 0)) return false;
  const at = run.execDraftAt ?? 0;
  if (at && Date.now() - at < ttl) return false;
  // v3（缺陷 M）：**过期 ≠ 丢弃**。真实代价实测过：草稿 05:47 提交 → 会话被挂起 →
  // 07:07 才轮到 commit_step，60min 的 stepDraftTtlMs 已把草稿清空 ⇒ 兜底落了一条
  // 「无有效产出（观察）」的 Fact，**黑板把模型已经交付的内容忘了，还谎报没产出**。
  // 现在把内容搬进 expiredDrafts：兜底收束会优先用它，上下文也会把内容亮出来供补交。
  if (!Array.isArray(run.expiredDrafts)) run.expiredDrafts = [];
  run.expiredDrafts.push({
    stepId: run.execDraft.stepId ?? run.currentStepId ?? null,
    title: run.execDraft.title,
    content: run.execDraft.content,
    findingType: run.execDraft.findingType ?? null,
    at,
  });
  if (run.expiredDrafts.length > 5) run.expiredDrafts.splice(0, run.expiredDrafts.length - 5);
  run.execDraft = null;
  run.execDraftAt = null;
  run.draftExpired = true;
  return true;
}

/** 取走某 step 最近一条**过期草稿**（v3 缺陷 M：过期内容要能被补交，而不是消失）。 */
function takeExpiredDraft(run, stepId) {
  if (!Array.isArray(run.expiredDrafts)) return null;
  for (let i = run.expiredDrafts.length - 1; i >= 0; i -= 1) {
    const d = run.expiredDrafts[i];
    if (stepId && d.stepId && d.stepId !== stepId) continue;
    run.expiredDrafts.splice(i, 1);
    return d;
  }
  return null;
}

/** 把过期草稿变成一条可落盘的 fact 草稿（标题加标记且**保证 ≤120 字**，否则会被 §7 拒收）。 */
function expiredDraftAsFact(d, stepId) {
  const prefix = '(草稿过期后补交) ';
  const raw = String(d.title ?? '');
  const room = Math.max(1, 118 - prefix.length);
  return {
    title: prefix + (raw.length > room ? `${raw.slice(0, room - 1)}…` : raw),
    content: d.content,
    stepId,
    findingType: d.findingType ?? null,
  };
}

/**
 * 角色 = f(图, 本会话)：**每轮重算，绝不缓存**。
 *
 * 旧实现在开 step 时把 run.role 定成 execute 之后就再没重算过；当该 step 被
 * **别的会话**收束（多代理拓扑下必然发生）时，这个会话就永久卡在 Execute：
 * fgs_open_step 被角色门拒绝（进不去）、fgs_submit_fact 因没有 open step 被拒（出不来）
 * —— 不可自愈死锁；同时因为不是 decide，§4「Decide 禁止环境工具」也就形同虚设。
 * 现在改为每次都由 (图, sid) 现算，并从图上认领任务，两个问题一并消除。
 */
function refreshRole(run) {
  const cfg = run.cfg ?? DEFAULT_CONFIG;
  const leaseMs = cfg.stepLeaseMs ?? 0;
  const graph = run.store.load();
  expireStaleDraft(run, cfg);
  const open = openStepsOf(graph);
  const mine = open.filter((s) => stepOwnerOf(s) === run.sid);
  if (mine.length > 0) {
    run.role = 'execute';
    run.currentStepId = mine[0].id;
    run.dispatch = 'owned';
    return graph;
  }
  // v2 关键：**没有派发给我的 Step 就是 Decide**，而不是「图上有 open step 就是 Execute」。
  // v2 说 Decide「在一个任务开始时，或者图上信息有增加或者变化时被触发」—— 也就是说
  // Decide 必须能在**有 open step 的情况下**照常运行（否则 Sub Goal / Step 增删这些
  // 「操作 FGS 图」的职责就永远没人能做，图会僵死）。
  // 认领（claim）**不再隐式发生**：接手别人的 Step 走显式的 fgs_claim_step，
  // 这样 Step↔Run 的绑定永远是一次可审计的显式派发（v1 Dispatcher 语义在这儿落地）。
  run.role = 'decide';
  run.currentStepId = null;
  const now = Date.now();
  run.dispatch = open.length === 0 ? 'none'
    : open.some((s) => !claimFresh(s, now, leaseMs)) ? 'claimable' : 'held-by-others';
  return graph;
}

function draftSummary(run) {
  // Execute 轮：本轮草稿是一条待写入的 Fact，必须让运行时上下文和 /fgs/state 都看得见，
  // 否则模型 submit_fact 之后在上下文里看不到自己刚落的草稿（/fgs/state 也显示 draft:""）。
  if (run.execDraft) {
    const d = run.execDraft;
    return `fact(${d.stepId}) «${truncateOutput(String(d.title ?? ''), 48)}»`;
  }
  // v3（缺陷 M）：过期的草稿内容还在 expiredDrafts 里，必须把它亮出来 ——
  // 只说「已过期回收」而藏起内容，模型就无法补交，等于内容仍然丢了。
  if (Array.isArray(run.expiredDrafts) && run.expiredDrafts.length > 0) {
    const d = run.expiredDrafts[run.expiredDrafts.length - 1];
    return `⚠️ 上一条草稿已过 stepDraftTtlMs 被回收，**内容仍保留**，下次 commit_step 会以`
      + `「(草稿过期后补交)」落盘：fact(${d.stepId}) «${truncateOutput(String(d.title ?? ''), 48)}»`;
  }
  if (!run.decideDraft.length) return '';
  return run.decideDraft.map((op, i) => `${i + 1}. ${op.type}`).join('; ');
}

/** Decide 白名单（CONTRACT §4）：FGS 规划工具 + 配置里声明的元工具，其余一律拒。 */
function decideAllows(cfg, tool) {
  return ROLE_TOOLS.decide.includes(tool) || (cfg.decideAllowTools ?? []).includes(tool);
}

/**
 * 当前回合号：读 DSH 的 `turnBoundary` 投影（dsh-tool-present 用同一入口）。
 * 服务不可用时返回 null —— 调用方退化为「不按回合限制」，绝不硬卡住会话。
 */
function turnOf(ctx, agent) {
  try {
    const projections = ctx.get?.('sessionProjections');
    const boundary = projections?.stateOf?.(agent?.session, 'turnBoundary');
    const turn = boundary?.lastTurn;
    return Number.isFinite(turn) ? turn : null;
  } catch {
    return null;
  }
}

/**
 * 读取预制 I/O 规范（CONTRACT §9）：把 io-specs/<role>.io.yaml 真的送进模型上下文，
 * 而不是只躺在仓库里当文档。
 */
function loadIoSchema(role) {
  try {
    const raw = readFileSync(new URL(`./io-specs/${role}.io.yaml`, import.meta.url), 'utf8');
    const doc = loadYaml(raw) ?? {};
    return {
      tools: Array.isArray(doc.tools) ? doc.tools.map(String) : [],
      forbidden: Array.isArray(doc.forbidden_tools) ? doc.forbidden_tools.map(String) : [],
      notes: Array.isArray(doc.notes) ? doc.notes.map(String) : [],
    };
  } catch {
    return null;
  }
}

/**
 * 角色隔离：只用 tools.guard 在 dispatch 层硬拒，不用 tools.restrict 做动态可见性。
 *
 * 实测（DSH 0.2.0-rc.2 / web profile）：对同一 agent scope 连续调用 restrict 时，
 * 后一次不会解除前一次的效果（限制是取交集的），一旦为了「未启动」隐藏了规划工具，
 * 会话进入 Decide 后那些工具就再也不可见了。角色是随图状态变化的，而 restrict
 * 无法可靠地「松开」，所以 schema 层永远保留全部 fgs_* 工具，越权调用由下面的
 * guard 硬拒并给出可执行的替代路径。契约要的是「拦」，guard 是顺序无关的硬拦。
 */

/* ------------------------------------------------------------- 图快照 */

/** 角色由「图」唯一决定（≥1 个 open step ⇒ Execute，否则 Decide）——不读内存缓存。 */
function derivedRole(graph) {
  return openStepsOf(graph).length > 0 ? 'execute' : 'decide';
}

/** 「本会话没在跑 FGS」的统一快照（Client 据此渲染「未启动」）。 */
function inactivePayload() {
  return {
    active: false,
    pluginGeneration: PLUGIN_GENERATION,
    buildTag: BUILD_TAG,
    updatedAt: new Date().toISOString(),
  };
}

function graphSnapshot(run) {
  const graph = run.store.load();
  const open = openStepsOf(graph);
  // 保留「图视角」的全局角色（≥1 个 open step ⇒ Execute），仅作对照，不驱动行为。
  const globalRole = derivedRole(graph);
  // 「本会话视角」：只认分派给本会话的任务。**只读、不认领**（面板会遍历所有会话查询，
  // 若在这里认领会替别的会话抢任务）。
  const cfg = run.cfg ?? DEFAULT_CONFIG;
  const leaseMs = cfg.stepLeaseMs ?? 0;
  const ownedStep = open.find((s) => stepOwnerOf(s) === run.sid) ?? null;
  const dispatch = pickDispatchable(graph, run.sid, leaseMs);
  const role = ownedStep ? 'execute' : 'decide';
  // 空图 = 本会话还没种题（或图文件被外部删除）：按「未启动」上报，
  // 让 Client 走它自己的「未启动」分支，而不是渲染成一条矛盾的黑板条。
  if (graph.facts.length === 0 && graph.goals.length === 0 && graph.steps.length === 0) {
    return inactivePayload();
  }
  return {
    active: true,
    pluginGeneration: PLUGIN_GENERATION,
    buildTag: BUILD_TAG,
    sessionId: run.sid,
    problemId: run.problemId ?? null,
    root: run.root,
    workspaceDir: run.workspaceDir ?? null,
    roundSeq: run.roundSeq ?? 0,
    role,
    roleLabel: roleLabel(role),
    // 观测面自证（原 D6）：把两个来源都亮出来，不一致时一眼可见。
    derivedRole: globalRole,
    roleDiverged: globalRole !== role,
    dispatch: dispatch.kind, // owned | claim | held-by-others | none
    reachable: run.reachable,
    satisfied: goalSatisfied(graph),
    currentStepId: run.currentStepId,
    ownedStepId: ownedStep?.id ?? null,
    draft: draftSummary(run),
    draftExpired: Boolean(run.draftExpired),
    subGoals: (graph.goals ?? []).filter((g) => g.kind === 'sub').map((g) => ({
      id: g.id, criterion: g.criterion, state: g.state ?? 'open', parentId: g.parentId ?? null,
    })),
    findings: (graph.facts ?? []).filter((f) => f.findingType)
      .map((f) => ({ id: f.id, title: f.title, findingType: f.findingType })),
    counts: {
      facts: graph.facts.length,
      goals: graph.goals.length,
      steps: graph.steps.length,
      open: open.length,
      openOwnedByMe: open.filter((s) => stepOwnerOf(s) === run.sid).length,
      openUnclaimed: open.filter((s) => !stepOwnerOf(s)).length,
      // v3（缺陷 K 的修复）：把「租约已过期的孤儿」单独计数。
      // 旧实现只给 openUnclaimed，租约过期的孤儿在**所有模型可读的表面**上都不计，
      // 实测导致 worker 跳过孤儿去领别的 step（孤儿饿死）——机制没问题，缺的是可见性。
      openTakeover: open.filter((s) => {
        const owner = stepOwnerOf(s);
        return Boolean(owner) && owner !== run.sid
          && !claimFresh(s, Date.now(), leaseMs);
      }).length,
      openOwnedByOthersFresh: open.filter((s) => {
        const owner = stepOwnerOf(s);
        return Boolean(owner) && owner !== run.sid
          && claimFresh(s, Date.now(), leaseMs);
      }).length,
    },
    facts: graph.facts.map((f) => ({ id: f.id, title: f.title })),
    goals: graph.goals.map((g) => ({
      id: g.id,
      kind: g.kind,
      satisfiedBy: g.satisfiedBy ?? null,
      satisfiedReason: g.satisfiedReason ?? null,
      satisfiedAt: g.satisfiedAt ?? null,
    })),
    steps: graph.steps.map((s) => ({
      id: s.id,
      action: s.action,
      from: s.from ?? [],
      state: s.state,
      priority: s.priority,
      to: s.to ?? null,
    })),
    updatedAt: new Date().toISOString(),
  };
}

/* --------------------------------------------------------------- 工具定义 */

function defineFgsTool({ toolName, description, parameters, run, cfg }) {
  const maxChars = cfg?.maxResultChars ?? 8_000;
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: toolResultSchema(),
      // CONTRACT §9：工具出参先裁噪声再进模型（io-specs 的 max_result_chars）
      render: (_args, value) => text(truncateOutput(value.text, maxChars)),
    },
    async execute(args, exec) {
      return run(args ?? {}, exec);
    },
  };
}

function registerTools(ctx, cfg, runs, registries, detached) {
  const disposers = [];
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition));
  };
  const makeTool = (spec) => defineFgsTool({ ...spec, cfg });

  const active = (exec) => {
    const run = runFor(exec?.agent, cfg, runs, registries, false);
    if (!run) {
      const registry = registryFor(exec?.agent, cfg, registries);
      if (!registry?.getActive()) {
        throw new Error('FGS 未启动：没有活动 Project。先 /fgs new <problemId> 或 /fgs switch <problemId>。');
      }
      throw new Error('FGS 未启动：先调用 fgs_seed（或 /fgs new <problemId> <brief> / /fgs init <brief>）种题。');
    }
    return run;
  };

  /* ---- 控制面 ---- */

  register(makeTool({
    toolName: 'fgs_seed',
    description: '在活动 Project 上种题：写入 fact_origin 与 goal_final。先 /fgs new <problemId>。同一个 Project 只种一次。',
    parameters: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: '题目原始信息（target、hint、约束）。若超过 8KiB 需改为文件路径。' },
        target: { type: 'string', description: '目标地址/入口（可选，会并入 origin fact）。' },
        title: { type: 'string', description: 'origin fact 标题，默认「题目信息:」。' },
        criterion: { type: 'string', description: 'goal_final 的完成判据。' },
      },
      required: ['brief'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      if (typeof args.brief !== 'string' || args.brief.trim() === '') {
        return fail('fgs_seed 需要非空 brief。');
      }
      const registry = registryFor(exec?.agent, cfg, registries);
      if (!registry?.getActive()) {
        return fail('FGS 未启动：没有活动 Project。先 fgs_project action=new problemId=<id>（或 /fgs new <id>）。');
      }
      const run = runFor(exec?.agent, cfg, runs, registries, true);
      if (!run) {
        return fail('FGS 未启动：没有活动 Project。先 fgs_project action=new problemId=<id>（或 /fgs new <id>）。');
      }
      detached.delete(runKey(run.sid, run.problemId));
      run.reachable = true;
      const graph = run.store.load();
      if (graph.facts.some((f) => f.id === 'fact_origin')) {
        // 保持「只种一次」的错误语义（/fgs init 重复调用依赖它），
        // 但补上出路：这时 run 已认领，直接开 step 即可，不必再纠结种题。
        refreshRole(run);
        return fail(`已经种过题：${path.join(run.root, 'graph.yaml')} 已存在 fact_origin。`
          + `\nProject ${run.problemId} 已认领，直接用 fgs_open_step 继续推进即可。`);
      }
      const content = args.target
        ? JSON.stringify({ target: args.target, brief: args.brief }, null, 2)
        : args.brief;
      const op = seedOriginOp({
        title: args.title || '题目信息:',
        content,
        ...(args.criterion ? { criterion: args.criterion } : {}),
      });
      try {
        const next = run.controller.apply(op, graph);
        run.controller.commit(next);
        syncProjectMeta(registry, run, next);
      } catch (error) {
        if (error instanceof WriteRejected) return fail(`种题拒收: ${error.message}`);
        throw error;
      }
      refreshRole(run);
      return ok(`已种题。图: ${path.join(run.root, 'graph.yaml')}\n当前角色: ${roleLabel(run.role)}`);
    },
  }));

  register(makeTool({
    toolName: 'fgs_status',
    description: '只读查看 FGS 黑板状态：角色、目标是否满足、facts/steps 计数与 open steps。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: (args, exec) => {
      // 契约外的参数一律显式报错。宿主不一定执行 JSON Schema 校验（实测中
      // {"action":"bad ref probe","from":["fact_999"]} 之类的垃圾入参被静默吞掉，
      // 模型便以为 fgs_status 能做查询，连续轮询同一个计数摘要，白白烧轮次）。
      const unknown = Object.keys(args ?? {});
      if (unknown.length > 0) {
        return fail(`fgs_status 不接受任何参数（收到: ${unknown.join(', ')}）。\n`
          + '它只返回计数摘要；要看图请用 fgs_preview（Decide 轮只读投影）。');
      }
      // 认领（attach）：磁盘已种题的 Project 直接建 run + refreshRole，
      // 不看「内存里有没有 run」——否则重启/换会话后会误报「尚未种题」。
      const { problemId, run, reason } = attachRun(exec?.agent, cfg, runs, registries, detached);
      if (reason === 'no-project') {
        return ok('FGS 未启动（没有活动 Project：先 fgs_project action=new problemId=<id> brief=<题目>，或 /fgs new <id>「题目」）。');
      }
      if (!run) {
        return ok(reason === 'detached'
          ? `FGS 未启动（本会话已 /fgs off；Project ${problemId} 与图文件仍在磁盘，`
            + `重新进入用 fgs_project action=switch problemId=${problemId}）。`
          : `FGS 未启动（Project ${problemId} 尚未种题）。`);
      }
      const graph = run.store.load();
      // 图被外部删除 → 与「从未种题」同义，别报着缓存角色说自己在 Execute
      if (graph.facts.length === 0 && graph.goals.length === 0 && graph.steps.length === 0) {
        return ok('FGS 未启动（图为空：尚未种题，或图文件已被移除）。');
      }
      // v2：Decide/Execute 是「独立运行过程」；这里给**本会话视角**（只读、不认领），
      // 并同时亮出「图视角」，两者不一致时一眼可见（原 D6 四面矛盾）。
      const owned = openStepsOf(graph).find((s) => stepOwnerOf(s) === run.sid) ?? null;
      const role = owned ? 'execute' : 'decide';
      const dispatch = pickDispatchable(graph, run.sid, cfg.stepLeaseMs ?? 0);
      const lines = [
        `Project: ${run.problemId}`,
        `角色: ${roleLabel(role)}`
          + (derivedRole(graph) !== role ? `（图视角=${roleLabel(derivedRole(graph))}；dispatch=${dispatch.kind}）` : ''),
        `图: ${path.join(run.root, 'graph.yaml')}`,
        `workspace: ${run.workspaceDir}`,
        `goal_final satisfied: ${goalSatisfied(graph) ? 'yes' : 'no'}`,
        `facts=${graph.facts.length} goals=${graph.goals.length} steps=${graph.steps.length} open=${openStepsOf(graph).length}`,
        `findings=${(graph.facts ?? []).filter((f) => f.findingType).length}`
          + ` subgoals=${(graph.goals ?? []).filter((g) => g.kind === 'sub' && g.state !== 'dropped').length}`,
      ];
      for (const g of (graph.goals ?? []).filter((x) => x.kind === 'sub')) {
        lines.push(`  subgoal ${g.id} [${g.state}] ${g.criterion}`);
      }
      for (const f of (graph.facts ?? []).filter((x) => x.findingType)) {
        lines.push(`  finding ${f.id} [${f.findingType}] ${f.title}`);
      }
      for (const step of openStepsOf(graph)) {
        // v2：Execute 是「被派发去推进某个 Step」。谁在推进、租约是否过期，必须可见。
        const owner = stepOwnerOf(step);
        const tag = !owner ? 'unclaimed'
          : owner === run.sid ? 'mine'
            : `held-by=${owner}${claimFresh(step, Date.now(), cfg.stepLeaseMs ?? 0) ? '' : ' (租约已过期,可接手)'}`;
        lines.push(`  open ${step.id} [${step.priority}] (${tag}) ${step.action}`);
      }
      const draft = draftSummary(run);
      if (draft) lines.push(`草稿: ${draft}`);
      if (run.draftExpired) lines.push('⚠️ 上一条未收束的草稿已按 stepDraftTtlMs 过期回收。');
      return ok(lines.join('\n'));
    },
  }));

  /* ---- Project 控制面（建题 / 换题 / 列题）---- */

  register(makeTool({
    toolName: 'fgs_project',
    description: '建题 / 换题 / 列题：一场比赛下按 problemId 隔离每道题的图、workspace 与回合。'
      + ' action=new 需 problemId（可选 brief/target/criterion，给了就直接种题）；'
      + ' action=switch 换活动题；action=list 列全部。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['new', 'switch', 'list'], description: '要做的操作。' },
        problemId: { type: 'string', description: 'action=new/switch 必填；规范化成 [a-z0-9_-]{1,64}。' },
        brief: { type: 'string', description: 'action=new 可选：题目原文；给了就顺带种题。' },
        target: { type: 'string', description: 'action=new 可选：目标地址/入口，并入 fact_origin。' },
        criterion: { type: 'string', description: 'action=new 可选：goal_final 完成判据。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const action = String(args.action ?? '');
      if (action === 'list') {
        const result = projectList(exec?.agent, cfg, runs, registries);
        return result.ok ? ok(result.text) : fail(result.text);
      }
      const rawId = args.problemId;
      if (typeof rawId !== 'string' || rawId.trim() === '') {
        return fail(`action=${action} 需要 problemId。`);
      }
      const result = action === 'new'
        ? projectNew(exec?.agent, cfg, runs, registries, detached, rawId, args.brief ?? '', {
          target: args.target,
          criterion: args.criterion,
        })
        : (action === 'switch'
          ? projectSwitch(exec?.agent, cfg, runs, registries, detached, rawId)
          : { ok: false, text: `未知 action: ${action}（可选 new | switch | list）` });
      return result.ok ? ok(result.text) : fail(result.text);
    },
  }));

  /* ---- Decide ---- */

  register(makeTool({
    toolName: 'fgs_preview',
    description: '只读投影当前图（fact 只给 id+title）并附未提交草稿。规划前先看这个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, exec) => {
      const run = active(exec);
      const graph = run.store.load();
      const parts = [run.store.preview(graph)];
      if (run.decideDraft.length) parts.push(`# 未提交草稿\n${draftSummary(run)}`);
      return ok(parts.join('\n\n'));
    },
  }));

  register(makeTool({
    toolName: 'fgs_open_step',
    description: '在草稿里开一个 step。from 必须是非空 fact id 列表（因果铁律）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '这一步要做什么（可执行、可验证的动作）。' },
        from: { type: 'array', items: { type: 'string' }, description: '本步骤依赖的 fact id 列表，不能为空。' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '默认 normal。' },
        actor: { type: 'string', description: '默认 agent。' },
        stepId: { type: 'string', description: '可选，预分配 step_NNN（batch commit 用）。' },
      },
      required: ['action', 'from'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      const op = openStepOp({
        action: args.action ?? '',
        from: args.from ?? [],
        actor: args.actor || 'agent',
        priority: args.priority || 'normal',
        stepId: args.stepId || null,
      });
      return stageDecideOp(run, op);
    },
  }));

  register(makeTool({
    toolName: 'fgs_drop_step',
    description: '在草稿里丢弃一个 open step。必须给 reason。',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: '要丢弃的 step id。' },
        reason: { type: 'string', description: '丢弃原因，不能为空。' },
      },
      required: ['stepId', 'reason'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, dropStepOp({ stepId: args.stepId, reason: args.reason }));
    },
  }));

  // v2 Cairn_Y：「Goal 描述项目的完成条件，即搜索的终止条件。**也存在可以动态增删的 Sub Goal**。」
  // Sub Goal 的增删属于「操作 FGS 图」，因此归 Decide。
  register(makeTool({
    toolName: 'fgs_add_subgoal',
    description: '新增一个 Sub Goal（v2：Goal 是搜索的终止条件，Sub Goal 可动态增删）。'
      + ' Sub Goal 用来把长任务分阶段平稳推进；只追加，不改动既有 goal。',
    parameters: {
      type: 'object',
      properties: {
        criterion: { type: 'string', description: '这个 Sub Goal 的达成标准（不能为空）。' },
        parentId: { type: 'string', description: '可选，父 goal，默认 goal_final。' },
        goalId: { type: 'string', description: '可选，预分配 id（须形如 goal_xxx）。' },
        reason: { type: 'string', description: '可选，为什么要开这个 Sub Goal。' },
      },
      required: ['criterion'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, addSubGoalOp({
        criterion: args.criterion,
        parentId: args.parentId || 'goal_final',
        goalId: args.goalId || null,
        reason: args.reason || null,
      }));
    },
  }));

  register(makeTool({
    toolName: 'fgs_drop_subgoal',
    description: '废弃一个 Sub Goal（v2：可动态增删）。图只追加 —— 标记 dropped 并记 reason，历史不删除。必须给 reason。',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string', description: '要废弃的 Sub Goal id。' },
        reason: { type: 'string', description: '废弃原因，不能为空。' },
      },
      required: ['goalId', 'reason'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, dropSubGoalOp({ goalId: args.goalId, reason: args.reason }));
    },
  }));

  // v2：Step↔Run 的绑定必须是**显式派发**。接手一个未认领 / 租约过期的 step
  // （例如原持有者已经结束）要走这个工具，而不是靠「谁先看到谁执行」。
  register(makeTool({
    toolName: 'fgs_claim_step',
    description: '把一个未认领 / 租约已过期的 open step 认领给本会话（之后本会话进入 Execute）。'
      + '- 接手指派用；认领会把 owner 写进图，必须显式调用。',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: '要接手的 open step id。' },
      },
      required: ['stepId'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      const graph = run.store.load();
      const step = openStepsOf(graph).find((s) => s.id === args.stepId);
      if (!step) return fail(`step ${args.stepId} 不是 open step，无法认领。`);
      try {
        const next = run.controller.apply(claimStepOp({ stepId: args.stepId, owner: run.sid }), graph);
        run.controller.commit(next);
      } catch (error) {
        if (error?.name === 'WriteRejected') return fail(`claim_step 拒收: ${error.message}`);
        throw error;
      }
      refreshRole(run);
      return ok(`已认领 ${args.stepId}（owner=${run.sid}）。当前角色: ${roleLabel(run.role)}`);
    },
  }));

  register(makeTool({
    toolName: 'fgs_change_step_priority',
    description: '在草稿里调整一个 open step 的优先级。',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: '目标 step id。' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '新优先级。' },
        reason: { type: 'string', description: '可选原因。' },
      },
      required: ['stepId', 'priority'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, changePriorityOp({
        stepId: args.stepId,
        priority: args.priority,
        reason: args.reason || null,
      }));
    },
  }));

  register(makeTool({
    toolName: 'fgs_satisfy_goal',
    description: '在草稿里声明目标已被满足。必填 goalId/reason/satisfiedBy，缺一拒收；commit 时还要过 FLAG 外部校验。',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string', description: '目标 id，通常 goal_final。' },
        reason: { type: 'string', description: '为什么算满足（要有证据指向）。' },
        satisfiedBy: { type: 'array', items: { type: 'string' }, description: '支撑满足的 fact id 列表，不能为空。' },
      },
      required: ['goalId', 'reason', 'satisfiedBy'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, satisfyGoalOp({
        goalId: args.goalId,
        reason: args.reason,
        satisfiedBy: args.satisfiedBy,
      }));
    },
  }));

  register(makeTool({
    toolName: 'fgs_reopen',
    description: '在草稿里打回目标：清空 satisfied* 并追加 feedback Fact（假 FLAG / 裁判打回 / 外部反馈未过时使用）。',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string', description: '目标 id，通常 goal_final。' },
        reason: { type: 'string', description: '打回原因，会落成 feedback Fact 的 content。' },
        feedbackTitle: { type: 'string', description: '可选 feedback Fact 标题。' },
      },
      required: ['goalId', 'reason'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, reopenOp({
        goalId: args.goalId,
        reason: args.reason,
        feedbackTitle: args.feedbackTitle || null,
      }));
    },
  }));

  register(makeTool({
    toolName: 'fgs_commit',
    description: '一次性提交 Decide 草稿（或传 operations[] 批量），全部校验通过才落盘；任一失败整批拒写。',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: '可选批量操作；给了就忽略草稿。每项形如 {op:"open_step", action, from}。',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['open_step', 'drop_step', 'change_step_priority', 'satisfy_goal', 'reopen'] },
              action: { type: 'string' },
              from: { type: 'array', items: { type: 'string' } },
              priority: { type: 'string' },
              actor: { type: 'string' },
              stepId: { type: 'string' },
              reason: { type: 'string' },
              goalId: { type: 'string' },
              satisfiedBy: { type: 'array', items: { type: 'string' } },
              feedbackTitle: { type: 'string' },
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
        clearDraftOnFailure: { type: 'boolean', description: '默认 false：失败时保留草稿。' },
        // v2 派发语义（**Cairn Dispatcher 必需**）：默认 true = 本回合新开的 step 自动认领给本会话
        // （单会话「先规划、下一回合执行」的顺手用法）。**派发者必须传 false** ——
        // 否则 Planner 会把整个任务池据为己有，openUnclaimed 恒为 0，任何 worker 都领不到任务。
        claimOpened: { type: 'boolean', description: '默认 true：本回合新开的 step 自动认领给自己；派发任务池时传 false，让 step 保持未认领（openUnclaimed）供其他会话 fgs_claim_step 领取。' },
      },
      required: [],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      let ops;
      if (Array.isArray(args.operations) && args.operations.length > 0) {
        try {
          ops = args.operations.map(opsFromJson);
        } catch (error) {
          return fail(`operations 解析失败: ${error.message}`);
        }
      } else {
        ops = run.decideDraft;
      }
      if (!ops || ops.length === 0) return fail('草稿为空，且未提供 operations[]；没有可提交的改动。');
      const graph = run.store.load();
      const applied = [];
      let working = graph;
      for (const op of ops) {
        let next;
        try {
          next = run.controller.apply(op, working);
        } catch (error) {
          if (error instanceof WriteRejected) {
            if (args.clearDraftOnFailure === true) run.decideDraft = [];
            return fail(`第 ${applied.length + 1} 项（${op.type}）拒收，整批不落盘: ${error.message}`);
          }
          throw error;
        }
        working = next;
        applied.push(op.type);
      }
      run.controller.commit(working);
      run.decideDraft = [];
      // 记住「本回合新开了哪些 step」：回合收口时不能把这些刚打开的 step 吞成观察 Fact，
      // 否则正常的「先规划、下一回合再执行」用法会把自己的第一步立刻消耗掉。
      // 回合轴是本 run 的 roundSeq，不是全局 DSH turn（G8）。
      {
        const before = new Set(graph.steps.map((s) => s.id));
        const openedNow = working.steps.filter((s) => !before.has(s.id)).map((s) => s.id);
        const { round, limited } = observeRound(run, turnOf(ctx, exec?.agent));
        if (openedNow.length > 0 && limited) {
          run.stepsOpenedRound = round;
          run.stepsOpenedIds = new Set(openedNow);
        }
        // v2：本会话新开的 step 默认**显式认领给自己**（写进图里的 owner 是一条可审计的边，
        // 而不是「谁先看到谁执行」的竞态）。单会话「先规划、下一回合执行」靠这个保持顺手。
        //
        // ⚠️ 但这**必须可关掉**，否则 Cairn 的 Dispatcher 语义根本无法表达：
        // 实测教训 —— 派发者批量 open 63 个任务 step 后，它们全被打上 `owner=派发者`，
        // `openUnclaimed` 恒为 0；「未认领或租约过期的 step 可被任何会话认领」这句话
        // 在**图里没有任何一个未认领的 step**时是死条款，worker 一个任务都领不到，
        // 还要干等 stepLeaseMs(30min) 才可能接手。因此派发任务池时必须传 `claimOpened:false`。
        const autoClaim = args.claimOpened !== false;
        if (autoClaim) {
          for (const sid of openedNow) {
            try {
              working = claimStep(run, working, sid);
            } catch {
              /* 已被别处认领：留给持有者，或等租约过期后用 fgs_claim_step 接手 */
            }
          }
        }
      }
      syncProjectMeta(registryFor(exec?.agent, cfg, registries), run, working);
      refreshRole(run);
      const satisfied = goalSatisfied(working);
      if (satisfied && typeof exec?.concludeTurn === 'function') exec.concludeTurn();
      const openNow = openStepsOf(working);
      const tail = satisfied
        ? 'goal_final 已满足，停止。'
        : (openNow.length > 0
          ? `下一步进入 Execute：${openNow[0].id} [${openNow[0].priority}] ${openNow[0].action}`
          : '暂无 open step：继续 Decide。');
      return ok(`已提交 ${applied.length} 项: ${applied.join(', ')}\n${tail}`);
    },
  }));

  /* ---- Execute ---- */

  register(makeTool({
    toolName: 'fgs_submit_fact',
    description: '为当前 open step 落一条新 Fact（蒸馏：title≤120 字，content 超 8KiB 必须是产物文件路径）。'
      + ' 可选 findingType：把这条 Fact 标记为 Finding（搜索过程的结构化产物，v2 Cairn_Y），'
      + ' 例如 vuln / misconfig / cred / info；不填就是普通的中间事实。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话结论（≤120 字）。' },
        content: { type: 'string', description: '证据/细节；过长就写产物文件路径。' },
        stepId: { type: 'string', description: '可选，覆盖本轮 step（默认当前 open step）。' },
        findingType: {
          type: 'string',
          description: '可选。标记为 Finding 的类型（如 vuln）；类型可动态定义。',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      if (run.role !== 'execute') {
        return fail('当前不是 Execute 轮（没有 open step）。先 Decide 开 step。');
      }
      const graph = run.store.load();
      const resolved = resolveRoundStep(run, graph, args.stepId);
      if (resolved.error) return fail(resolved.error);
      const step = resolved.step;
      const title = args.title ?? '';
      const content = args.content ?? '';
      try {
        run.controller.checkFactDistill(title, content);
      } catch (error) {
        if (error instanceof WriteRejected) return fail(`submit_fact 拒收: ${error.message}`);
        throw error;
      }
      const findingType = args.findingType ?? null;
      if (findingType !== null) {
        if (!String(findingType).trim()) return fail('findingType 不得为空白（要么不写，要么写类型）。');
        if (String(findingType).length > 64) return fail('findingType 过长（>64）。');
        const allowed = cfg.findingTypes ?? [];
        if (allowed.length > 0 && !allowed.includes(findingType)) {
          return fail(`findingType 非法: ${findingType}（当前允许: ${allowed.join(', ')}）。`
            + ' Finding 的类型可动态定义 —— 改 config.findingTypes 即可扩展。');
        }
      }
      run.execDraft = { title, content, stepId: step.id, findingType };
      run.execDraftAt = Date.now();
      return ok(`已记入本轮草稿: producedBy=${step.id}。结束时调用 fgs_commit_step 收束。`);
    },
  }));

  register(makeTool({
    toolName: 'fgs_commit_step',
    description: '收束本轮 open step：把草稿 Fact 或一条强制观察 Fact 写入图并落盘。',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: '可选，覆盖本轮 step。' },
      },
      required: [],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      const { round, limited } = observeRound(run, turnOf(ctx, exec?.agent));
      const graph = run.store.load();
      const resolved = resolveRoundStep(run, graph, args.stepId ?? run.execDraft?.stepId);
      if (resolved.error) return fail(resolved.error);
      const step = resolved.step;
      // 「本回合刚由本会话打开」的 step 允许在本回合收束。
      // 旧实现一律拒绝，导致「先收束上个 step、再开新 step 并想立刻执行」的正常流程
      // 把新 step 留成**孤儿 open step**，并留下一条永久僵尸草稿（实测 D3）。
      const selfOpenedThisRound = limited
        && run.stepsOpenedRound === round
        && run.stepsOpenedIds instanceof Set
        && run.stepsOpenedIds.has(step.id);
      // v3（原 CONTRACT §5「一轮只吃一个 open step」的**语义修正**）：
      // 判据从「每回合一次」改成「**同一 step 每回合至多一次** + 每回合总数上限」。
      // 真实轨迹证据（worker B）：同一 run 里 commit 完 step_027(a-13) 后，
      // 它已做完的 a-15 再也写不进图；契约又不给它任何补交通道，
      // 于是它**绕开黑板**（结果只写 agent_report.md、flag 直接 submit）。
      // 对有状态黑板而言这比「Fact 丢失」更糟：唯一真记忆与真实进展脱钩且无信号。
      const cap = Number.isFinite(cfg.maxCommitsPerRound) ? cfg.maxCommitsPerRound : 4;
      const alreadyDone = run.committedRound === round
        && run.committedStepIds instanceof Set && run.committedStepIds.has(step.id);
      if (limited && alreadyDone) {
        return fail(`step ${step.id} 在本回合已经收束过了（同一 step 每回合至多收束一次）。\n`
          + '· 换一个**你持有的** open step 继续收束是允许的（本回合还能收束 '
          + `${Math.max(0, cap - (run.commitsThisRound ?? 0))} 个）。\n`
          + '· 如果这个 step 还有补充产出：结束本回合，下一回合开头直接 fgs_commit_step 补交。');
      }
      if (limited && (run.commitsThisRound ?? 0) >= cap) {
        return fail(`本回合已收束 ${run.commitsThisRound} 个 step，达到上限 ${cap}`
          + '（maxCommitsPerRound，防止单个 run 无限膨胀）。\n'
          + '⚠️ 请结束本回合。手里还没落盘的发现，**不要**绕过黑板：\n'
          + '  a) 先用 fgs_submit_fact 写成草稿（草稿跨回合保留），下一回合开头 fgs_commit_step 即可落盘；\n'
          + '  b) 或直接交给调度者（Lead / 父会话）代你 fgs_submit_fact 落盘。');
      }
      const expiredDraft = run.execDraft ? null : takeExpiredDraft(run, step.id);
      const draft = run.execDraft
        ?? (expiredDraft ? expiredDraftAsFact(expiredDraft, step.id) : {
          title: `${step.id} 无有效产出（观察）`,
          content: `step ${step.id} 结束前没有 fgs_submit_fact；按契约 §5 落一条显式观察 Fact。`,
          stepId: step.id,
        });
      const op = submitFactOp({
        title: draft.title,
        content: draft.content,
        producedBy: step.id,
        findingType: draft.findingType ?? null,
      });
      try {
        const next = run.controller.apply(op, graph);
        run.controller.commit(next);
        run.execDraft = null;
        run.execDraftAt = null;
        run.currentStepId = null;
        if (limited) {
          // v3：按 (round, stepId) 记账，而不是「本回合已用完额度」。
          run.committedRound = round;
          if (!(run.committedStepIds instanceof Set)) run.committedStepIds = new Set();
          run.committedStepIds.add(step.id);
          run.commitsThisRound = (run.commitsThisRound ?? 0) + 1;
          run.lastCommitRound = round; // 兼容旧读法（/fgs/state、旧测试）
        }
        syncProjectMeta(registryFor(exec?.agent, cfg, registries), run, next);
        refreshRole(run);
        const remainder = openStepsOf(next);
        const tail = remainder.length > 0
          ? `仍有 ${remainder.length} 个 open step；本回合到此为止，下一回合再推进 ${remainder[0].id}。`
          : 'open step 已清空，回到 Decide。';
        return ok(`定稿: step ${step.id} → 新 Fact。\n${tail}`);
      } catch (error) {
        if (error instanceof WriteRejected) return fail(`commit_step 拒收: ${error.message}`);
        throw error;
      }
    },
  }));

  // 返回组合 disposer：插件卸载/HMR 时把全部图工具一起撤掉
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* 已失效 */
      }
    }
  };
}

/**
 * 草稿 op：先过 hooks/validate_write 的结构预检，给出即时拒收回执。
 *
 * 只做单 op 结构检查（缺字段 / 空 reason / 空 from 当场拒），
 * 跨 op 的引用与整图一致性留到 fgs_commit 一次性校验，
 * 这样 batch commit 里后一项引用前一项产出的 step 才合法。
 */
function stageDecideOp(run, op) {
  try {
    preflight(op);
  } catch (error) {
    if (error instanceof WriteRejected) return fail(`拒收（不会进草稿）: ${error.message}`);
    throw error;
  }
  run.decideDraft.push(op);
  return ok(`已记入草稿 #${run.decideDraft.length}: ${op.type}。全部写完后调用 fgs_commit 提交。`);
}

function pickStep(run, graph, stepId) {
  const open = openStepsOf(graph);
  const cfg = run.cfg ?? DEFAULT_CONFIG;
  const leaseMs = cfg.stepLeaseMs ?? 0;

  /**
   * 跨会话拒写（本次评估 D1 的根因）：
   * 实测中 6/6 次 fact→step 绑定都是**跨会话**的，因为旧实现取「全局第一个 open step」。
   * Cairn 的语义是 Dispatcher 派发、Agent 只跑自己的 intent，所以这里硬拒。
   */
  const ownershipError = (step) => {
    const owner = stepOwnerOf(step);
    if (!owner || owner === run.sid) return null;
    if (!claimFresh(step, Date.now(), leaseMs)) return null; // 租约过期 ⇒ 可接手
    return `step ${step.id} 已被另一个会话（${owner}）认领且租约未过期，本会话不得收束它。\n`
      + '  （Cairn：Agent 不直接认领/写回别人的 Intent；只有 Dispatcher 派发的任务才归你。）\n'
      + `  · 要接手：等租约过期（默认 ${Math.round(leaseMs / 60000)} 分钟）后会自动释放；\n`
      + '  · 本会话现在该做的：用 fgs_open_step 开一个属于你自己的 step，或等待派发。';
  };

  /**
   * v3：`refreshRole()` 每次都会把 `currentStepId` 设成「我持有的第一个 open step」，
   * 所以「刚 commit 完 A 就自动跳到 B」是常态 —— 换步分支因此**必须**先判
   * 「这个 step 是不是本回合刚收束过」，否则会退回含糊的「不是 open step」，
   * 模型只会反复重试（实测代价：多 flag 题的第 2 个 flag 丢失）。
   */
  const committedThisRound = (id) => run.committedRound === run.roundSeq
    && run.committedStepIds instanceof Set && run.committedStepIds.has(id);
  const alreadyCommittedError = (id) => ({
    error: `step ${id} 在本回合已经收束过了（同一 step 每回合至多一次）；`
      + '换一个你持有的 open step 即可继续收束。',
  });

  // 本轮 step 一旦确定就不许换：显式 stepId 与当前 step 不一致 → 返回错误而不是静默替换
  if (run.currentStepId) {
    const current = open.find((s) => s.id === run.currentStepId);
    if (current) {
      if (stepId && stepId !== current.id) {
        // v3：允许在同一回合内**换到另一个还没收束过的 step**（缺陷 I 二阶效应的修复）。
        // 旧实现一律报错「要换 step 请结束本回合」，实测让已做完的第二题无处落盘，
        // worker 于是绕开黑板（只写磁盘 + 直接刷分）。
        const target = open.find((s) => s.id === stepId);
        if (!target) {
          return committedThisRound(stepId)
            ? alreadyCommittedError(stepId)
            : { error: `step ${stepId} 不是 open step，无法收束。` };
        }
        const deniedSwitch = ownershipError(target);
        if (deniedSwitch) return { error: deniedSwitch };
        if (committedThisRound(target.id)) return alreadyCommittedError(target.id);
        run.currentStepId = target.id;
        return { step: target };
      }
      const denied = ownershipError(current);
      return denied ? { error: denied } : { step: current };
    }
  }
  if (stepId) {
    const found = open.find((s) => s.id === stepId);
    if (!found) {
      // 说清楚是哪一种「没有」：本回合刚收束过 / 根本不存在或已 done/dropped。
      // 含糊的「不是 open step」会让模型反复重试（实测代价：多 flag 题的第 2 个 flag 丢失）。
      if (committedThisRound(stepId)) return alreadyCommittedError(stepId);
      return { error: `step ${stepId} 不是 open step，无法收束。` };
    }
    const denied = ownershipError(found);
    return denied ? { error: denied } : { step: found };
  }
  // 缺省只取「本会话持有的 open step」——绝不取全局第一个，也不隐式认领。
  const mine = open.filter((s) => stepOwnerOf(s) === run.sid);
  if (mine.length > 0) return { step: mine[0] };
  const free = open.filter((s) => !claimFresh(s, Date.now(), leaseMs));
  return {
    error: open.length === 0
      ? '没有可收束的 open step。'
      : (free.length > 0
        ? `本会话没有持有的 open step；图上有 ${free.length} 个未认领/租约过期的 step`
          + `（${free.map((s) => s.id).join(', ')}）。要接手请先 fgs_claim_step。`
        : '没有可收束的 open step：图上的 open step 都被其他会话在租约内持有，且本会话没有自己的 step。'),
  };
}

function resolveRoundStep(run, graph, stepId) {
  const result = pickStep(run, graph, stepId);
  if (result.error) return result;
  run.currentStepId = result.step.id;
  return result;
}

/**
 * CONTRACT §5：Execute 回合结束前必须有一条新 Fact。
 * 模型没调 fgs_commit_step 时，在回合收口处补一条显式观察 Fact。
 * 失败只记账不抛：收束失败绝不能阻断回合结束。
 */
function forceCloseStep(run, turn, registry) {
  const { round, limited } = observeRound(run, turn);
  if (run.role !== 'execute') return false;
  // v3：只有「这个 step 本回合已经收束过」才跳过；已收束**别的** step 不阻止本回合继续收束。
  const pendingId = run.execDraft?.stepId ?? run.currentStepId;
  if (limited && pendingId && run.committedRound === round
      && run.committedStepIds instanceof Set && run.committedStepIds.has(pendingId)) {
    return false;
  }
  if (limited && !pendingId && run.committedRound === round) {
    // 本回合已经收束过（currentStepId 已被清空）且没有新的草稿指向别的 step ⇒ 无事可做
    const anyOpen = openStepsOf(run.store.load()).some((s) => s.id && run.committedStepIds instanceof Set
      && !run.committedStepIds.has(s.id) && stepOwnerOf(s) === run.sid);
    if (!anyOpen) return false;
  }
  const graph = run.store.load();
  const resolved = pickStep(run, graph, run.execDraft?.stepId ?? run.currentStepId);
  if (resolved.error || !resolved.step) return false;
  const step = resolved.step;
  // 本轮刚由 Decide 打开的 step 还没轮到 Execute，回合收口不得把它吞成观察 Fact。
  // （否则「先规划、下一回合再执行」的正常用法下，第一个 step 会被立刻消费掉。）
  if (limited && run.stepsOpenedRound === round
    && run.stepsOpenedIds instanceof Set && run.stepsOpenedIds.has(step.id)) {
    return false;
  }
  const expiredDraft = run.execDraft ? null : takeExpiredDraft(run, step.id);
  const draft = run.execDraft
    ?? (expiredDraft ? expiredDraftAsFact(expiredDraft, step.id) : {
      title: `${step.id} 无有效产出（观察）`,
      content: `回合结束前没有 fgs_submit_fact；按契约 §5 强制落一条显式观察 Fact。`,
      stepId: step.id,
    });
  const next = run.controller.apply(
    submitFactOp({ title: draft.title, content: draft.content, producedBy: step.id }),
    graph,
  );
  run.controller.commit(next);
  run.execDraft = null;
  run.execDraftAt = null;
  run.currentStepId = null;
  if (limited) {
    run.committedRound = round;
    if (!(run.committedStepIds instanceof Set)) run.committedStepIds = new Set();
    run.committedStepIds.add(step.id);
    run.commitsThisRound = (run.commitsThisRound ?? 0) + 1;
    run.lastCommitRound = round;
  }
  syncProjectMeta(registry, run, next);
  refreshRole(run);
  return true;
}

function opsFromJson(item) {
  const kind = item?.op ?? item?.type;
  switch (kind) {
    case 'open_step':
      return openStepOp({
        action: item.action ?? '',
        from: item.from ?? [],
        actor: item.actor || 'agent',
        priority: item.priority || 'normal',
        stepId: item.stepId || null,
      });
    case 'drop_step':
      return dropStepOp({ stepId: item.stepId, reason: item.reason });
    case 'add_subgoal':
      return addSubGoalOp({
        criterion: item.criterion,
        parentId: item.parentId || 'goal_final',
        goalId: item.goalId || null,
        reason: item.reason || null,
      });
    case 'drop_subgoal':
      return dropSubGoalOp({ goalId: item.goalId, reason: item.reason });
    case 'claim_step':
      return claimStepOp({ stepId: item.stepId, owner: item.owner });
    case 'change_step_priority':
      return changePriorityOp({ stepId: item.stepId, priority: item.priority, reason: item.reason || null });
    case 'satisfy_goal':
      return satisfyGoalOp({ goalId: item.goalId, reason: item.reason, satisfiedBy: item.satisfiedBy });
    case 'reopen':
      return reopenOp({ goalId: item.goalId, reason: item.reason, feedbackTitle: item.feedbackTitle || null });
    default:
      throw new Error(`未知 op: ${item?.op ?? item?.type}`);
  }
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const runs = new Map();
  const registries = new Map();
  // /fgs off 打上的「本会话不再自动认领」标记（key 同 runs：(sessionId, problemId)）。
  // 没有它的话，auto-attach 会在 off 之后立刻把 run 又建回来。
  const detached = new Set();

  // 所有注册的 disposer 都收在这里，插件卸载/HMR 时统一撤销。
  // 实测：不交给 ctx.effect 持有的注册会在插件移除后继续生效
  // （旧 HTTP 路由继续响应、旧 context 继续注入、旧监听继续收紧新会话）。
  const owned = [];
  const hold = (disposer) => {
    if (typeof disposer === 'function') owned.push(disposer);
    return disposer;
  };
  const ioSpecs = { decide: loadIoSchema('decide'), execute: loadIoSchema('execute') };
  const ioSchemaFor = (role) => ioSpecs[role] ?? null;

  hold(registerTools(ctx, cfg, runs, registries, detached));

  const activeRun = (agent) => attachRun(agent, cfg, runs, registries, detached);

  // 角色隔离硬门：顺序无关、单调，任何越权调用都在 dispatch 层被拒。
  // 没有活动 Project 时，改图工具（含 fgs_seed）一律拒；只放只读 fgs_status。
  hold(ctx.tools.guard((exec) => {
    const tool = exec?.name;
    // 控制面：建题 / 换题 / 列题。没有活动 Project 时正是要用它，所以任何状态都放行。
    if (PROJECT_TOOLS.includes(tool)) return undefined;
    const { problemId, run, reason } = activeRun(exec?.agent);
    // 角色必须**每次都由 (图, 本会话) 现算**——缓存过的 run.role 会与图脱节，
    // 导致会话卡死、且 §4 的 Decide 环境工具禁令静默失效（详见 refreshRole 注释）。
    if (run) {
      try {
        refreshRole(run);
      } catch {
        /* 图不可读时退回缓存角色，让后续读取路径自己报错 */
      }
    }
    if (GRAPH_TOOL_NAMES.includes(tool)) {
      if (!problemId) {
        return tool === 'fgs_status'
          ? undefined
          : 'FGS 未启动：没有活动 Project。先 fgs_project action=new problemId=<id>（或 /fgs new <id>）。';
      }
      if (!run) {
        if (CONTROL_TOOLS.includes(tool)) return undefined;
        return reason === 'detached'
          ? 'FGS 已 /fgs off（本会话退出了 FGS）。重新进入用 fgs_project action=switch problemId=<id>。'
          : 'FGS 未启动：先 fgs_seed（或 /fgs init <brief>）种题，再使用图工具。';
      }
      // v2：见 GRAPH_MUTATION_TOOLS 注释 —— 图操作工具两类活动都放行。
      if (GRAPH_MUTATION_TOOLS.includes(tool)) return undefined;
      if (!(ROLE_TOOLS[run.role] ?? []).includes(tool)) {
        return run.role === 'execute'
          ? `FGS 角色隔离：当前 Execute 轮不得调用 ${tool}（CONTRACT §5）。`
            + ' 本轮请用 fgs_submit_fact 落 Fact，再用 fgs_commit_step 收束。'
          : `FGS 角色隔离：当前 Decide 轮不得调用 ${tool}（CONTRACT §4）。`
            + ' 规划请用 fgs_open_step / fgs_drop_step / fgs_change_step_priority'
            + ' / fgs_satisfy_goal / fgs_reopen，再 fgs_commit；查看用 fgs_preview。';
      }
      return undefined;
    }
    // CONTRACT §4：Decide 只做规划/改图。白名单之外的工具一律拒
    //（含 bash/文件/网络/subagent/workflow —— 它们能间接执行环境动作）。
    if (run && run.role === 'decide') {
      if (cfg.deniedEnvTools.includes(tool)) {
        return `FGS Decide 会话禁止环境执行工具 ${tool}（CONTRACT §4）：`
          + ' Decide 只做规划/改图；需要执行时先 fgs_open_step + fgs_commit 打开 step，'
          + '进 Execute 轮后才允许环境工具。';
      }
      if (!decideAllows(cfg, tool)) {
        return `FGS Decide 会话禁止调用 ${tool}（CONTRACT §4：Decide 只做规划/改图，`
          + '禁止 bash/文件/网络/委派等一切环境工具）。'
          + ' 需要在环境里动作时，先 fgs_open_step + fgs_commit 打开 step，进 Execute 轮再执行。';
      }
    }
    return undefined;
  }));

  // CONTRACT §5：Execute 回合收口前必须收束成一条新 Fact（无产出也要观察 Fact）
  hold(ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent ?? payload;
      if (!agent) return;
      const { registry, run } = activeRun(agent);
      if (!run) return;
      forceCloseStep(run, turnOf(ctx, agent), registry);
    } catch {
      /* 收束失败不得阻断回合结束 */
    }
  }));

  // ---- §5 兜底：进程被信号中断时也强制 CONCLUDE --------------------------------
  //
  // 为什么必须有这段：上面那个收口钩子挂在 `agent/turn-stopping` 上，**只有回合正常结束
  // 才触发**。而 supervisor 超时是**在回合中途**发 SIGTERM —— 该事件永远不会到，
  // 于是"回合收口前必须有一条新 Fact"恰好在最需要它的时候失效。
  // 实测代价：一道复杂题跑了 23 分钟，黑板停在 `step: open`、0 条 fact，
  // 真正拿到的 1/2 flag 只留在平台侧；而 §5 的本意正是要避免这件事。
  //
  // 语义与 Cairn 黑板一致：**没有在指定时间内到达 Goal，也要写下结论 Fact。**
  // 这是兜底；主力是 supervisor 的超时收束回合（那个能拿到模型的完整上下文，
  // 因此能写下真正有信息量的 Fact，而不是这里的中断记录）。
  const flushOnSignal = (sig) => {
    let n = 0;
    for (const run of runs.values()) {
      try {
        if (!run || run.role !== 'execute') continue;
        if (!run.currentStepId && !run.execDraft) continue;
        if (!run.execDraft) {
          // 没有草稿时**不要**假装"无有效产出"（那会误导：本轮可能已经拿到 flag）。
          // 落一条诚实的中断记录，把真相指向平台侧。
          run.execDraft = {
            title: `${run.currentStepId ?? 'step'} 被 ${sig} 中断（信号兜底收束）`,
            content: `进程收到 ${sig} 即将退出，本 step 未经模型收束。`
              + '为不让黑板留空，此处落一条显式记录；本轮真实进展以平台侧进度为准。',
            stepId: run.currentStepId,
          };
        }
        // turn 传 undefined → observeRound 返回 limited:false，跳过"一轮一步"守卫；
        // registry 传 null → syncProjectMeta 开头会直接 return，不会 NPE。
        if (forceCloseStep(run, undefined, null)) n += 1;
      } catch {
        /* 单个 Project 失败不影响其它 */
      }
    }
    if (n > 0) {
      try {
        process.stderr.write(`[fgs] ${sig}：已强制收束 ${n} 个未落盘的 step\n`);
      } catch { /* ignore */ }
    }
  };
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const handler = () => {
      flushOnSignal(sig);
      // ⚠️ 注册信号监听会**取消 Node 的默认退出行为**（进程会变成"杀不死"）。
      // 若我们是唯一监听者，就摘掉自己重新触发一次信号，恢复默认语义；
      // 若宿主（DSH）自己也有监听者，说明退出由它负责，交还给它。
      try {
        if (process.listenerCount(sig) === 1) {
          process.removeListener(sig, handler);
          process.kill(process.pid, sig);
        }
      } catch { /* ignore */ }
    };
    try {
      process.on(sig, handler);
      hold(() => {
        try { process.removeListener(sig, handler); } catch { /* ignore */ }
      });
    } catch {
      /* 环境不支持信号时跳过（不能因此让插件挂载失败） */
    }
  }

  // 运行时上下文：每步注入最新图投影 + 角色规则（CONTRACT §9）
  ctx.inject(['systemPrompt'], (scoped) => {
    const sp = scoped?.systemPrompt ?? scoped;
    if (!sp?.section) return;
    hold(sp.section({ name: 'fgs-rules', order: 62, text: FGS_RULES }));
    hold(sp.context({
      name: 'fgs-graph',
      order: 62,
      text: (assembly) => {
        // 严格按 assembly 的 scope 找本会话的 run：找不到就什么都不注入。
        // 绝不回退到「最近一个 run」——那会把 A 会话的黑板塞进 B 会话的上下文。
        const scope = assembly?.scope;
        if (!scope || typeof scope !== 'object') return '';
        const sid = sessionIdOf(scope);
        if (!sid || sid === 'unknown') return '';
        // 只注入本会话 × 活动 Project 的 run，不回退到别的题或别的会话。
        const { run } = activeRun(scope);
        if (!run || run.sid !== sid) return '';
        try {
          // 注入上下文同样必须现算角色：旧实现直接用缓存 run.role，
          // 于是出现「面板说 decide、注入说 execute、图里 open=0」三面互相矛盾。
          const graph = refreshRole(run);
          const current = graph.steps.find((s) => s.id === run.currentStepId) ?? null;
          return roleContextText({
            role: run.role,
            store: run.store,
            graph,
            currentStep: current,
            draftSummary: draftSummary(run),
            ioSpec: ioSchemaFor(run.role),
            // 提示词里的工具清单由守卫列表派生（单一真源），避免与 tools.guard 漂移。
            graphMutationTools: GRAPH_MUTATION_TOOLS,
            executeDeniedGraphTools: EXECUTE_DENIED_GRAPH_TOOLS,
            injectMaxChars: run.cfg?.injectMaxChars ?? 24000,
            // v3（缺陷 K/L）：注入面必须知道「我是谁」和「租约多长」，
            // 才能把 mine / unclaimed / 可接手(租约已过期) 标在 open steps 那一行上。
            sid: run.sid,
            stepLeaseMs: run.cfg?.stepLeaseMs ?? 0,
          });
        } catch (error) {
          return `【FGS 图读取失败】${error?.message ?? error}`;
        }
      },
    }));
  });

  // 人类命令入口
  ctx.inject(['commands'], (scoped) => {
    const commands = scoped?.commands ?? scoped;
    if (!commands?.register) return;
    // 与 fgs_project 工具共用同一套实现（projectNew），避免命令/工具两套语义漂移。
    const handleNew = (agent, rawId, brief) => {
      const result = projectNew(agent, cfg, runs, registries, detached, rawId, brief);
      return { kind: result.ok ? 'success' : 'error', text: result.text };
    };

    hold(commands.register({
      name: 'fgs',
      description: 'FGS 黑板：new <problemId> [brief] | switch <problemId> | list | init <brief> | status | graph | path | reopen <reason> | off',
      input: { hint: 'new <problemId> [brief] | switch <problemId> | list | init <brief> | status | graph | path | reopen <reason> | off' },
      handler: (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        const restText = rest.join(' ').trim();
        const agent = invocation?.agent;
        // 命令路径同样走「认领」：磁盘已种题的 Project 不该被报成「未启动」。
        const { run } = attachRun(agent, cfg, runs, registries, detached);
        switch (sub) {
          case 'new': {
            const rawId = rest[0];
            const brief = rest.slice(1).join(' ').trim();
            if (!rawId) return { kind: 'error', text: '用法: /fgs new <problemId> [brief]' };
            return handleNew(agent, rawId, brief);
          }
          case 'switch': {
            const rawId = rest[0];
            if (!rawId) return { kind: 'error', text: '用法: /fgs switch <problemId>' };
            const result = projectSwitch(agent, cfg, runs, registries, detached, rawId);
            return { kind: result.ok ? 'success' : 'error', text: result.text };
          }
          case 'list': {
            const result = projectList(agent, cfg, runs, registries);
            return { kind: result.ok ? 'success' : 'error', text: result.text };
          }
          case 'init': {
            if (!restText) return { kind: 'error', text: '用法: /fgs init <题目 brief>' };
            return handleNew(agent, 'default', restText);
          }
          case 'status': {
            if (!run) return { kind: 'success', text: 'FGS 未启动。' };
            const snap = graphSnapshot(run);
            return {
              kind: 'success',
              text: `Project ${snap.problemId} | 角色 ${snap.role} | facts=${snap.counts.facts} steps=${snap.counts.steps} open=${snap.counts.open} | satisfied=${snap.satisfied}`,
            };
          }
          case 'graph': {
            if (!run) return { kind: 'error', text: 'FGS 未启动。' };
            return { kind: 'success', text: run.store.preview(run.store.load()) };
          }
          case 'path': {
            if (!run) return { kind: 'error', text: 'FGS 未启动。' };
            return { kind: 'success', text: path.join(run.root, 'graph.yaml') };
          }
          case 'reopen': {
            if (!run) return { kind: 'error', text: 'FGS 未启动。' };
            if (!restText) return { kind: 'error', text: '用法: /fgs reopen <打回原因>' };
            try {
              const graph = run.store.load();
              const next = run.controller.apply(reopenOp({ goalId: 'goal_final', reason: restText }), graph);
              run.controller.commit(next);
              syncProjectMeta(registryFor(agent, cfg, registries), run, next);
            } catch (error) {
              return { kind: 'error', text: `reopen 失败: ${error.message}` };
            }
            refreshRole(run);
            return { kind: 'success', text: '已打回：satisfied* 已清空，feedback Fact 已追加。' };
          }
          case 'off': {
            if (!run) return { kind: 'success', text: 'FGS 本就未启动。' };
            runs.delete(runKey(run.sid, run.problemId));
            // 关键：记下 detached，否则 auto-attach 会在下一句就把 run 建回来。
            detached.add(runKey(run.sid, run.problemId));
            return {
              kind: 'success',
              text: '已退出 FGS（本会话不再自动认领）；Project 与图文件保留在磁盘。'
                + ` 重新进入用 /fgs switch ${run.problemId}。`,
            };
          }
          default:
            return {
              kind: 'error',
              text: '子命令: new <problemId> [brief] | switch <problemId> | list | init <brief> | status | graph | path | reopen <reason> | off'
                + '（同能力的工具：fgs_project action=new|switch|list）',
            };
        }
      },
    }));
  });

  // 只读 HTTP 快照：给 Web 端黑板面板用
  ctx.inject(['webServer'], (scoped) => {
    if (!cfg.exposeHttpState) return;
    const server = scoped?.webServer ?? scoped;
    if (!server?.register) return;
    try {
      hold(server.register({
        kind: 'exact',
        path: cfg.httpPath,
        handler: (req, res) => {
          let body;
          try {
            // ?problemId= 看指定题；?sessionId= 看该会话的活动题；都没有则回退活动 Project
            // （没有活动 run 时再退到最近一个 run，方便 curl）。
            let sid = null;
            let problemParam = null;
            try {
              const params = new URL(req?.url ?? '/', 'http://localhost').searchParams;
              sid = params.get('sessionId');
              problemParam = params.get('problemId');
            } catch {
              sid = null;
              problemParam = null;
            }
            body = JSON.stringify(resolveHttpSnapshot({
              runs, registries, cfg, sessionId: sid, problemId: problemParam,
            }));
          } catch (error) {
            body = JSON.stringify({ active: false, error: String(error?.message ?? error) });
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(body);
        },
      }));
    } catch {
      /* 路由已被占用或不可注册：面板降级显示 */
    }
  });

  // 插件卸载/HMR：撤销本插件登记的一切资源（工具、guard、prompt、命令、HTTP 路由）
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of owned) {
        try {
          dispose();
        } catch {
          /* 已失效 */
        }
      }
    });
  }
}
