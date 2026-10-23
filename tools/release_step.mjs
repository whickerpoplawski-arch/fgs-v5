#!/usr/bin/env node
/**
 * 释放一个死 run 的 step 认领（v5：owner 是 runId，所以编排器能精确回收）。
 *
 * 什么时候需要它：活动 run 被 SIGKILL（没有信号兜底）时，它认领的 step 会留在
 * 图里 `owner=<runId>, state=open`。图上的认领是 Cairn 的「Intent 认领」，
 * 不释放就会被判为「被别人持有」，整道题空等租约到期。
 *
 * 语义与插件 timeoutSettle 一致：**追加一条未完成 Fact**，再把 owner/claimedAt
 * 清回 null（step 仍 open，可被下一个 run 认领）。幂等：step 已 done/dropped、
 * 或 owner 已经不是 `--owner` 时什么都不做。
 *
 * 用法:
 *   node tools/release_step.mjs --cwd <dir> --problem-id <id> --step step_003 --owner run-01 \
 *     [--state-dir .fgs] [--reason "活动超时"]
 *
 * stdout 一行 JSON；成功 exit 0（包括「无需释放」），参数/图错误 exit 1。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore, WriteRejected } from '../controller/index.js';
import { releaseStepOp } from '../controller/ops.js';

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

const HELP = `release_step — 释放一个死 run 认领的 step（追加未完成 Fact，step 保持 open）

  node tools/release_step.mjs --cwd <dir> --problem-id <id> --step <stepId> --owner <runId>
      [--state-dir .fgs] [--reason <text>]

输出一行 JSON：{ok, released|skipped, stepId, owner, factId?}
`;

export function normalizeProblemId(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
}

/**
 * @param {{cwd:string, problemId:string, stepId:string, owner:string, stateDir?:string, reason?:string}} options
 */
export function releaseStep(options = {}) {
  const problemId = normalizeProblemId(options.problemId);
  if (!options.cwd) throw new ReleaseError('缺 cwd');
  if (!problemId) throw new ReleaseError('缺 problemId');
  if (!options.stepId) throw new ReleaseError('缺 step');
  if (!options.owner) throw new ReleaseError('缺 owner');
  const root = path.resolve(options.cwd, options.stateDir || '.fgs', 'projects', problemId);
  const store = new GraphStore(root);
  const graph = store.load();
  const step = (graph.steps ?? []).find((item) => item.id === options.stepId);
  const base = { stepId: options.stepId, owner: options.owner, problemId };
  if (!step) return { ok: true, skipped: 'no-step', ...base };
  if (step.state !== 'open') return { ok: true, skipped: `step-${step.state}`, ...base };
  if (step.owner !== options.owner) {
    return { ok: true, skipped: `owner=${step.owner ?? 'null'}`, ...base };
  }
  const reason = String(options.reason ?? '活动 run 已死亡（未落盘）').slice(0, 160);
  const op = releaseStepOp({
    stepId: options.stepId,
    factTitle: `${options.stepId} 未完成：活动 run 中断`,
    factContent: `run=${options.owner} 未在结束前收束本 step。原因：${reason}。`
      + '按 Cairn 语义追加一条未完成 Fact，并把认领放回任务池（step 仍 open，可被下一个 run 认领）。',
  });
  const controller = new Controller(store);
  try {
    // 锁内基于最新图回收：并行活动可能刚改过图，锁外的 pre-check 只用于提前返回。
    const next = controller.transact((locked) => controller.apply(op, locked));
    const updated = (next.steps ?? []).find((item) => item.id === options.stepId);
    return {
      ok: true,
      released: true,
      ...base,
      factId: updated?.linkedUnfinishedFactId ?? null,
    };
  } catch (error) {
    if (error instanceof WriteRejected) throw new ReleaseError(`release 拒收: ${error.message}`);
    throw error;
  }
}

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new ReleaseError(`参数 ${arg} 缺值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--cwd': out.cwd = take(); break;
      case '--problem-id': out.problemId = take(); break;
      case '--state-dir': out.stateDir = take(); break;
      case '--step': out.stepId = take(); break;
      case '--owner': out.owner = take(); break;
      case '--reason': out.reason = take(); break;
      case '-h':
      case '--help': out.help = true; break;
      default: throw new ReleaseError(`未知参数: ${arg}`);
    }
  }
  return out;
}

function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      process.stdout.write(HELP);
      return;
    }
    const result = releaseStep({
      cwd: args.cwd || process.env.FGS_WORKSPACE || process.cwd(),
      problemId: args.problemId || process.env.FGS_PROBLEM_ID,
      stateDir: args.stateDir || process.env.FGS_STATE_DIR,
      stepId: args.stepId,
      owner: args.owner,
      reason: args.reason,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error?.message ?? String(error);
    process.stderr.write(`release_step: ${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
