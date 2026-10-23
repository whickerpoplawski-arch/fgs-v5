/**
 * 单写者 Controller + GraphStore（CONTRACT §2、§3、§5、§6、§7、§8）。
 *
 * - 磁盘主真相：YAML，顶层键仅 `facts` → `goals` → `steps`。
 * - 校验通过才 commit；校验失败拒写、不落盘。
 * - 写图路径强制过 hooks/validate_write（双保险，见 apply()）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { dump, load as parseYaml } from '../yaml.js';
import { preflight } from '../hooks/validate_write.js';
import {
  OP,
  WriteRejected,
  isValidPriority,
} from './ops.js';

export const FACT_CONTENT_MAX_BYTES = 8 * 1024;
export const FACT_TITLE_MAX_CHARS = 120;
export const ALLOWED_TOP_KEYS = Object.freeze(['facts', 'goals', 'steps']);

export function nowIsoZ() {
  return new Date().toISOString();
}

export function emptyGraph() {
  return { facts: [], goals: [], steps: [] };
}

/** 固定顶层顺序 facts → goals → steps，并省略 undefined 字段。 */
export function graphToDoc(graph) {
  const facts = graph.facts.map((f) => {
    const d = { id: f.id, title: f.title };
    if (f.content !== undefined && f.content !== null) d.content = f.content;
    if (f.createdAt !== undefined) d.createdAt = f.createdAt;
    if (f.producedBy !== undefined && f.producedBy !== null) d.producedBy = f.producedBy;
    if (f.findingType !== undefined && f.findingType !== null) d.findingType = f.findingType;
    if (f.kind !== undefined && f.kind !== null) d.kind = f.kind;
    return d;
  });
  const goals = graph.goals.map((g) => {
    const d = { id: g.id, kind: g.kind, criterion: g.criterion, createdAt: g.createdAt };
    if (g.satisfiedBy !== undefined && g.satisfiedBy !== null) d.satisfiedBy = g.satisfiedBy;
    if (g.satisfiedReason !== undefined && g.satisfiedReason !== null) d.satisfiedReason = g.satisfiedReason;
    if (g.satisfiedAt !== undefined && g.satisfiedAt !== null) d.satisfiedAt = g.satisfiedAt;
    // v2：Sub Goal 是一等公民，且「可动态增删」——删=标记 dropped，不删历史。
    // 只在 kind==='sub' 时落盘：既保持 goal_final 的 YAML 与旧版逐字节兼容
    //（fixtures / replay 的 canonical diff 不受影响），也避免 `state:` 与 step 的
    // state 在文本层面混淆（否则按 `state: "open"` 做文本断言会误命中 goal）。
    if (g.kind === 'sub') {
      if (g.parentId !== undefined && g.parentId !== null) d.parentId = g.parentId;
      if (g.state !== undefined && g.state !== null) d.state = g.state;
      if (g.droppedReason !== undefined && g.droppedReason !== null) d.droppedReason = g.droppedReason;
    }
    return d;
  });
  const steps = graph.steps.map((s) => {
    const d = {
      id: s.id,
      action: s.action,
      from: s.from ?? [],
      actor: s.actor,
      priority: s.priority,
      state: s.state,
      createdAt: s.createdAt,
    };
    if (s.to !== undefined && s.to !== null) d.to = s.to;
    if (s.reason !== undefined && s.reason !== null) d.reason = s.reason;
    // Cairn「Intent 认领」：owner/claimedAt 是图的一部分（可随时停止/恢复、跨会话可见）。
    if (s.owner !== undefined && s.owner !== null) d.owner = s.owner;
    if (s.claimedAt !== undefined && s.claimedAt !== null) d.claimedAt = s.claimedAt;
    if (s.linkedUnfinishedFactId) d.linkedUnfinishedFactId = s.linkedUnfinishedFactId;
    return d;
  });
  return { facts, goals, steps };
}

/**
 * 图的确定性内容哈希（v5.2）。
 *
 * 用「序列化后的 YAML 文本」而不是 JSON.stringify：同一张图必须得到同一个 rev，
 * 而 graphToDoc 已经固定了字段顺序与空值省略规则。**不落盘**（CONTRACT §2 冻结
 * graph.yaml 顶层键），只在内存/台账/HTTP 里流转。
 */
export function revisionOf(graph) {
  return createHash('sha256').update(dump(graphToDoc(graph))).digest('hex');
}

