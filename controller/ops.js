/**
 * 写图操作（Op）定义与拒写错误（CONTRACT §3、§4）。
 *
 * 只有 Controller 改图；模型侧只调工具，工具产出 Op。
 */

export const OP = Object.freeze({
  OPEN_STEP: 'open_step',
  CLAIM_STEP: 'claim_step',
  ADD_SUBGOAL: 'add_subgoal',
  DROP_SUBGOAL: 'drop_subgoal',
  DROP_STEP: 'drop_step',
  CHANGE_PRIORITY: 'change_step_priority',
  SUBMIT_FACT: 'submit_fact',
  SEED_ORIGIN: 'seed_origin',
  SATISFY_GOAL: 'satisfy_goal',
  REOPEN: 'reopen',
  // Execute 会话墙钟到期：写未完成 Fact，并把 open step 的认领放回池（不关 step）。
  RELEASE_STEP: 'release_step',
});

/** 校验失败拒写，不落盘（CONTRACT §3）。 */
export class WriteRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'WriteRejected';
    this.code = 'FGS_WRITE_REJECTED';
  }
}

/**
 * open_step：`from` 非空；可预分配 stepId（batch commit）。
 *
 * `owner` / `claimedAt`：Cairn 的「Intent 认领」语义（《无径之径》§系统架构：
 * 「Intent 认领有心跳超时与自动释放」）。开 step 的会话即认领者；缺省 null
 * 表示未认领，任何会话可认领后执行。
 */
export function openStepOp({
  action, from, actor = 'agent', priority = 'normal', stepId = null,
  owner = null, claimedAt = null,
}) {
  return { type: OP.OPEN_STEP, action, from, actor, priority, stepId, owner, claimedAt };
}

/**
 * claim_step：把一个 open step 认领给某会话（写 owner + claimedAt）。
 * 只有 Controller 改图；认领同样是一次受校验的写图操作。
 */
export function claimStepOp({ stepId, owner, claimedAt = null }) {
  return { type: OP.CLAIM_STEP, stepId, owner, claimedAt };
}

/**
 * release_step：Execute 会话超时用。追加一条未完成 Fact，清掉该 owner 名下
 * open step 的 owner/claimedAt（step 仍 open），并把 Fact 记在目标 step 上。
 * 不是 goal 级 reopen。
 */
export function releaseStepOp({ stepId, factTitle, factContent }) {
  return { type: OP.RELEASE_STEP, stepId, factTitle, factContent };
}

/** drop_step：必须 reason。 */
export function dropStepOp({ stepId, reason }) {
  return { type: OP.DROP_STEP, stepId, reason };
}

/** change_step_priority：reason 可选。 */
export function changePriorityOp({ stepId, priority, reason = null }) {
  return { type: OP.CHANGE_PRIORITY, stepId, priority, reason };
}

/**
 * submit_fact：producedBy 必填（origin 种子除外）。
 *
 * `findingType`（v2 Cairn_Y）：Finding = **搜索过程的结构化产物**（漏洞挖掘类任务里就是安全漏洞）。
 * Cairn_Y 的图叫 **Fact-Goal-Step Graph**，顶层只有三种节点，所以 Finding **不是第四种节点**，
 * 而是**带类型标记的 Fact**（graph.yaml 顶层禁止 findings 键，CONTRACT §2 / GraphStore 双重校验）。
 * 类型可动态定义（由 config.findingTypes 约束，留空即自由定义）。
 */
export function submitFactOp({ title, content, producedBy, findingType = null }) {
  return { type: OP.SUBMIT_FACT, title, content, producedBy, findingType };
}

/**
 * add_subgoal：v2 明确「也存在可以动态增删的 Sub Goal」，Goal 是**搜索的终止条件**。
 * 只追加：新增一个 kind='sub' 的 goal；不得修改既有 goal。
 */
export function addSubGoalOp({ criterion, parentId = 'goal_final', goalId = null, reason = null }) {
  return { type: OP.ADD_SUBGOAL, criterion, parentId, goalId, reason };
}

/** drop_subgoal：v2「可动态增删」；**只标记不删除**（图只追加），必须给 reason。 */
export function dropSubGoalOp({ goalId, reason }) {
  return { type: OP.DROP_SUBGOAL, goalId, reason };
}

/** origin 种题种子：唯一免 producedBy 的 fact 写入，同时种 goal_final。 */
export function seedOriginOp({
  title,
  content,
  criterion = '解决这道渗透题目，并提交全部 FLAG；多 FLAG 须全部有效提交',
}) {
  return { type: OP.SEED_ORIGIN, title, content, criterion };
}

/** satisfy_goal：必填 {goalId, reason, satisfiedBy}。 */
export function satisfyGoalOp({ goalId, reason, satisfiedBy }) {
  return { type: OP.SATISFY_GOAL, goalId, reason, satisfiedBy };
}

/** reopen：清空 satisfied* + 追加 feedback Fact，禁止删历史。 */
export function reopenOp({ goalId, reason, feedbackTitle = null }) {
  return { type: OP.REOPEN, goalId, reason, feedbackTitle };
}

const VALID_PRIORITIES = Object.freeze(['high', 'normal', 'low']);

export function isValidPriority(value) {
  return VALID_PRIORITIES.includes(value);
}

export const PRIORITIES = VALID_PRIORITIES;
