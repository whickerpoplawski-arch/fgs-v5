#!/usr/bin/env node
/**
 * 测试夹具：直接对图应用一个 op（模拟「活动 run 真的推进了图」）。
 *
 * 为什么需要它：活动编排器的测试不该依赖 LLM，但必须覆盖「一个活动真的改了图」，
 * 否则循环只会走 defer 分支。这里复用 kernel 的 Controller，不另写一套写图逻辑。
 *
 * 用法:
 *   node apply_op.mjs --cwd <dir> --problem-id <id> open_step  --action a --from fact_origin
 *   node apply_op.mjs --cwd <dir> --problem-id <id> submit_fact --step step_001 --title t --content c
 *   node apply_op.mjs --cwd <dir> --problem-id <id> satisfy_goal --goal goal_final --reason r --by fact_002
 */
import path from 'node:path';

import { Controller, GraphStore } from '../../controller/index.js';
import { openStepOp, satisfyGoalOp, submitFactOp } from '../../controller/ops.js';

function parse(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      out[key] = true;
      continue;
    }
    i += 1;
    out[key] = value;
  }
  return out;
}

const args = parse(process.argv);
const command = args._[0];
const cwd = args.cwd || process.cwd();
const problemId = args['problem-id'] || 'default';
const stateDir = args['state-dir'] || '.fgs';
const store = new GraphStore(path.resolve(cwd, stateDir, 'projects', problemId));
const controller = new Controller(store);
const graph = store.load();

let op = null;
if (command === 'open_step') {
  op = openStepOp({
    action: args.action || '夹具动作',
    from: String(args.from || 'fact_origin').split(','),
    priority: args.priority || 'normal',
    stepId: args.step || null,
  });
} else if (command === 'submit_fact') {
  op = submitFactOp({
    title: args.title || '夹具产出',
    content: args.content || 'fixture',
    producedBy: args.step || 'step_001',
    findingType: args['finding-type'] || null,
  });
} else if (command === 'satisfy_goal') {
  op = satisfyGoalOp({
    goalId: args.goal || 'goal_final',
    reason: args.reason || '夹具满足',
    satisfiedBy: String(args.by || 'fact_002').split(','),
  });
} else {
  process.stderr.write(`apply_op: 未知命令 ${command}\n`);
  process.exit(1);
}

const next = controller.apply(op, graph);
controller.commit(next);
process.stdout.write(`${JSON.stringify({ ok: true, steps: next.steps.length, facts: next.facts.length })}\n`);
