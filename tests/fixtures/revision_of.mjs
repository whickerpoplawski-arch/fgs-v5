#!/usr/bin/env node
/** rev 跨进程一致性夹具：打印 <root>/graph.yaml 的内容哈希。 */
import { GraphStore, revisionOf } from '../../controller/index.js';

const root = process.argv[2];
if (!root) {
  process.stderr.write('usage: revision_of.mjs <projectRoot>\n');
  process.exit(2);
}
process.stdout.write(revisionOf(new GraphStore(root).load()));
