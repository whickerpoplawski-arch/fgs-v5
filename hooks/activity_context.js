/**
 * 活动模式的提示词（v5：Decide / Execute 是**活动**，不是角色）。
 *
 * 与 sync_context.js 的区别：那边服务「单会话内角色切换」的旧模型 —— 同一个 run
 * 里既要先 Decide 又要后 Execute，所以必须把「你现在是谁、刚才是谁」讲清楚；
 * 这里服务「一次 run 只做一件事」的新模型 —— 工具集在注册期就已经不同，
 * 提示词只需要说清**这一轮做什么、什么时候算做完、做完就退出**。
 *
 * 两条硬要求（来自真实轨迹的教训）：
 *   1. 必须写明「哪个调用是本轮的结束信号」。不写，模型会继续探索/继续写图，
 *      把一轮活动拖成一场长会话，clean context 的意义就没了。
 *   2. 必须写明「做完就停」。旧协议靠 turn 收口钩子兜底，但兜底写出来的
 *      Fact 信息量远低于模型自己收束（HANDOFF 里 23 分钟 0 fact 的例子）。
 */

/** 活动模式的 system 规则段：短、只讲本 run 的边界。 */
export function activityRules(activity, { conclude = false, budgetMs = 0 } = {}) {
  const head = [
    '## FGS 活动模式（一次 run 只做一件事）',
    '',
    '本次 run 是一个**独立活动**：要么 Decide，要么 Execute，做完即退出，没有跨 run 记忆。',
    '唯一共享记忆是磁盘上的 FGS 图（.fgs/projects/<problemId>/graph.yaml）；你的对话不会传给下一次 run。',
  ];
  // 预告知的 deadline override（Cairn bootstrap/explore 的核心可复用技巧）：
  // 开始时就告诉模型「到点会被强制中断、并由同一会话发起收束轮」，比裸的「停」更可靠。
  const concludeRule = [
    '',
    '## 收束轮（conclude，覆盖一切旧指令）',
    '上一轮活动超时了。本轮是**收束轮**，不是新一轮探索：',
    '- 立即停止探索：不跑新命令、不开新方向、不做新的利用尝试。',
    '- 只把**已经确认的观察与结论**写成这一条 Fact，然后用 fgs_commit_step 收束。',
    '- 这是最高优先级：即使之前的指令让你继续，也以本轮为准，直接交付已有结论。',
  ];
  const deadlineRule = budgetMs > 0
    ? [
      '',
      `【本轮墙钟预算约 ${Math.max(1, Math.round(budgetMs / 60000))} 分钟】到点进程会被结束，`,
      '随后同一会话会收到收束指令：收到该指令时立即停手并交付结论；不要等到最后一刻才落 Fact。',
    ]
    : [];

  const body = (() => {
    if (activity === 'decide') {
      return [
        '',
        '本轮 = Decide（规划）。可用工具只有 FGS 图工具：fgs_status / fgs_preview /',
        '  fgs_open_step / fgs_claim_step / fgs_drop_step / fgs_add_subgoal / fgs_drop_subgoal /',
        '  fgs_change_step_priority / fgs_satisfy_goal / fgs_reopen / fgs_commit。',
        '环境执行工具（bash/文件/网络/委派）本轮**没有注册**，调用会直接报 UNKNOWN_TOOL；不要尝试。',
        '',
        '结束信号：fgs_commit 成功落盘后，本轮就结束了 —— 不要再调用别的工具，直接结束回合。',
        '没有可提交的改动就不要调用 fgs_commit；直接结束回合（空转的 Decide 会被编排器记为无进展）。',
        '决策纪律：只看图上事实；Execute 有进展（新 Fact / 新 Finding）时会被重新触发，不要一次铺开整条路线。',
        '',
        '【图可能在你规划期间变化】Execute 与你是并发的，提交时会按最新图逐项校验：',
        '  冲突项会回报并把原因写给你，其余操作照常生效；不要因为害怕冲突就不提交。',
        '  如果本轮已经过了一段时间，提交前先 fgs_preview 复核一次最新图。',
      ];
    }
    if (activity === 'bootstrap') {
      return [
        '',
        '本轮 = Bootstrap（冷启动直冲）。可用工具：fgs_status / fgs_preview / fgs_submit_fact /',
        '  fgs_commit_step / fgs_satisfy_goal / fgs_commit，环境执行工具照常可用。',
        '目标：用 fact_origin（题目信息）直接尝试拿到 goal_final 的见证，**跳过规划**。',
        '',
        '流程：先 fgs_submit_fact 写本轮 Fact；再 fgs_commit_step 收束这个 step。',
        '如果这条 Fact 就是 goal_final 的见证（拿到 flag / 利用成功证据），收束后**立刻**用',
        '  fgs_satisfy_goal 标记达成：goalId=goal_final、satisfiedBy=[刚写出的 fact id]、reason 写为什么这些证据足够；',
        '  satisfy_goal 只进草稿，还要再调一次 fgs_commit 才算落盘。',
        '拿不到见证也必须落一条显式观察 Fact（试了什么、看到什么、往哪个方向继续），不要空手退出。',
        '结束信号：satisfy_goal 成功（或确认本轮无法达成）后立即结束回合，不要再起新的探索。',
      ];
    }
    return [
      '',
      '本轮 = Execute（执行）。可用工具只有 fgs_status / fgs_preview / fgs_submit_fact / fgs_commit_step。',
      '图操作工具（open/drop/satisfy/reopen 等）本轮**没有注册**，规划是 Decide 的事；不要尝试。',
      '',
      '流程：先 fgs_submit_fact 写本轮要落的新 Fact（title≤120 字；正文超 8KiB 时写产物文件路径），',
      '再 fgs_commit_step 收束这个 step。',
      '结束信号：fgs_commit_step 成功落盘后，本轮就结束了 —— 不要再调用别的工具，直接结束回合。',
      '没有产出也必须落一条显式失败/观察 Fact（没有 fgs_submit_fact 时 commit_step 会写一条观察 Fact）。',
    ];
  })();

  return [...head, ...(conclude ? concludeRule : []), ...body, ...deadlineRule].join('\n');
}

