/**
 * FGS 黑板树视图（只读）。
 *
 * 把磁盘上的 `.fgs/projects/<id>/graph.yaml` 聚合成一张可下钻的树：
 *   GET <treePath>           → 单文件页面（内联 CSS/JS，无外部依赖）
 *   GET <treePath>/data      → 归一化后的模型 JSON（前端每 2 分钟轮询）
 *
 * 数据源就是磁盘本身，与 DSH 会话状态解耦：既能看当前 workspace，
 * 也能把 treeRoot 指到整个 run 目录（`.../run4/workers`）看所有 worker。
 */
import fs from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from './yaml.js';

const PAGE_PATH = new URL('./tree.html', import.meta.url);

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 在 root 下找出所有 `.fgs/projects/<id>/graph.yaml`；命中 .fgs 后不再往下钻。 */
function findProjectDirs(root, maxDepth = 4) {
  const out = [];
  const seen = new Set();

  // root 本身就是某道题的项目目录（.fgs/projects/<id>）
  if (fs.existsSync(path.join(root, 'graph.yaml')) && path.basename(path.dirname(root)) === 'projects') {
    return [{ dir: root, projectId: path.basename(root) }];
  }

  const collectFromFgs = (fgsDir) => {
    const projectsDir = path.join(fgsDir, 'projects');
    let entries;
    try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(projectsDir, e.name);
      if (fs.existsSync(path.join(dir, 'graph.yaml'))) out.push({ dir, projectId: e.name });
    }
    return true;
  };

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);

    if (path.basename(dir) === '.fgs') { collectFromFgs(dir); return; }

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // run 根下既有 <worker>/.fgs，也可能直接就是某个题的项目目录
    if (path.basename(dir) === 'projects' && fs.existsSync(path.join(dir, 'graph.yaml'))) return;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  walk(path.resolve(root), 0);
  return out;
}

/** 从 <worker>/.fgs/projects/<id> 反推 worker 名；不依赖固定层级。 */
function workerOf(dir) {
  let cur = dir;
  for (let i = 0; i < 4; i++) {
    cur = path.dirname(cur);
    if (path.basename(cur) === '.fgs') return path.basename(path.dirname(cur));
  }
  return path.basename(path.dirname(dir));
}

function shortText(s, max = 240) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** origin fact 的 content 是插件种题时写的 JSON（target/brief）。 */
function parseOrigin(content) {
  const text = String(content ?? '').trim();
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') {
      return {
        target: typeof obj.target === 'string' ? obj.target : '',
        brief: typeof obj.brief === 'string' ? obj.brief : '',
      };
    }
  } catch { /* 纯文本 */ }
  return { target: '', brief: text };
}

function normalizeProject(worker, projectId, dir, mtimeMs) {
  let doc = null;
  try { doc = parseYaml(fs.readFileSync(path.join(dir, 'graph.yaml'), 'utf8')); } catch { doc = null; }
  const meta = readJson(path.join(dir, 'meta.json')) ?? {};

  const facts = Array.isArray(doc?.facts) ? doc.facts.filter((f) => f && f.id) : [];
  const steps = Array.isArray(doc?.steps) ? doc.steps.filter((s) => s && s.id) : [];
  const goals = Array.isArray(doc?.goals) ? doc.goals.filter((g) => g && g.id) : [];

  const originFact = facts.find((f) => f.id === 'fact_origin') ?? null;
  const origin = originFact ? parseOrigin(originFact.content) : { target: '', brief: meta.title ?? '' };
  const goalFinal = goals.find((g) => g.id === 'goal_final') ?? null;
  const satisfied = Boolean(goalFinal?.satisfiedBy || goalFinal?.satisfiedReason);

  const factView = facts.filter((f) => f.id !== 'fact_origin').map((f) => ({
    id: String(f.id),
    title: String(f.title ?? '').trim(),
    content: String(f.content ?? ''),
    createdAt: f.createdAt ?? null,
    producedBy: f.producedBy ? String(f.producedBy) : null,
    kind: f.kind ? String(f.kind) : (f.findingType ? 'finding' : 'result'),
    findingType: f.findingType ? String(f.findingType) : null,
  }));

  const stepView = steps.map((s) => ({
    id: String(s.id),
    action: String(s.action ?? '').trim(),
    from: Array.isArray(s.from) ? s.from.map(String) : [],
    to: s.to ? String(s.to) : null,
    state: String(s.state ?? 'open'),
    priority: String(s.priority ?? 'normal'),
    createdAt: s.createdAt ?? null,
    owner: s.owner ? String(s.owner) : null,
    reason: s.reason ? String(s.reason) : null,
  }));

  const goalView = goals.map((g) => ({
    id: String(g.id),
    kind: String(g.kind ?? 'final'),
    criterion: String(g.criterion ?? '').trim(),
    parentId: g.parentId ? String(g.parentId) : null,
    state: g.state ? String(g.state) : (g.satisfiedBy ? 'satisfied' : 'open'),
    satisfiedBy: g.satisfiedBy ?? null,
    satisfiedReason: g.satisfiedReason ?? null,
  }));

  const stats = {
    facts: factView.length + (originFact ? 1 : 0),
    steps: stepView.length,
    goals: goalView.length,
    open: stepView.filter((s) => s.state === 'open').length,
    done: stepView.filter((s) => s.state === 'done').length,
    dropped: stepView.filter((s) => s.state === 'dropped').length,
    unfinished: factView.filter((f) => f.kind === 'unfinished').length,
    findings: factView.filter((f) => f.kind === 'finding' || f.findingType).length,
    high: stepView.filter((s) => s.priority === 'high').length,
    satisfied,
  };

  const times = [originFact?.createdAt, ...factView.map((f) => f.createdAt), ...stepView.map((s) => s.createdAt)]
    .filter(Boolean).sort();

  return {
    id: projectId,
    worker,
    dir,
    mtime: mtimeMs ? new Date(mtimeMs).toISOString() : null,
    state: String(meta.state ?? (satisfied ? 'solved' : 'running')),
    title: shortText(meta.title ?? origin.brief ?? ''),
    origin,
    goal: goalFinal ? { criterion: String(goalFinal.criterion ?? '').trim(), satisfied } : null,
    facts: factView,
    steps: stepView,
    goals: goalView,
    stats,
    createdAt: originFact?.createdAt ?? null,
    lastAt: times.at(-1) ?? null,
  };
}

