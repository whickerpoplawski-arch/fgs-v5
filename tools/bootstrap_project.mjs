#!/usr/bin/env node
/**
 * 竞赛开局写盘种题（P0 磁盘预种）。
 *
 * 等价于 `/fgs new <problemId> <brief>` 的磁盘效果：
 *   ProjectRegistry.create + setActive + Controller.apply(seedOriginOp) + commit
 * 不经过模型，也不依赖 `/fgs new` 或 `fgs_project`。
 *
 * 与插件里 `projectNew` 的差别：已经种过题（图上已有 fact_origin + goal_final）
 * 视为幂等成功，不改图。插件对模型返回「已经种过题」是为了拦住重复 seed；
 * 竞赛 driver 重入不能因此失败。`attachRun` 看到磁盘已种题会 auto-attach。
 *
 * 用法:
 *   node tools/bootstrap_project.mjs \
 *     --cwd <workspace> --problem-id <id> --brief <text> \
 *     [--criterion <text>] [--target <addr>] [--brief-file <path>]
 *
 * 本地单题调试可读 FGS_WORKSPACE / FGS_PROBLEM_ID / FGS_BRIEF / FGS_CRITERION / FGS_TARGET。
 * 托管竞赛不以这些环境变量为题面真源；driver 在 start 之后显式传参。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore } from '../controller/index.js';
import { openStepOp, seedOriginOp } from '../controller/ops.js';
import { ProjectRegistry } from '../controller/projects.js';

export class BootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/**
 * 冷启动直冲 step（Cairn v1 的 bootstrap 快路径移植）。
 *
 * Cairn 在「图里只有 origin + goal」时先起一个 bootstrap 任务，直接尝试达成 goal，
 * 成功就连 fact + complete 一起写，失败才进 reason。这里用「预种一条 open step」表达：
 * 第一轮直接是 Execute（bootstrap 活动），省掉一轮 Decide。`actor: 'bootstrap'`
 * 是活动选择器识别冷启动的唯一标记（`controller/activity.js#isColdStart`）。
 */
const COLD_START_STEP_ID = 'step_001';
const COLD_START_ACTION = '冷启动直冲：用 fact_origin 与题目信息直接尝试拿到 goal_final 的见证'
  + '（flag / 利用成功证据）。拿到就落 Fact 并标记 goal 达成；拿不到就如实记录观察到的事实与本轮试过的路径。';

const HELP = `bootstrap_project — 在 dsh / 模型回合之前把 FGS Project 种到磁盘

  node tools/bootstrap_project.mjs --cwd <dir> --problem-id <id> --brief <text>
      [--criterion <text>] [--target <addr>] [--brief-file <path>] [--state-dir .fgs]
      [--cold-start-step]

成功时 stdout 一行 JSON（status=seeded|already-seeded），exit 0。
problemId 非法、缺 brief（尚未种题时）、cwd 不可写：stderr 说明 + exit 1。
重复调用不覆盖已有 fact_origin / goal_final。
--cold-start-step：种题时顺带预开 step_001（from=fact_origin，actor=bootstrap），
  让第一轮直接是 Execute 直冲 goal（Cairn bootstrap 快路径），省掉首轮 Decide。
`;

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** @returns {{kind:'seeded'}|{kind:'partial',missing:string}|{kind:'empty'}} */
function classifyGraph(graph) {
  const hasOrigin = (graph?.facts ?? []).some((fact) => fact.id === 'fact_origin');
  const hasGoal = (graph?.goals ?? []).some((goal) => goal.id === 'goal_final' && goal.kind === 'final');
  if (hasOrigin && hasGoal) return { kind: 'seeded' };
  if (hasOrigin || hasGoal) return { kind: 'partial', missing: hasOrigin ? 'goal_final' : 'fact_origin' };
  return { kind: 'empty' };
}

function readBriefFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new BootstrapError(`无法读取 brief 文件 ${filePath}: ${error.message}`);
  }
}

/**
 * @param {{
 *   cwd: string,
 *   problemId: string,
 *   brief?: string,
 *   criterion?: string,
 *   target?: string,
 *   stateDir?: string,
 *   coldStartStep?: boolean,
 * }} options
 */