export function graphFromDoc(doc) {
  const src = doc ?? {};
  return {
    facts: (src.facts ?? []).map((f) => ({
      id: f.id,
      title: f.title ?? '',
      content: f.content ?? null,
      createdAt: f.createdAt === undefined || f.createdAt === null ? null : String(f.createdAt),
      producedBy: f.producedBy ?? null,
      findingType: f.findingType ?? null,
      kind: f.kind ?? null,
    })),
    goals: (src.goals ?? []).map((g) => ({
      id: g.id,
      kind: g.kind ?? 'final',
      criterion: g.criterion ?? '',
      createdAt: g.createdAt === undefined || g.createdAt === null ? '' : String(g.createdAt),
      satisfiedBy: g.satisfiedBy ?? null,
      satisfiedReason: g.satisfiedReason ?? null,
      satisfiedAt: g.satisfiedAt === undefined || g.satisfiedAt === null ? null : String(g.satisfiedAt),
      parentId: g.parentId ?? null,
      state: g.state ?? 'open',
      droppedReason: g.droppedReason ?? null,
    })),
    steps: (src.steps ?? []).map((s) => ({
      id: s.id,
      action: s.action ?? '',
      from: Array.isArray(s.from) ? s.from : [],
      actor: s.actor ?? 'agent',
      priority: s.priority ?? 'normal',
      state: s.state ?? 'open',
      createdAt: s.createdAt === undefined || s.createdAt === null ? '' : String(s.createdAt),
      to: s.to ?? null,
      reason: s.reason ?? null,
      owner: s.owner ?? null,
      claimedAt: s.claimedAt === undefined || s.claimedAt === null ? null : String(s.claimedAt),
      linkedUnfinishedFactId: s.linkedUnfinishedFactId ?? null,
    })),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nextId(prefix, ids) {
  let n = 0;
  const pat = `${prefix}_`;
  for (const id of ids) {
    if (typeof id === 'string' && id.startsWith(pat)) {
      const parsed = Number.parseInt(id.slice(pat.length), 10);
      if (Number.isFinite(parsed)) n = Math.max(n, parsed);
    }
  }
  return `${prefix}_${String(n + 1).padStart(3, '0')}`;
}

/* ------------------------------------------------------------- GraphStore */

export class GraphStore {
  /** @param {string} root 运行目录；graph.yaml / graph.json / graph.lock 落此。 */
  constructor(root, options = {}) {
    this.root = root;
    this.graphPath = path.join(root, 'graph.yaml');
    this.jsonPath = path.join(root, 'graph.json');
    this.lockPath = path.join(root, 'graph.lock');
    this.factContentMaxBytes = options.factContentMaxBytes ?? FACT_CONTENT_MAX_BYTES;
    this.factTitleMaxChars = options.factTitleMaxChars ?? FACT_TITLE_MAX_CHARS;
  }

  ensureDir() {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** 契约 §2：顶层键只允许 facts / goals / steps。 */
  load() {
    if (!fs.existsSync(this.graphPath)) return emptyGraph();
    const doc = parseYaml(fs.readFileSync(this.graphPath, 'utf8'));
    if (doc === null || doc === undefined) return emptyGraph();
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('graph.yaml 顶层必须是键值映射');
    }
    const extra = Object.keys(doc).filter((k) => !ALLOWED_TOP_KEYS.includes(k));
    if (extra.length > 0) {
      throw new Error(
        `graph.yaml 顶层键非法: ${extra.join(', ')}（CONTRACT §2 只允许 facts/goals/steps，`
        + '禁止 Intent/Hint/findings 等同义一等公民节点）',
      );
    }
    return graphFromDoc(doc);
  }

  /** 校验通过才落盘（storage 边界也拦一道）。 */
  save(graph) {
    const errs = this.validate(graph);
    if (errs.length > 0) throw new WriteRejected(`save 校验不过，拒写: ${errs.join('; ')}`);
    this.ensureDir();
    this.withLock(() => this.saveUnlocked(graph));
  }

  /** 读图 + 内容版本（同一把锁外的一致快照，v5.2 Decide 基线用）。 */
  loadWithRev() {
    const graph = this.load();
    return { graph, rev: revisionOf(graph) };
  }

  /**
   * 原子读改写（Cairn「Dispatcher 唯一写入者」的跨进程版本）。
   *
   * `load → fn → validate → save` 全程持写锁：并行活动（多个 Execute run）各自的
   * RMW 不会互相覆盖。`fn` 必须返回图（就地改同一对象也可以）。
   * 锁内不要再调 `save()` / `transact()`（非重入，会自锁）。
   */
  transact(fn) {
    return this.transactWithRev((graph) => ({ graph: fn(graph) ?? graph })).graph;
  }

  /**
   * 事务 + 版本（v5.2）：`fn(graph, { rev })` 返回 `{ graph?, ...meta }`，
   * 返回 `{ graph, rev, baseRev, ...meta }`。`rev` 是**写入后**的内容哈希，
   * `baseRev` 是进入临界区时读到的版本（调用方据此判断是否被并发改过）。
   */
  transactWithRev(fn) {
    this.ensureDir();
    return this.withLock(() => {
      const graph = this.load();
      const baseRev = revisionOf(graph);
      const out = fn(graph, { rev: baseRev }) ?? {};
      const next = out.graph ?? graph;
      const errs = this.validate(next);
      if (errs.length > 0) throw new WriteRejected(`transact 校验不过，拒写: ${errs.join('; ')}`);
      this.saveUnlocked(next);
      return { ...out, graph: next, baseRev, rev: revisionOf(next) };
    });
  }

  withLock(fn) {
    const deadline = Date.now() + 5_000;
    let acquired = false;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // 陈旧锁（进程崩了）自愈
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > 10_000) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error(`获取写锁超时: ${this.lockPath}`);
        sleep(20);
      }
    }
    try {
      return fn();
    } finally {
      if (acquired) {
        try {
          fs.unlinkSync(this.lockPath);
        } catch {
          /* 已被清理 */
        }
      }
    }
  }

  saveUnlocked(graph) {
    const doc = graphToDoc(graph);
    const text = dump(doc);
    const tmp = `${this.graphPath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.writeFileSync(this.jsonPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.graphPath);
  }

  nextFactId(graph) {
    return nextId('fact', graph.facts.map((f) => f.id));
  }

  nextStepId(graph) {
    return nextId('step', graph.steps.map((s) => s.id));
  }

  toYaml(graph) {
    return dump(graphToDoc(graph));
  }

  /**
   * 任务池压缩（v2：open step 就是任务池，可能有几十上百个）。
   *
   * Cairn 语义下「一个 step = 一个可从图里认领的任务」，所以图里同时存在几十个 open step 是**常态**。
   * 若把每个 step 的完整 action 都注入，注入量又会随任务池线性膨胀（和 facts 那个坑一模一样）。
   * 折中（**分级压缩**）：**只有「当前 step」保留完整 action**；
   * 其余 open step 前 `maxDetailedOpen` 个给「id/state/priority/from/owner + action 前 N 字」摘要；
   * **再往后的 open step 只留 id+state+priority**（细节用 `fgs_preview` / `fgs_status` 现查）——
   * 这一步很关键：任务池尾部**绝不能因为硬截断而整条消失**，否则 worker 就「看不见任务」了。
   * 因此约定：**step action 必须把「做什么」写在最前面**（关键标识不能被截掉）。
   */
  #compactSteps(doc, stepId, actionChars, maxDetailedOpen = 32) {
    let openSeen = 0;
    doc.steps = (doc.steps ?? []).map((s) => {
      if (s.id === stepId) return s;
      const isOpen = s.state === 'open';
      if (isOpen) openSeen += 1;
      if (isOpen && openSeen > maxDetailedOpen) {
        const tiny = { id: s.id, state: 'open', priority: s.priority };
        if (s.linkedUnfinishedFactId) tiny.linkedUnfinishedFactId = s.linkedUnfinishedFactId;
        return tiny;
      }
      const short = { id: s.id };
      if (s.state !== undefined) short.state = s.state;
      if (s.priority !== undefined) short.priority = s.priority;
      if (s.from) short.from = s.from;
      if (s.owner) short.owner = s.owner;
      if (s.linkedUnfinishedFactId) short.linkedUnfinishedFactId = s.linkedUnfinishedFactId;
      if (s.to) short.to = s.to;
      if (s.droppedReason) short.droppedReason = s.droppedReason;
      if (s.action) {
        short.action = s.action.length > actionChars
          ? `${s.action.slice(0, actionChars)}…` : s.action;
      }
      return short;
    });
  }

  /** fact 仅 id+title；step 的 action 也压成摘要（任务池可能上百条）。 */
  preview(graph, { stepActionChars = 200 } = {}) {
    const doc = graphToDoc(graph);
    doc.facts = doc.facts.map((f) => ({ id: f.id, title: f.title }));
    this.#compactSteps(doc, null, stepActionChars);
    return dump(doc);
  }

  /**
   * Execute 轮的**因果邻域投影**（v2 上下文预算修复）。
   *
   * 背景（实测）：`roleContextText` 原本给 Execute 注入 `toYaml(graph)` —— **整张图的全部 fact 正文**，
   * 而图是「只追加」的（facts 只增不减），于是**每个回合的注入量单调增长、没有上限**。
   * 实测在一次真实跑分里，被测模型自己在 reasoning 里抱怨：
   *   "The context bloat is a problem — each turn re-injects a huge context."
   * 并据此**主动减少回合数**（96 次工具调用只肯用 8 次 FGS 调用），
   * 直接侵蚀 v2 的核心目标「图是唯一真记忆、执行过程中持续外部化」。
   *
   * 策略（保因果链、砍旁支、绝不静默丢）：
   *   1. `fact_origin` 永远是根，保留正文。
   *   2. **因果链必需**（当前 step 的 `from` + 其他 open step 的 `from`）保留正文。
   *   3. 其余 fact 一律降级为 `id + title` 单行。
   *   4. 仍超预算时，**先**把「非当前 step 的因果链」也降级（当前 step 自己那条链最后才动）。
   *   5. 还超预算才硬截断，并且**显式**写出截断标记（契约老毛病就是「静默失效」，这里不重犯）。
   *
   * @param {object} graph
   * @param {{stepId?: string|null, maxChars?: number, truncateMarker?: string}} opts
   */
  focused(graph, {
    stepId = null, maxChars = 24000, truncateMarker = '…（注入已按因果邻域截断）',
    openStepActionChars = 100,
  } = {}) {
    const steps = graph.steps ?? [];
    const openSteps = steps.filter((s) => s.state === 'open');
    const cur = steps.find((s) => s.id === stepId) ?? null;
    const curChain = new Set(cur?.from ?? []);
    const otherChain = new Set();
    for (const s of openSteps) {
      if (s.id === stepId) continue;
      for (const f of s.from ?? []) otherChain.add(f);
    }
    const build = (keepFull) => {
      const doc = graphToDoc(graph);
      doc.facts = doc.facts.map((f) => {
        if (f.id === 'fact_origin') return f;
        if (keepFull.has(f.id)) return f;
        return { id: f.id, title: f.title };
      });
      // 任务池也要压：open step 可能有几十上百个，只有「我这一步」需要完整 action。
      this.#compactSteps(doc, stepId, openStepActionChars);
      return dump(doc);
    };
    let text = build(new Set([...curChain, ...otherChain]));
    if (text.length <= maxChars) return text;
    // 第 4 步：放开别家 open step 的因果链（本 step 那条链保留）
    text = build(new Set(curChain));
    if (text.length <= maxChars) return text;
    // 第 5 步：连本 step 的链也放开，再硬截断（显式标记）
    text = build(new Set());
    if (text.length <= maxChars) return text;
    const keep = Math.max(0, maxChars - truncateMarker.length - 1);
    return `${text.slice(0, keep)}\n${truncateMarker}\n`;
  }

  validate(graph) {
    const errs = [];
    const origins = graph.facts.filter((f) => f.id === 'fact_origin');
    if (origins.length !== 1) errs.push(`fact_origin 数量必须为 1，实际 ${origins.length}`);
    for (const f of graph.facts) {
      if (f.id !== 'fact_origin' && !(typeof f.id === 'string' && f.id.startsWith('fact_') && /^\d+$/.test(f.id.slice(5)))) {
        errs.push(`fact id 非法: ${f.id}`);
      }
    }
    // v2（Cairn_Y）：「Goal 描述项目的完成条件，即搜索的终止条件。**也存在可以动态增删的
    // Sub Goal**。」因此这里不再要求「只有一个 goal_final」：
    //   · 必须恰有一个 kind==final 的 goal_final（终止条件必须有且只有一个根）；
    //   · 其余 goal 必须是 kind==sub、id 形如 goal_xxx、且 parentId 指向已存在的 goal。
    // 只追加语义：Sub Goal 的「删除」是 state='dropped'，不是从数组里移除。
    const finals = graph.goals.filter((g) => g.id === 'goal_final');
    if (finals.length !== 1 || finals[0].kind !== 'final') {
      errs.push('goals 必须恰含一个 kind==final 的 goal_final');
    }
    const goalIds = new Set(graph.goals.map((g) => g.id));
    for (const g of graph.goals) {
      if (g.id === 'goal_final') {
        if (g.kind !== 'final') errs.push(`goal_final.kind 必须为 final: ${g.kind}`);
        continue;
      }
      if (g.kind !== 'sub') {
        errs.push(`非 goal_final 的 goal 必须是 kind==sub: ${g.id} kind=${g.kind}`);
      }
      if (!(typeof g.id === 'string' && /^goal_[a-z0-9_]+$/.test(g.id))) {
        errs.push(`Sub Goal id 非法（须 goal_xxx）: ${g.id}`);
      }
      if (g.parentId && !goalIds.has(g.parentId)) {
        errs.push(`Sub Goal parentId 引用不存在 goal: ${g.id} -> ${g.parentId}`);
      }
    }
    for (const s of graph.steps) {
      if (!(typeof s.id === 'string' && s.id.startsWith('step_') && /^\d+$/.test(s.id.slice(5)))) {
        errs.push(`step id 非法（须 step_NNN，CONTRACT §2）: ${s.id}`);
      }
    }
    const factIds = new Set(graph.facts.map((f) => f.id));
    const stepIds = new Set(graph.steps.map((s) => s.id));
    for (const f of graph.facts) {
      if (f.id !== 'fact_origin' && f.producedBy && !stepIds.has(f.producedBy)) {
        errs.push(`fact ${f.id}.producedBy 引用不存在 step: ${f.producedBy}`);
      }
    }
    for (const s of graph.steps) {
      for (const fid of s.from ?? []) {
        if (!factIds.has(fid)) errs.push(`step ${s.id}.from 引用不存在 fact: ${fid}`);
      }
      if (s.state === 'done') {
        if (!s.to) errs.push(`step ${s.id} state=done 但无 to`);
        else if (!factIds.has(s.to)) errs.push(`step ${s.id}.to 引用不存在 fact: ${s.to}`);
        else {
          const f = graph.facts.find((x) => x.id === s.to);
          if (f && f.producedBy !== s.id) {
            errs.push(`step ${s.id}.to fact.producedBy 不匹配: ${f.producedBy}`);
          }
        }
      }
      if (s.state === 'dropped' && !s.reason) errs.push(`step ${s.id} state=dropped 但无 reason`);
      if (s.linkedUnfinishedFactId && !factIds.has(s.linkedUnfinishedFactId)) {
        errs.push(`step ${s.id}.linkedUnfinishedFactId 引用不存在 fact: ${s.linkedUnfinishedFactId}`);
      }
    }
    for (const g of graph.goals) {
      for (const fid of g.satisfiedBy ?? []) {
        if (!factIds.has(fid)) errs.push(`goal ${g.id}.satisfiedBy 引用不存在 fact: ${fid}`);
      }
    }
    return errs;
  }
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* 同步等待极小间隔：写锁重试 */
  }
}

/* -------------------------------------------------------------- Controller */

/**
 * 单写者。只有 Controller 改图；所有写入经 validate，失败拒写不落盘。
 * @param {GraphStore} store
 * @param {{verifyHook?: (graph:object, op:object)=>string|null}} [options]
 */
export class Controller {
  constructor(store, options = {}) {
    this.store = store;
    this.verifyHook = options.verifyHook ?? null;
    this.claimOptions = options.claimOptions ?? {};
    this.findingTypes = options.findingTypes ?? [];
    this.applied = [];
    this.rejected = [];
  }

  /** 校验并应用一个 op；返回新图（未落盘）。失败抛 WriteRejected。 */
  apply(op, graph = null) {
    const current = graph ?? this.store.load();
    preflight(op); // CONTRACT §3：写图路径强制过 hooks/validate_write
    const next = clone(current);
    const desc = this.applyOp(next, op);
    const errs = this.store.validate(next);
    if (errs.length > 0) {
      this.rejected.push(desc);
      throw new WriteRejected(errs.join('; '));
    }
    this.applied.push(desc);
    return next;
  }

  /** 校验通过后落盘（CONTRACT §3：校验失败拒写、不落盘）。 */
  commit(graph) {
    const errs = this.store.validate(graph);
    if (errs.length > 0) throw new WriteRejected(`commit 校验不过，拒写: ${errs.join('; ')}`);
    this.store.save(graph);
  }

  applyAndCommit(op, graph = null) {
    const next = this.apply(op, graph);
    this.commit(next);
    return next;
  }

  /**
   * 原子 RMW：持写锁重新 load → `fn(graph)` 应用操作 → 校验 → 落盘。
   *
   * 与 `apply + commit` 的区别：后者的 graph 是调用方在锁外读的，两个并行
   * Execute run 会各自基于同一份旧图写回，后写的覆盖先写的（丢 Fact / 丢认领）。
   * 所有写图路径都必须走这里；读路径仍可直接 `store.load()`。
   */
  transact(fn) {
    return this.store.transact((graph) => fn(graph) ?? graph);
  }

  /**
   * 批量应用（v5.2 Decide rebase）。
   *
   * - `rebase=false`：与「逐项 apply + 一次 save」等价，任一失败整体抛 WriteRejected
   *   （v5.1 strict 行为，legacy/Execute 路径继续用）。
   * - `rebase=true`：逐项降级——冲突项进 `rejected`，其余照常应用并落盘；返回
   *   `{ graph, applied, rejected, rebased, revBefore, rev, baseRev }`。
   *
   * 整个批次在同一把写锁内完成：读到的图是最新的，因此 Describe→Commit 之间被
   * 并发 Execute 改过的图不会丢失（逐项按最新状态重新判定）。
   */
  applyBatch(ops, { rebase = false, baseRev = null } = {}) {
    return this.store.transactWithRev((graph, { rev }) => {
      const applied = [];
      const rejected = [];
      let working = graph;
      for (const op of ops) {
        try {
          working = this.apply(op, working);
          applied.push(op?.type);
        } catch (error) {
          if (rebase && error instanceof WriteRejected) {
            rejected.push({ op: op?.type, detail: error.message });
            continue;
          }
          throw error;
        }
      }
      return {
        graph: working,
        applied,
        rejected,
        rebased: baseRev !== null && rev !== baseRev,
        revBefore: rev,
      };
    });
  }

  /** 不抛异常版本：返回 { graph, error, desc }。 */
  safeApply(op, graph = null) {
    try {
      const next = this.apply(op, graph);
      return { graph: next, error: null };
    } catch (error) {
      if (error instanceof WriteRejected) return { graph: null, error: error.message };
      throw error;
    }
  }

  applyOp(graph, op) {
    switch (op?.type) {
      case OP.OPEN_STEP:
        return this.openStep(graph, op);
      case OP.CLAIM_STEP:
        return this.claimStep(graph, op, this.claimOptions);
      case OP.ADD_SUBGOAL:
        return this.addSubGoal(graph, op);
      case OP.DROP_SUBGOAL:
        return this.dropSubGoal(graph, op);
      case OP.DROP_STEP:
        return this.dropStep(graph, op);
      case OP.CHANGE_PRIORITY:
        return this.changePriority(graph, op);
      case OP.SUBMIT_FACT:
        return this.submitFact(graph, op);
      case OP.SEED_ORIGIN:
        return this.seedOrigin(graph, op);
      case OP.SATISFY_GOAL:
        return this.satisfyGoal(graph, op);
      case OP.REOPEN:
        return this.reopen(graph, op);
      case OP.RELEASE_STEP:
        return this.releaseStep(graph, op);
      default:
        throw new WriteRejected(`未知操作类型: ${op?.type}`);
    }
  }

  openStep(graph, op) {
    if (!Array.isArray(op.from) || op.from.length === 0) {
      throw new WriteRejected('open_step 无 from（因果拒写，CONTRACT §8）');
    }
    const sid = op.stepId || this.store.nextStepId(graph);
    if (!(typeof sid === 'string' && sid.startsWith('step_') && /^\d+$/.test(sid.slice(5)))) {
      throw new WriteRejected(
        `step id 非法（须 step_NNN，例如 step_001）: ${sid}。勿把动作名当 id；留空则自动分配。`,
      );
    }
    if (graph.steps.some((s) => s.id === sid)) throw new WriteRejected(`step id 已存在: ${sid}`);
    const factIds = new Set(graph.facts.map((f) => f.id));
    for (const fid of op.from) {
      if (!factIds.has(fid)) throw new WriteRejected(`open_step.from 引用不存在 fact: ${fid}`);
    }
    if (!isValidPriority(op.priority)) throw new WriteRejected(`priority 非法: ${op.priority}`);
    graph.steps.push({
      id: sid,
      action: op.action ?? '',
      from: [...op.from],
      actor: op.actor ?? 'agent',
      priority: op.priority,
      state: 'open',
      createdAt: nowIsoZ(),
      to: null,
      reason: null,
      owner: op.owner ?? null,
      claimedAt: op.claimedAt ?? (op.owner ? nowIsoZ() : null),
    });
    return `open_step ${sid}`;
  }

  /**
   * claim_step：认领/续租一个 open step（Cairn：Intent 认领有心跳超时与自动释放）。
   *
   * 只允许认领「未认领」或「租约已过期」的 step；被其他会话在租约内持有时拒写。
   * `leaseMs <= 0` 视为不检查租约（用于显式夺取/测试）。
   */
  claimStep(graph, op, { leaseMs = 0 } = {}) {
    const step = graph.steps.find((s) => s.id === op.stepId);
    if (!step) throw new WriteRejected(`claim_step 目标不存在: ${op.stepId}`);
    if (step.state !== 'open') {
      throw new WriteRejected(`claim_step 目标不是 open step: ${op.stepId}（state=${step.state}）`);
    }
    if (!op.owner) throw new WriteRejected('claim_step 缺 owner');
    const now = Date.now();
    const held = step.owner
      && step.owner !== op.owner
      && leaseMs > 0
      && Number.isFinite(Date.parse(step.claimedAt ?? ''))
      && now - Date.parse(step.claimedAt) < leaseMs;
    if (held) {
      throw new WriteRejected(
        `step ${op.stepId} 已被会话 ${step.owner} 认领且租约未过期；`
        + '不能跨会话收束（Cairn：Dispatcher 才是协议的唯一写入者，Agent 不得抢写别人的 Intent）。',
      );
    }
    step.owner = op.owner;
    step.claimedAt = op.claimedAt ?? nowIsoZ();
    return `claim_step ${op.stepId} -> ${op.owner}`;
  }

  /**
   * Execute 会话超时：追加一条未完成 Fact（不把 step 收成 done），
   * 释放该 owner 名下全部 open step 的认领。目标 step 记下 linkedUnfinishedFactId。
   * 幂等：已经挂过未完成 Fact 时**不再追加**（并行重试会反复超时，重复 Fact 只会污染黑板），
   * 只把该 owner 的认领清回任务池。
   */
  releaseStep(graph, op) {
    if (!hasText(op.stepId) || !hasText(op.factTitle) || !hasText(op.factContent)) {
      throw new WriteRejected('release_step 缺 stepId/factTitle/factContent（禁止空超时）');
    }
    const step = findStep(graph, op.stepId);
    if (step.state !== 'open') {
      throw new WriteRejected(`release_step 目标不是 open step: ${op.stepId}（state=${step.state}）`);
    }
    if (step.linkedUnfinishedFactId) {
      const owner = step.owner;
      if (owner) {
        for (const other of graph.steps) {
          if (other.state === 'open' && other.owner === owner) {
            other.owner = null;
            other.claimedAt = null;
          }
        }
      }
      return `release_step ${op.stepId} already -> ${step.linkedUnfinishedFactId}`;
    }
    this.checkFactDistill(op.factTitle, op.factContent);
    const fid = this.store.nextFactId(graph);
    graph.facts.push({
      id: fid,
      title: op.factTitle,
      content: op.factContent,
      createdAt: nowIsoZ(),
      producedBy: step.id,
      findingType: null,
      kind: 'unfinished',
    });
    const owner = step.owner;
    step.linkedUnfinishedFactId = fid;
    if (owner) {
      for (const other of graph.steps) {
        if (other.state === 'open' && other.owner === owner) {
          other.owner = null;
          other.claimedAt = null;
        }
      }
    } else {
      step.owner = null;
      step.claimedAt = null;
    }
    return `release_step ${op.stepId} -> ${fid}`;
  }

  dropStep(graph, op) {
    if (!hasText(op.reason)) throw new WriteRejected('drop_step 缺 reason（拒收，CONTRACT §4）');
    const step = findStep(graph, op.stepId);
    if (step.state !== 'open') {
      throw new WriteRejected(`drop_step 目标非 open: ${op.stepId} state=${step.state}`);
    }
    step.state = 'dropped';
    step.reason = op.reason;
    return `drop_step ${op.stepId}`;
  }

  /** v2：Sub Goal —— Goal 是「搜索的终止条件」，可动态增删。只追加，不修改既有 goal。 */
  addSubGoal(graph, op) {
    if (!hasText(op.criterion)) {
      throw new WriteRejected('add_subgoal 缺 criterion（Sub Goal 必须写清达成标准）');
    }
    const parentId = op.parentId || 'goal_final';
    if (!graph.goals.some((g) => g.id === parentId)) {
      throw new WriteRejected(`add_subgoal.parentId 引用不存在 goal: ${parentId}`);
    }
    const used = new Set(graph.goals.map((g) => g.id));
    let gid = op.goalId || null;
    if (gid) {
      if (used.has(gid)) throw new WriteRejected(`goal id 已存在: ${gid}`);
      if (!/^goal_[a-z0-9_]+$/.test(gid)) throw new WriteRejected(`goal id 非法（须 goal_xxx）: ${gid}`);
    } else {
      let n = 1;
      while (used.has(`goal_sub_${String(n).padStart(3, '0')}`)) n += 1;
      gid = `goal_sub_${String(n).padStart(3, '0')}`;
    }
    graph.goals.push({
      id: gid,
      kind: 'sub',
      criterion: op.criterion,
      createdAt: nowIsoZ(),
      parentId,
      state: 'open',
      satisfiedBy: null,
      satisfiedReason: null,
      satisfiedAt: null,
      droppedReason: null,
    });
    return `add_subgoal ${gid}`;
  }

  /** v2：Sub Goal 可动态删除 —— 但图是「只追加」的，所以是**标记 dropped**，历史仍在。 */
  dropSubGoal(graph, op) {
    if (!hasText(op.reason)) throw new WriteRejected('drop_subgoal 缺 reason（拒收）');
    const goal = graph.goals.find((g) => g.id === op.goalId);
    if (!goal) throw new WriteRejected(`drop_subgoal 目标不存在: ${op.goalId}`);
    if (goal.kind !== 'sub') {
      throw new WriteRejected(`drop_subgoal 只能删 Sub Goal，不能删 ${op.goalId}（kind=${goal.kind}）`);
    }
    if (goal.state === 'dropped') throw new WriteRejected(`drop_subgoal 目标已 dropped: ${op.goalId}`);
    goal.state = 'dropped';
    goal.droppedReason = op.reason;
    return `drop_subgoal ${op.goalId}`;
  }

  changePriority(graph, op) {
    if (!isValidPriority(op.priority)) throw new WriteRejected(`priority 非法: ${op.priority}`);
    const step = findStep(graph, op.stepId);
    if (step.state !== 'open') {
      throw new WriteRejected(`change_priority 目标非 open: ${op.stepId} state=${step.state}`);
    }
    step.priority = op.priority;
    return `change_priority ${op.stepId} -> ${op.priority}`;
  }

  submitFact(graph, op) {
    this.checkFactDistill(op.title, op.content);
    if (!hasText(op.producedBy)) {
      throw new WriteRejected('submit_fact 无 producedBy（origin 种子除外，拒写，CONTRACT §8）');
    }
    const step = graph.steps.find((s) => s.id === op.producedBy);
    if (!step) throw new WriteRejected(`submit_fact.producedBy 引用不存在 step: ${op.producedBy}`);
    if (step.state !== 'open') {
      throw new WriteRejected(
        `submit_fact.producedBy 指向非 open step: ${op.producedBy} state=${step.state}`,
      );
    }
    const findingType = op.findingType ?? null;
    if (findingType !== null && !hasText(findingType)) {
      throw new WriteRejected('submit_fact.findingType 不得为空白（要么不写，要么写类型）');
    }
    if (findingType !== null && Array.isArray(this.findingTypes) && this.findingTypes.length > 0
      && !this.findingTypes.includes(findingType)) {
      throw new WriteRejected(
        `findingType 非法: ${findingType}（当前允许: ${this.findingTypes.join(', ')}）——`
        + 'Finding 的类型可动态定义，改 config.findingTypes 即可扩展',
      );
    }
    if (findingType !== null && findingType.length > 64) {
      throw new WriteRejected('submit_fact.findingType 过长（>64）');
    }
    const fid = this.store.nextFactId(graph);
    if (graph.facts.some((f) => f.id === fid)) throw new WriteRejected(`fact id 已存在: ${fid}`);
    graph.facts.push({
      id: fid,
      title: op.title,
      content: op.content,
      createdAt: nowIsoZ(),
      producedBy: op.producedBy,
      findingType,
    });
    step.state = 'done';
    step.to = fid;
    return `submit_fact ${fid} (by ${op.producedBy})`;
  }

  seedOrigin(graph, op) {
    if (graph.facts.some((f) => f.id === 'fact_origin')) throw new WriteRejected('fact_origin 已存在');
    this.checkFactDistill(op.title, op.content);
    const now = nowIsoZ();
    graph.facts.push({ id: 'fact_origin', title: op.title, content: op.content, createdAt: now, producedBy: null });
    graph.goals.push({
      id: 'goal_final',
      kind: 'final',
      criterion: op.criterion,
      createdAt: now,
      satisfiedBy: null,
      satisfiedReason: null,
      satisfiedAt: null,
    });
    return 'seed_origin';
  }

  satisfyGoal(graph, op) {
    if (!op.goalId || !hasText(op.reason) || !Array.isArray(op.satisfiedBy) || op.satisfiedBy.length === 0) {
      throw new WriteRejected('satisfy_goal 缺 goalId/reason/satisfiedBy 任一字段，拒收（CONTRACT §4）');
    }
    const goal = graph.goals.find((g) => g.id === op.goalId);
    if (!goal) throw new WriteRejected(`goal 不存在: ${op.goalId}`);
    const factIds = new Set(graph.facts.map((f) => f.id));
    for (const fid of op.satisfiedBy) {
      if (!factIds.has(fid)) throw new WriteRejected(`satisfiedBy 引用不存在 fact: ${fid}`);
    }
    // FLAG 外部校验 hook（CONTRACT §8）：不过则不写 satisfied*
    if (this.verifyHook) {
      const err = this.verifyHook(graph, op);
      if (err) throw new WriteRejected(`satisfy_goal verify hook 拒绝: ${err}`);
    }
    goal.satisfiedBy = [...op.satisfiedBy];
    goal.satisfiedReason = op.reason;
    goal.satisfiedAt = nowIsoZ();
    return `satisfy_goal ${op.goalId}`;
  }

  reopen(graph, op) {
    if (!op.goalId || !hasText(op.reason)) {
      throw new WriteRejected('reopen 缺 goalId/reason（reason 不得为空或空白）');
    }
    const goal = graph.goals.find((g) => g.id === op.goalId);
    if (!goal) throw new WriteRejected(`goal 不存在: ${op.goalId}`);
    // 清空 satisfied*（CONTRACT §6）；永不删历史 Fact/Step
    goal.satisfiedBy = null;
    goal.satisfiedReason = null;
    goal.satisfiedAt = null;
    const title = op.feedbackTitle || truncateChars(op.reason, this.store.factTitleMaxChars);
    this.checkFactDistill(title, op.reason);
    const fid = this.store.nextFactId(graph);
    graph.facts.push({
      id: fid,
      title,
      content: op.reason,
      createdAt: nowIsoZ(),
      producedBy: null,
    });
    return `reopen ${op.goalId} + feedback ${fid}`;
  }

  /** 契约 §7：title ≤ N 字；content 超阈值时必须是文件路径。 */
  checkFactDistill(title, content) {
    const titleText = title ?? '';
    if ([...titleText].length > this.store.factTitleMaxChars) {
      throw new WriteRejected(
        `fact title 超 ${this.store.factTitleMaxChars} 字: ${[...titleText].length}（CONTRACT §7）`,
      );
    }
    if (content === undefined || content === null || content === '') return;
    const bytes = Buffer.byteLength(String(content), 'utf8');
    if (bytes <= this.store.factContentMaxBytes) return;
    // 超阈值时 content 必须整体就是一个文件路径：不能是「路径 + 大段正文」
    const text = String(content);
    const stripped = text.trim();
    const isPath = stripped.length > 0
      && text === stripped
      && !/\s/.test(stripped) // 路径里不允许空白（换行/空格/制表符一律视为塞了正文）
      // eslint-disable-next-line no-control-regex
      && !/[\u0000-\u001f]/.test(stripped)
      && Buffer.byteLength(stripped, 'utf8') < 4096
      && !'{[<'.includes(stripped[0])
      && (stripped.includes('/')
        || stripped.includes('\\')
        || /\.(txt|json|log|md|csv|tsv|yaml|yml|html|htm|xml|png|jpe?g|gif|pdf|zip|bin)$/i.test(stripped));
    if (!isPath) {
      throw new WriteRejected(
        `fact content 超 ${this.store.factContentMaxBytes} 字节且不是单个文件路径，拒写（CONTRACT §7）`,
      );
    }
  }
}

function findStep(graph, sid) {
  const step = graph.steps.find((s) => s.id === sid);
  if (!step) throw new WriteRejected(`step 不存在: ${sid}`);
  return step;
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function truncateChars(text, max) {
  return [...String(text)].slice(0, max).join('');
}

export { WriteRejected };
export * from './ops.js';