/** 聚合 root 下所有图。每次请求都重读磁盘 ⇒ 天然是最新快照。 */
export function collectModel(root) {
  const abs = path.resolve(root);
  const projects = [];
  const errors = [];
  if (!fs.existsSync(abs)) return { root: abs, generatedAt: new Date().toISOString(), projects, errors: [{ error: 'root 不存在' }] };

  for (const { dir, projectId } of findProjectDirs(abs)) {
    try {
      const st = fs.statSync(path.join(dir, 'graph.yaml'));
      const worker = workerOf(dir);
      projects.push(normalizeProject(worker, projectId, dir, st.mtimeMs));
    } catch (error) {
      errors.push({ projectId, error: String(error?.message ?? error) });
    }
  }

  const counts = new Map();
  for (const p of projects) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
  for (const p of projects) p.duplicated = counts.get(p.id) > 1;
  projects.sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')));

  const totals = {
    projects: projects.length,
    workers: new Set(projects.map((p) => p.worker)).size,
    facts: projects.reduce((n, p) => n + p.stats.facts, 0),
    steps: projects.reduce((n, p) => n + p.stats.steps, 0),
    goals: projects.reduce((n, p) => n + p.stats.goals, 0),
    open: projects.reduce((n, p) => n + p.stats.open, 0),
    done: projects.reduce((n, p) => n + p.stats.done, 0),
    dropped: projects.reduce((n, p) => n + p.stats.dropped, 0),
    unfinished: projects.reduce((n, p) => n + p.stats.unfinished, 0),
    findings: projects.reduce((n, p) => n + p.stats.findings, 0),
    high: projects.reduce((n, p) => n + p.stats.high, 0),
    solved: projects.filter((p) => p.stats.satisfied || p.state === 'solved').length,
  };
  return { root: abs, generatedAt: new Date().toISOString(), totals, projects, errors };
}

/**
 * 造一个 webServer 路由处理器。
 * @param {{ root: () => string, basePath: string }} options root 是函数 ⇒ 每次请求重读配置
 */
export function createTreeHandler({ root, basePath = '/fgs/tree' }) {
  const base = basePath.replace(/\/+$/, '');
  return (req, res) => {
    let pathname = '/';
    try { pathname = new URL(req?.url ?? '/', 'http://localhost').pathname; } catch { pathname = '/'; }
    const rel = pathname.slice(base.length).replace(/\/+$/, '') || '';

    if (rel === '' || rel === '/') {
      let html;
      try { html = fs.readFileSync(PAGE_PATH, 'utf8'); }
      catch (error) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(`tree.html 读取失败: ${error?.message ?? error}`);
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(html.replaceAll('__FGS_TREE_BASE__', base));
      return;
    }

    if (rel === '/data') {
      let body;
      try { body = JSON.stringify(collectModel(root())); }
      catch (error) { body = JSON.stringify({ projects: [], errors: [{ error: String(error?.message ?? error) }] }); }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('not found');
  };
}
