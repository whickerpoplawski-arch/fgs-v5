#!/usr/bin/env node
/** rebase 并发夹具：进程内用 applyBatch(rebase=true) 追加一个 step（模拟 Decide 提交）。 */
import { Controller, GraphStore } from '../../controller/index.js';
import { openStepOp } from '../../controller/ops.js';

const [, , root, stepId] = process.argv;
if (!root || !stepId) {
  process.stderr.write('usage: concurrent_decision.mjs <projectRoot> <stepId>\n');
  process.exit(2);
}

const controller = new Controller(new GraphStore(root));
const out = controller.applyBatch(
  [openStepOp({ action: `并发 step ${stepId}`, from: ['fact_origin'], stepId })],
  { rebase: true, baseRev: null },
);
process.stdout.write(`${JSON.stringify({ applied: out.applied, rejected: out.rejected })}\n`);
