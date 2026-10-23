#!/usr/bin/env node
/** 写锁测试夹具：进程内做一次「release_step」RMW（模拟一个并行活动落 Fact）。 */
import { Controller, GraphStore } from '../../controller/index.js';
import { releaseStepOp } from '../../controller/ops.js';

const [, , root, stepId, owner] = process.argv;
if (!root || !stepId || !owner) {
  process.stderr.write('usage: concurrent_release.mjs <projectRoot> <stepId> <owner>\n');
  process.exit(2);
}

const store = new GraphStore(root);
const controller = new Controller(store);
controller.transact((graph) => controller.apply(releaseStepOp({
  stepId,
  factTitle: `${stepId} 未完成`,
  factContent: `run=${owner} 中断`,
}), graph));
process.stdout.write(`${JSON.stringify({ ok: true, stepId, owner })}\n`);