export function bootstrapProject(options = {}) {
  const cwd = options.cwd;
  if (!hasText(cwd)) throw new BootstrapError('缺 cwd');
  const root = path.resolve(cwd);
  let stat;
  try {
    stat = fs.statSync(root);
  } catch (error) {
    throw new BootstrapError(`cwd 不存在或不可访问: ${root} (${error.code || error.message})`);
  }
  if (!stat.isDirectory()) throw new BootstrapError(`cwd 不是目录: ${root}`);
  try {
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw new BootstrapError(`cwd 不可写: ${root} (${error.code || error.message})`);
  }

  const stateDir = options.stateDir ?? '.fgs';
  if (!hasText(stateDir) || path.isAbsolute(stateDir) || stateDir.split(/[\\/]/).includes('..')) {
    throw new BootstrapError(`stateDir 非法: ${stateDir}`);
  }

  const registry = new ProjectRegistry(path.join(root, stateDir));
  const rawId = options.problemId;
  if (!hasText(rawId)) throw new BootstrapError('problemId 为空');
  const id = registry.normalizeId(rawId);
  if (!registry.isValidId(id)) {
    throw new BootstrapError(`problemId 非法: ${rawId}（须为 [a-z0-9_-]{1,64}，非法字符会转成 _）`);
  }

  const brief = hasText(options.brief) ? String(options.brief) : '';
  const criterion = hasText(options.criterion) ? String(options.criterion).trim() : '';
  const target = hasText(options.target) ? String(options.target).trim() : '';

  let existed = false;
  try {
    existed = registry.exists(id);
  } catch (error) {
    throw new BootstrapError(error.message || String(error));
  }

  if (existed) {
    const projectRoot = registry.projectRoot(id);
    const store = new GraphStore(projectRoot);
    let graph;
    try {
      graph = store.load();
    } catch (error) {
      throw new BootstrapError(`无法读取图: ${error.message}`);
    }
    const seeded = classifyGraph(graph);
    if (seeded.kind === 'seeded') {
      try {
        registry.setActive(id);
      } catch (error) {
        throw new BootstrapError(error.message || String(error));
      }
      return {
        ok: true,
        status: 'already-seeded',
        problemId: id,
        activeProblemId: registry.getActive(),
        cwd: root,
        graphPath: store.graphPath,
        competitionPath: registry.indexPath,
      };
    }
    if (seeded.kind === 'partial') {
      throw new BootstrapError(
        `图不完整: ${store.graphPath} 缺少 ${seeded.missing}，拒绝覆盖`,
      );
    }
  }

  if (!brief) {
    throw new BootstrapError(`Project ${id} 尚未种题，缺 brief`);
  }

  try {
    if (!existed) {
      const title = brief.split('\n')[0].slice(0, 120);
      registry.create({ id, title });
    }
    registry.setActive(id);
  } catch (error) {
    throw new BootstrapError(error.message || String(error));
  }

  const projectRoot = registry.projectRoot(id);
  const store = new GraphStore(projectRoot);
  let graph;
  try {
    graph = store.load();
  } catch (error) {
    throw new BootstrapError(`无法读取图: ${error.message}`);
  }
  const seeded = classifyGraph(graph);
  if (seeded.kind === 'seeded') {
    return {
      ok: true,
      status: 'already-seeded',
      problemId: id,
      activeProblemId: registry.getActive(),
      cwd: root,
      graphPath: store.graphPath,
      competitionPath: registry.indexPath,
    };
  }
  if (seeded.kind === 'partial') {
    throw new BootstrapError(`图不完整: ${store.graphPath} 缺少 ${seeded.missing}，拒绝覆盖`);
  }
  const graphPath = store.graphPath;
  const competitionPath = registry.indexPath;

  const content = target ? JSON.stringify({ target, brief }, null, 2) : brief;
  const op = seedOriginOp({
    title: '题目信息:',
    content,
    ...(criterion ? { criterion } : {}),
  });
  const coldStartStep = options.coldStartStep === true;
  const controller = new Controller(store);
  let next;
  try {
    // 种题与（可选的）冷启动 step 在同一个写事务里落盘：要么都成功，要么都不写。
    next = controller.transact((locked) => {
      let working = controller.apply(op, locked);
      if (coldStartStep) {
        working = controller.apply(openStepOp({
          action: COLD_START_ACTION,
          from: ['fact_origin'],
          actor: 'bootstrap',
          priority: 'high',
          stepId: COLD_START_STEP_ID,
        }), working);
      }
      return working;
    });
  } catch (error) {
    throw new BootstrapError(`种题失败: ${error.message}`);
  }
  writeSeededMeta(registry, id, brief);
  return {
    ok: true,
    status: 'seeded',
    problemId: id,
    activeProblemId: registry.getActive(),
    cwd: root,
    graphPath,
    competitionPath,
    created: !existed,
  };
}

function writeSeededMeta(registry, id, brief) {
  const prev = registry.readMeta(id) ?? {};
  const titleFromBrief = brief.split('\n')[0].slice(0, 120);
  const meta = {
    id,
    title: prev.title || titleFromBrief || id,
    state: 'seeded',
    model: prev.model ?? null,
    budget: prev.budget ?? null,
    roundSeq: prev.roundSeq ?? 0,
    createdAt: prev.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  registry.writeMeta(id, meta);
  registry.setProblemState(id, 'seeded');
}

function parseArgs(argv) {
  const out = {};
  const args = argv.slice(2);
  const take = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new BootstrapError(`缺少参数值: ${flag}`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--cwd':
        out.cwd = take(arg, i);
        i += 1;
        break;
      case '--problem-id':
      case '--problemId':
        out.problemId = take(arg, i);
        i += 1;
        break;
      case '--brief':
        out.brief = take(arg, i);
        i += 1;
        break;
      case '--brief-file':
        out.briefFile = take(arg, i);
        i += 1;
        break;
      case '--criterion':
        out.criterion = take(arg, i);
        i += 1;
        break;
      case '--target':
        out.target = take(arg, i);
        i += 1;
        break;
      case '--state-dir':
        out.stateDir = take(arg, i);
        i += 1;
        break;
      case '--cold-start-step':
        out.coldStartStep = true;
        break;
      default:
        throw new BootstrapError(`未知参数: ${arg}`);
    }
  }
  return out;
}

function optionsFromArgs(args) {
  if (args.brief !== undefined && args.briefFile) {
    throw new BootstrapError('不要同时传 --brief 与 --brief-file');
  }
  let brief = args.brief;
  if (args.briefFile) brief = readBriefFile(args.briefFile);
  if (brief === undefined) brief = process.env.FGS_BRIEF;
  return {
    cwd: args.cwd || process.env.FGS_WORKSPACE || process.cwd(),
    problemId: args.problemId || process.env.FGS_PROBLEM_ID,
    brief,
    criterion: args.criterion || process.env.FGS_CRITERION,
    target: args.target || process.env.FGS_TARGET,
    stateDir: args.stateDir,
    coldStartStep: args.coldStartStep === true,
  };
}

function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      process.stdout.write(HELP);
      return;
    }
    const result = bootstrapProject(optionsFromArgs(args));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error?.message ?? String(error);
    process.stderr.write(`bootstrap_project: ${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