/** 活动模式的运行时上下文：一张图 + 本轮边界 + 结束信号。 */
export function activityContextText({
  activity,
  store,
  graph,
  currentStep = null,
  runId = '',
  draftSummary = '',
  rolePrompt = '',
  blocked = '',
  injectMaxChars = 24000,
  stepLeaseMs = 0,
  sid = null,
  now = Date.now(),
  conclude = false,
  budgetMs = 0,
}) {
  if (!graph || !store) return '';
  const lines = [];
  const label = activity === 'execute'
    ? 'Execute（只推进一个 step，做完即退出）'
    : (activity === 'bootstrap'
      ? 'Bootstrap（冷启动直冲 goal，成功即判达成）'
      : 'Decide（只做规划/改图，做完即退出）');
  lines.push(`【FGS 本轮活动】${conclude ? '收束轮（conclude）' : label}`);
  if (runId) lines.push(`【run】${runId}`);
  if (conclude) {
    lines.push('【收束指令】上一轮超时，本轮只做收束：停止探索，把已确认内容写成 Fact 并 commit_step。');
  }
  if (budgetMs > 0) {
    lines.push(`【墙钟预算】约 ${Math.max(1, Math.round(budgetMs / 60000))} 分钟；到点会被强制结束并进入收束轮。`);
  }
  if (blocked) {
    lines.push(`【本轮不可执行】${blocked}`);
    lines.push('直接结束回合并退出 —— 不要调用任何工具（换 step / 重规划由编排器在下一个 run 决定）。');
  }
  if (typeof rolePrompt === 'string' && rolePrompt.trim()) lines.push(rolePrompt.trim());

  if (activity === 'execute' || activity === 'bootstrap') {
    if (currentStep) {
      lines.push(`【你负责的 step】${currentStep.id}: ${currentStep.action}`);
      if (Array.isArray(currentStep.from) && currentStep.from.length > 0) {
        lines.push(`【该 step 的输入 fact】${currentStep.from.join(', ')}`);
      }
    } else {
      lines.push('【你负责的 step】（没有可用 step：本轮应直接结束）');
    }
    if (activity === 'bootstrap') {
      const finals = (graph.goals ?? []).filter((goal) => goal.kind !== 'sub');
      lines.push(`【终止条件】${finals.map((goal) => `${goal.id}: ${goal.criterion}`).join(' | ') || '（缺 goal_final）'}`);
      lines.push('【结束信号】fgs_submit_fact → fgs_commit_step；若已拿到见证，随后立刻 fgs_satisfy_goal（satisfiedBy=刚写的 fact id）。');
    } else {
      lines.push('【结束信号】fgs_submit_fact → fgs_commit_step；commit_step 成功后立即结束回合。');
    }
  } else {
    const openSteps = (graph.steps ?? []).filter((step) => step.state === 'open');
    const goals = (graph.goals ?? []).filter((goal) => goal.kind !== 'sub');
    const subGoals = (graph.goals ?? []).filter((goal) => goal.kind === 'sub' && goal.state !== 'dropped');
    const finals = goals.map((goal) => `${goal.id}: ${goal.criterion}${goal.satisfiedAt ? ' [已满足]' : ''}`);
    lines.push(`【终止条件】${finals.join(' | ') || '（缺 goal_final，图未种题？）'}`);
    if (subGoals.length > 0) {
      lines.push(`【Sub Goal】${subGoals.map((goal) => `${goal.id}: ${goal.criterion}${goal.satisfiedAt ? ' [已满足]' : ''}`).join(' | ')}`);
    }
    const tag = (step) => {
      if (!step.owner) return 'unclaimed';
      if (sid && step.owner === sid) return 'mine';
      const at = Date.parse(step.claimedAt ?? step.createdAt ?? '');
      const fresh = Number.isFinite(at) && Number.isFinite(stepLeaseMs) && stepLeaseMs > 0
        ? now - at < stepLeaseMs
        : true;
      return fresh ? `held-by=${step.owner}` : '可接手(租约已过期)';
    };
    lines.push(`【open steps】${openSteps.length === 0
      ? '（无）'
      : openSteps.map((step) => `${step.id}[${step.priority}](${tag(step)})`).join(', ')}`);
    lines.push('【结束信号】fgs_commit 成功落盘后立即结束回合；没有改动就直接结束回合。');
  }
  if (draftSummary) lines.push(`【未提交草稿】${draftSummary}`);

  lines.push('');
  lines.push(activity === 'execute' || activity === 'bootstrap'
    ? store.focused(graph, { stepId: currentStep?.id ?? null, maxChars: injectMaxChars })
    : store.preview(graph));
  return lines.join('\n');
}
