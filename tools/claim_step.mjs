#!/usr/bin/env node
/**
 * 由编排器**预认领**一个 step（v5 并行活动 / Cairn Dispatcher 的派发语义）。
 *
 * 为什么认领要在起进程之前、由编排器做：
 *   Cairn v1 的 dispatcher 是先 `POST heartbeat`（把 intent 认领给自己派的 worker）
 *   再发任务；worker 只是执行者。这样「同一时刻不会有两个 worker 跑同一个 intent」
 *   由**单写者的一次写**保证，而不是靠两个 worker 抢锁。
 *   我们这里同构：编排器串行地 claim → spawn 子进程，子进程用同一个 runId 作为 owner，
 *   所以多个 Execute 并行时不会撞车（撞车只可能发生在编排器自己的选择里）。
 *
 * 用法:
 *   node tools/claim_step.mjs --cwd <dir> --problem-id <id> --step step_003 --owner run-01 \
 *     [--state-dir .fgs] [--lease-ms 750000]
 *
 * stdout 一行 JSON：
 *   {ok:true, claimed:true, stepId, owner}                    认领成功
 *   {ok:true, skipped:"step-done|no-step|held-by=<owner>", ...} 无需/不能认领（幂等）
 * 参数错误 / 图读不了：{ok:false,error} + exit 1。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore, WriteRejected } from '../controller/index.js';
import { claimStepOp } from '../controller/ops.js';

export class ClaimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaimError';
  }
}

const HELP = `claim_step — 编排器预认领一个 open step

  node tools/claim_step.mjs --cwd <dir> --problem-id <id> --step <stepId> --owner <runId>
      [--state-dir .fgs] [--lease-ms <ms>]

输出一行 JSON：{ok, claimed|skipped, stepId, owner}
`;

export function normalizeProblemId(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
}

/**
 * @param {{cwd:string, problemId:string, stepId:string, owner:string,
 *          stateDir?:string, leaseMs?:number}} options
 */
export function claimStep(options = {}) {
  const problemId = normalizeProblemId(options.problemId);
  if (!options.cwd) throw new ClaimError('缺 cwd');
  if (!problemId) throw new ClaimError('缺 problemId');
  if (!options.stepId) throw new ClaimError('缺 step');
  if (!options.owner) throw new ClaimError('缺 owner');
  const root = path.resolve(options.cwd, options.stateDir || '.fgs', 'projects', problemId);
  const store = new GraphStore(root);
  const base = { stepId: options.stepId, owner: options.owner, problemId };
  // 锁外 pre-check 只用于「明显不需要写」的快速返回；真正的判定在锁里由 Controller 做。
  const graph = store.load();
  const step = (graph.steps ?? []).find((item) => item.id === options.stepId);
  if (!step) return { ok: true, skipped: 'no-step', ...base };
  if (step.state !== 'open') return { ok: true, skipped: `step-${step.state}`, ...base };
  if (step.owner && step.owner !== options.owner) {
    const claimedAt = Date.parse(step.claimedAt ?? '');
    const leaseMs = Number(options.leaseMs ?? 0);
    const fresh = !(leaseMs > 0) || !Number.isFinite(claimedAt) || Date.now() - claimedAt < leaseMs;
    if (fresh) return { ok: true, skipped: `held-by=${step.owner}`, ...base };
  }
  const controller = new Controller(store, { claimOptions: { leaseMs: Number(options.leaseMs ?? 0) } });
  try {
    controller.transact((locked) => controller.apply(claimStepOp({
      stepId: options.stepId,
      owner: options.owner,
    }), locked));
    return { ok: true, claimed: true, ...base };
  } catch (error) {
    if (error instanceof WriteRejected) throw new ClaimError(`claim 拒收: ${error.message}`);
    throw error;
  }
}

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new ClaimError(`参数 ${arg} 缺值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--cwd': out.cwd = take(); break;
      case '--problem-id': out.problemId = take(); break;
      case '--state-dir': out.stateDir = take(); break;
      case '--step': out.stepId = take(); break;
      case '--owner': out.owner = take(); break;
      case '--lease-ms': out.leaseMs = Number(take()); break;
      case '-h':
      case '--help': out.help = true; break;
      default: throw new ClaimError(`未知参数: ${arg}`);
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
    const result = claimStep({
      cwd: args.cwd || process.env.FGS_WORKSPACE || process.cwd(),
      problemId: args.problemId || process.env.FGS_PROBLEM_ID,
      stepId: args.stepId,
      owner: args.owner,
      stateDir: args.stateDir || process.env.FGS_STATE_DIR,
      leaseMs: args.leaseMs,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error?.message ?? String(error);
    process.stderr.write(`claim_step: ${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
