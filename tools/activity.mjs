#!/usr/bin/env node
/**
 * 活动选择 CLI（v5）：给编排器（contest/activity_loop.py / supervisor / 测试）
 * 读一次图，回答「下一条该起什么 run」。
 *
 * 这个 CLI 是 kernel 与编排器之间唯一的判定入口：编排器不解析 graph.yaml，
 * 也不复制「先 Decide 还是先 Execute」的规则。规则只有一份，在 controller/activity.js。
 *
 * 用法:
 *   node tools/activity.mjs --cwd <workspace> --problem-id <id> \
 *     [--state-dir .fgs] [--step <stepId>] [--last-signature <sig>] \
 *     [--no-progress <n>] [--lease-ms <ms>] [--activities-left <n>] \
 *     [--findings-at-last-decide <n>] [--executes-since-decide <n>] [--decide-every <n>] \
 *     [--allow-decide-repeat]
 *
 * 成功时 stdout 一行 JSON（kind=decide|execute|done|wait|defer|budget），exit 0。
 * 图读不了 / 缺 problemId：stdout 一行 {ok:false,error} + exit 1。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphStore } from '../controller/index.js';
import { nextActivity } from '../controller/activity.js';

export class ActivityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActivityError';
  }
}

const HELP = `activity — 从 FGS 图选下一条活动（编排器入口）

  node tools/activity.mjs --cwd <dir> --problem-id <id>
      [--state-dir .fgs] [--step <stepId>] [--last-signature <sig>]
      [--no-progress <n>] [--lease-ms <ms>] [--activities-left <n>]
      [--findings-at-last-decide <n>] [--executes-since-decide <n>] [--decide-every <n>]
      [--allow-decide-repeat]

输出一行 JSON：{kind, stepId?, reason, signature, counts}
kind = bootstrap | decide | execute | done | wait | defer | budget
`;

/** Project id 规则与 ProjectRegistry.normalizeId 一致（小写、非法字符换 _、最长 64）。 */
export function normalizeProblemId(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
}

/**
 * @param {{
 *   cwd: string, problemId: string, stateDir?: string, stepId?: string|null,
 *   lastSignature?: string, noProgress?: number, leaseMs?: number,
 *   activitiesLeft?: number, allowDecideRepeat?: boolean, now?: number,
 *   findingsAtLastDecide?: number, executesSinceDecide?: number, decideEvery?: number,
 * }} options
 */
export function pickActivity(options = {}) {
  if (!options.cwd) throw new ActivityError('缺 cwd');
  const problemId = normalizeProblemId(options.problemId);
  if (!problemId) throw new ActivityError('缺 problemId');
  const stateDir = options.stateDir || '.fgs';
  const root = path.resolve(options.cwd, stateDir, 'projects', problemId);
  const store = new GraphStore(root);
  const graph = store.load();
  const result = nextActivity(graph, {
    now: options.now ?? Date.now(),
    leaseMs: options.leaseMs ?? 0,
    lastSignature: options.lastSignature,
    noProgress: options.noProgress ?? 0,
    activitiesLeft: options.activitiesLeft,
    decideOnChangeOnly: options.allowDecideRepeat !== true,
    findingsAtLastDecide: options.findingsAtLastDecide,
    executesSinceDecide: options.executesSinceDecide,
    decideEvery: options.decideEvery,
  });
  return {
    ...result,
    ok: true,
    problemId,
    graphPath: store.graphPath,
  };
}

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new ActivityError(`参数 ${arg} 缺值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--cwd': out.cwd = take(); break;
      case '--problem-id': out.problemId = take(); break;
      case '--state-dir': out.stateDir = take(); break;
      case '--step': out.stepId = take(); break;
      case '--last-signature': out.lastSignature = take(); break;
      case '--no-progress': out.noProgress = Number(take()); break;
      case '--lease-ms': out.leaseMs = Number(take()); break;
      case '--activities-left': out.activitiesLeft = Number(take()); break;
      case '--findings-at-last-decide': out.findingsAtLastDecide = Number(take()); break;
      case '--executes-since-decide': out.executesSinceDecide = Number(take()); break;
      case '--decide-every': out.decideEvery = Number(take()); break;
      case '--allow-decide-repeat': out.allowDecideRepeat = true; break;
      case '-h':
      case '--help': out.help = true; break;
      default: throw new ActivityError(`未知参数: ${arg}`);
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
    const result = pickActivity({
      cwd: args.cwd || process.env.FGS_WORKSPACE || process.cwd(),
      problemId: args.problemId || process.env.FGS_PROBLEM_ID,
      stateDir: args.stateDir || process.env.FGS_STATE_DIR,
      stepId: args.stepId,
      lastSignature: args.lastSignature,
      noProgress: args.noProgress,
      leaseMs: args.leaseMs,
      activitiesLeft: args.activitiesLeft,
      allowDecideRepeat: args.allowDecideRepeat,
      findingsAtLastDecide: args.findingsAtLastDecide,
      executesSinceDecide: args.executesSinceDecide,
      decideEvery: args.decideEvery,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error?.message ?? String(error);
    process.stderr.write(`activity: ${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
