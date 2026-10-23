/**
 * Activity 选择（v5：Cairn 的「无身份 worker」/ Cairn_Y 的「Decide、Execute 是活动而非角色」）。
 *
 * 这个模块是**纯函数**：只读图，不写图、不碰宿主。用途有两个：
 *   1. 插件在 activity 模式下校验「本次 run 该做什么」；
 *   2. `tools/activity.mjs` 把它交给编排器（contest/activity_loop.py），
 *      由编排器决定**下一次要不要起新进程、起哪个活动**。
 *
 * 为什么把选择逻辑放在 kernel 而不是编排器里：Cairn v1 的 Dispatcher 与
 * Cairn_Y 的 Node 都只做「从图里读下一步」这一件事；把规则留在图旁边，
 * 编排器（Python driver / GUI / 测试）可以共用同一份判定，不会各自漂移。
 *
 * 活动只有两种：
 *   - decide：图开始或图变化时规划（加/删/调 Step、增删 Sub Goal、判 goal）。
 *   - execute：推进一个 open step，产出新 Fact。
 * 没有「角色」。一个 run 做完一个活动就退出，下一次由编排器起一个干净的 run。
 */

import { nowIsoZ } from './index.js';

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

/** 与 index.js 的 openStepsOf 同义：只认 state === 'open' 的 step。 */
export function openStepsOf(graph) {
  return (graph?.steps ?? []).filter((step) => step.state === 'open');
}

/** goal_final（或任一 final goal）是否已 satisfy。 */
export function goalSatisfied(graph) {
  const goals = graph?.goals ?? [];
  const finals = goals.filter((goal) => goal.kind !== 'sub');
  return finals.length > 0 && finals.every((goal) => goal.satisfiedAt);
}

/** 仍 open 的 sub goal（v2：Sub Goal 是一等公民且可动态增删）。 */
export function openSubGoals(graph) {
  return (graph?.goals ?? []).filter(
    (goal) => goal.kind === 'sub' && goal.state !== 'dropped' && !goal.satisfiedAt,
  );
}

function leaseFresh(step, now, leaseMs) {
  if (!step.owner) return false;
  if (!leaseMs || leaseMs <= 0) return true;
  const claimedAt = Date.parse(step.claimedAt ?? '');
  if (!Number.isFinite(claimedAt)) return true;
  return now - claimedAt < leaseMs;
}

/** Finding 数（v2：Finding = 带 findingType 的 Fact，是搜索过程的结构化产物）。 */
export function findingCount(graph) {
  return (graph?.facts ?? []).filter((fact) => typeof fact?.findingType === 'string' && fact.findingType !== '').length;
}

/**
 * 冷启动：图里只有 fact_origin，且只有一条由 driver 预种的 bootstrap step。
 *
 * 对应 Cairn v1 的 bootstrap 快路径：初始项目先跑 bootstrap 直冲 goal，
 * 成功就连 Fact+完成一起写，失败才进 reason。这里用「预种 step + 专门的
 * bootstrap 活动」表达；`actor: 'bootstrap'` 是唯一标记。
 */
export function isColdStart(graph) {
  const facts = graph?.facts ?? [];
  const steps = graph?.steps ?? [];
  if (facts.length !== 1 || facts[0].id !== 'fact_origin') return false;
  if (steps.length !== 1) return false;
  const step = steps[0];
  return step.state === 'open' && step.actor === 'bootstrap';
}

/**
 * 图签名：编排器用它判断「上一轮是否真的推进了图」。
 * 只包含**会随活动变化**的计数，不做内容哈希（避免中文/换行带来的无意义抖动）。
 * `n` = Finding 数：新 Finding 是「图上信息有实质增加」，要能单独触发 Decide。
 */
export function graphSignature(graph) {
  const facts = graph?.facts?.length ?? 0;
  const steps = graph?.steps?.length ?? 0;
  const open = openStepsOf(graph).length;
  const dropped = (graph?.steps ?? []).filter((step) => step.state === 'dropped').length;
  const satisfied = (graph?.goals ?? []).filter((goal) => goal.satisfiedAt).length;
  const subGoals = (graph?.goals ?? []).filter((goal) => goal.kind === 'sub').length;
  return `f${facts}:s${steps}:o${open}:d${dropped}:g${satisfied}:u${subGoals}:n${findingCount(graph)}`;
}

/** 可被本编排器派发的 step：未认领，或认领租约已过期。 */
export function dispatchableSteps(graph, { now = Date.now(), leaseMs = 0 } = {}) {
  return openStepsOf(graph)
    .filter((step) => !leaseFresh(step, now, leaseMs))
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 1;
      const pb = PRIORITY_ORDER[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      const ta = Date.parse(a.createdAt ?? '') || 0;
      const tb = Date.parse(b.createdAt ?? '') || 0;
      return ta - tb;
    });
}

/** Take the one step a caller wants to run, or the best dispatchable one. */
export function selectStep(graph, { stepId = null, now = Date.now(), leaseMs = 0 } = {}) {
  const open = openStepsOf(graph);
  if (stepId) {
    return open.find((step) => step.id === stepId) ?? null;
  }
  return dispatchableSteps(graph, { now, leaseMs })[0] ?? null;
}

/**
 * Decide 触发（Cairn v1 `_reason_trigger` 的移植：reason 优先于 explore）。
 *
 * 基线的取法与 Cairn 一致：记录的是**上一次 Decide 跑完之后**的计数，
 * 所以 Decide 自己新开的 step / 新写的 goal 不会把下一次 Decide 再触发一遍
 * （避免 planner 自激）。只有别的工作（Execute 落的 Fact、Finding）才会越过基线。
 *
 * @returns {string|null} 触发原因；null = 不触发
 */
function decideDue(options, { findings, open }) {
  const { findingsAtLastDecide, executesSinceDecide, decideEvery } = options;
  if (Number.isFinite(findingsAtLastDecide) && findings > findingsAtLastDecide) {
    return `新 Finding +${findings - findingsAtLastDecide}`;
  }
  const every = Number.isFinite(decideEvery) ? decideEvery : 3;
  if (every > 0 && Number.isFinite(executesSinceDecide) && executesSinceDecide >= every) {
    return `已连续 Execute ${executesSinceDecide} 次（decideEvery=${every}）`;
  }
  if (open === 0) return '任务池已空';
  return null;
}

/**
 * 决定下一个活动。
 *
 * @param {object} graph - 图（facts/goals/steps）。
 * @param {object} options
 * @param {number}  [options.now] - 当前时间戳（测试可注入）。
 * @param {number}  [options.leaseMs] - step 认领租约；0 = 租约不生效（单编排器）。
 * @param {string}  [options.lastSignature] - 上一次活动结束后的 graphSignature。
 * @param {number}  [options.noProgress] - 连续「图没变」的活动次数。
 * @param {number}  [options.maxNoProgress] - 连续无进展多少次后停止本题（默认 3）。
 * @param {number}  [options.activitiesLeft] - 剩余活动预算；<= 0 时返回 budget。
 * @param {boolean} [options.decideOnChangeOnly] - true = 图没变就不再 Decide（防空转）。
 * @param {number}  [options.findingsAtLastDecide] - 上次 Decide 结束时的 Finding 数。
 * @param {number}  [options.executesSinceDecide] - 上次 Decide 以来已跑的 Execute 数。
 * @param {number}  [options.decideEvery] - 每 K 次 Execute 插一次 Decide（默认 3）。
 * @returns {{kind: 'decide'|'execute'|'bootstrap'|'done'|'wait'|'defer'|'budget',
 *            stepId?: string, reason: string, signature: string, counts: object}}
 */
export function nextActivity(graph, options = {}) {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? 0;
  const signature = graphSignature(graph);
  const counts = {
    facts: graph?.facts?.length ?? 0,
    steps: graph?.steps?.length ?? 0,
    open: openStepsOf(graph).length,
    goals: graph?.goals?.length ?? 0,
    findings: findingCount(graph),
    coldStart: isColdStart(graph),
  };
  const base = { signature, counts };

  if (goalSatisfied(graph)) {
    return { ...base, kind: 'done', reason: 'goal_final 已满足' };
  }
  if (Number.isFinite(options.activitiesLeft) && options.activitiesLeft <= 0) {
    return { ...base, kind: 'budget', reason: '活动预算用尽' };
  }

  const dispatchable = dispatchableSteps(graph, { now, leaseMs });
  const open = openStepsOf(graph);
  const cold = isColdStart(graph);

  // 冷启动快路径（Cairn bootstrap）：图里只有 origin + 预种 bootstrap step 时，
  // 第一轮直接直冲 goal，不花一轮 Decide。bootstrap 失败后 release_step 会追加
  // 一条未完成 Fact，冷启动条件自然消失，随后进入正常 Decide。
  if (cold && dispatchable.length > 0) {
    return {
      ...base,
      kind: 'bootstrap',
      stepId: dispatchable[0].id,
      reason: `冷启动直冲 goal（${dispatchable[0].id}）`,
    };
  }

  if (dispatchable.length > 0) {
    const step = dispatchable[0];
    const due = decideDue(options, { findings: base.counts.findings, open: open.length });
    if (due) {
      return {
        ...base,
        kind: 'decide',
        // v5.2：Decide 不再挡住 Execute —— 给出候选 step，编排器在 Decide 跑着时继续填 slot。
        executeCandidate: step.id,
        reason: `图有变化，先重规划（${due}）—— 再执行 ${step.id}`,
      };
    }
    return {
      ...base,
      kind: 'execute',
      stepId: step.id,
      reason: `推进可派发 step ${step.id}（open=${open.length}）`,
    };
  }
  if (open.length > 0) {
    // 全部 open step 都被别的 run 在租约内持有：不该抢，等租约过期。
    return { ...base, kind: 'wait', reason: `${open.length} 个 open step 都在租约内，等待释放` };
  }

  const noProgress = options.noProgress ?? 0;
  const changed = options.lastSignature === undefined || options.lastSignature !== signature;
  const maxNoProgress = options.maxNoProgress ?? 3;
  if (options.decideOnChangeOnly !== false && !changed && options.lastSignature !== undefined) {
    return {
      ...base,
      kind: 'defer',
      reason: `图自上次 Decide 未变化（${signature}），不再空转 Decide`,
    };
  }
  if (noProgress >= maxNoProgress) {
    return { ...base, kind: 'defer', reason: `连续 ${noProgress} 轮无进展` };
  }
  return { ...base, kind: 'decide', reason: `没有可派发 step，进入 Decide（${signature}）` };
}

/** 活动 run 的稳定标识：编排器把它传给子进程，便于把一次 run 的所有事件串起来。 */
export function makeRunId(prefix = 'run') {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/** activity.jsonl 的一条记录（只追加；编排器和插件都写同一个文件）。 */
export function activityRecord({
  runId,
  activity,
  stepId = null,
  outcome,
  signature = '',
  reason = '',
  source = 'plugin',
}) {
  return {
    at: nowIsoZ(),
    runId,
    activity,
    stepId,
    outcome,
    signature,
    reason,
    source,
  };
}
