/**
 * contest driver：fixture 下走 list→start→mkdir→bootstrap→dsh stub，无平台、无 LLM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GraphStore } from '../controller/index.js';
import { tmpDir } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driver = path.join(repoRoot, 'contest', 'driver.py');
const entrypoint = path.join(repoRoot, 'contest', 'entrypoint.sh');

function runPython(args, env) {
  return spawnSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeFixture(dir, challenges) {
  const file = path.join(dir, 'challenges.json');
  fs.writeFileSync(file, JSON.stringify({ challenges }));
  return file;
}

test('SOLVER_GATEWAY=1 把模型基址改写成 *.tsecbench.gw 且 https→http', () => {
  const script = [
    'import json, os, driver',
    'os.environ["SOLVER_GATEWAY"] = "1"',
    'cases = {',
    '  "deepseek": driver.rewrite_model_base("https://api.deepseek.com/v1"),',
    '  "already": driver.rewrite_model_base("http://api.deepseek.com.tsecbench.gw/v1"),',
    '  "port": driver.rewrite_model_base("https://api.deepseek.com:8443/v1?x=1"),',
    '  "off": None,',
    '}',
    'os.environ["SOLVER_GATEWAY"] = "0"',
    'cases["off"] = driver.rewrite_model_base("https://api.deepseek.com/v1")',
    'print(json.dumps(cases))',
  ].join('\n');
  const result = runPython(['-c', script], { PYTHONPATH: path.join(repoRoot, 'contest') });
  assert.equal(result.status, 0, result.stderr);
  const cases = JSON.parse(result.stdout);
  assert.equal(cases.deepseek, 'http://api.deepseek.com.tsecbench.gw/v1');
  assert.equal(cases.already, 'http://api.deepseek.com.tsecbench.gw/v1');
  assert.equal(cases.port, 'http://api.deepseek.com.tsecbench.gw:8443/v1?x=1');
  assert.equal(cases.off, 'https://api.deepseek.com/v1');
});

test('SOLVER_GATEWAY=1 不改写 BENCHMARK_BASE_URL，DEEPSEEK_BASE_URL 走 *.tsecbench.gw', () => {
  const script = [
    'import json, os, tempfile, threading, urllib.request',
    'from http.server import BaseHTTPRequestHandler, HTTPServer',
    'from pathlib import Path',
    'import driver',
    'from supervisor import core',
    'profile = Path(tempfile.mkdtemp())',
    '(profile / "cordis.patch.yml").write_text(',
    '    "baseURL: https://api.deepseek.com/v1\\n"',
    '    "benchmark: https://tsecbench.zc.tencent.com\\n"',
    '    "note: keep https://tsecbench.zc.tencent.com/api/v1/challenges\\n",',
    '    encoding="utf-8",',
    ')',
    '(profile / "settings.json").write_text(json.dumps({',
    '    "baseURL": "https://api.openai.com/v1",',
    '    "platform": {"baseURL": "https://tsecbench.zc.tencent.com"},',
    '    "extra": "https://tsecbench.zc.tencent.com/openapi/v1/challenges",',
    '}), encoding="utf-8")',
    'os.environ["CONTEST_DSH_PROFILE_DIR"] = str(profile)',
    'os.environ["SOLVER_GATEWAY"] = "1"',
    'os.environ["BENCHMARK_BASE_URL"] = "https://tsecbench.zc.tencent.com"',
    'os.environ["PLATFORM_BASE_URL"] = "https://tsecbench.zc.tencent.com"',
    'os.environ["BENCHMARK_TOKEN"] = "secret-token"',
    'os.environ["DEEPSEEK_BASE_URL"] = "https://api.deepseek.com/v1"',
    'os.environ["OPENAI_BASE_URL"] = "https://api.openai.com/v1"',
    'seen = {"hits": []}',
    'class Handler(BaseHTTPRequestHandler):',
    '    def _finish(self):',
    '        length = int(self.headers.get("content-length") or 0)',
    '        if length:',
    '            self.rfile.read(length)',
    '        seen["hits"].append({',
    '            "method": self.command,',
    '            "path": self.path.split("?")[0],',
    '            "raw": self.path,',
    '            "token": self.headers.get("BENCHMARK_TOKEN"),',
    '        })',
    '        body = b\'[{"unique_code":"a-1","is_completed":true}]\'',
    '        if self.path.split("?")[0].endswith("/close"):',
    '            body = b\'{"closed":true}\'',
    '        self.send_response(200)',
    '        self.send_header("content-type", "application/json")',
    '        self.end_headers()',
    '        self.wfile.write(body)',
    '    def do_GET(self):',
    '        self._finish()',
    '    def do_POST(self):',
    '        self._finish()',
    '    def log_message(self, fmt, *args):',
    '        return',
    'server = HTTPServer(("127.0.0.1", 0), Handler)',
    'thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)',
    'thread.start()',
    'driver.apply_gateway_rewrites()',
    'port = server.server_address[1]',
    'local = f"http://127.0.0.1:{port}"',
    'driver._request("GET", local + "/openapi/v1/challenges", "secret-token")',
    'driver._request("POST", local + "/openapi/v1/challenges/start?unique_code=a-1", "secret-token", {})',
    'core.request_json("POST", local + "/openapi/v1/challenges/close?unique_code=a-1", "secret-token", {})',
    'server.shutdown()',
    'probe = urllib.request.Request("http://127.0.0.1/openapi/v1/challenges", method="GET")',
    'core.attach_platform_headers(probe, "secret-token")',
    'refused = ""',
    'try:',
    '    core.challenge_url("http://tsecbench.zc.tencent.com.tsecbench.gw", "/api/v1/challenges")',
    'except core.SupervisorError as exc:',
    '    refused = str(exc)',
    'print(json.dumps({',
    '    "benchmark": os.environ["BENCHMARK_BASE_URL"],',
    '    "platform": os.environ["PLATFORM_BASE_URL"],',
    '    "token": os.environ["BENCHMARK_TOKEN"],',
    '    "deepseek": os.environ["DEEPSEEK_BASE_URL"],',
    '    "openai": os.environ["OPENAI_BASE_URL"],',
    '    "direct": driver.rewrite_model_base("https://tsecbench.zc.tencent.com"),',
    '    "directPath": driver.rewrite_model_base("https://tsecbench.zc.tencent.com/api/v1/challenges"),',
    '    "yaml": (profile / "cordis.patch.yml").read_text(encoding="utf-8"),',
    '    "settings": json.loads((profile / "settings.json").read_text(encoding="utf-8")),',
    '    "hits": seen["hits"],',
    '    "headerNames": list(probe.headers),',
    '    "refused": refused,',
    '    "listUrl": core.challenge_url("https://tsecbench.zc.tencent.com", "/api/v1/challenges"),',
    '}))',
  ].join('\n');
  const result = runPython(['-c', script], { PYTHONPATH: path.join(repoRoot, 'contest') });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const cases = JSON.parse(result.stdout);
  assert.equal(cases.benchmark, 'https://tsecbench.zc.tencent.com');
  assert.equal(cases.platform, 'https://tsecbench.zc.tencent.com');
  assert.equal(cases.token, 'secret-token');
  assert.equal(cases.deepseek, 'http://api.deepseek.com.tsecbench.gw/v1');
  assert.equal(cases.openai, 'http://api.openai.com.tsecbench.gw/v1');
  assert.equal(cases.direct, 'https://tsecbench.zc.tencent.com');
  assert.equal(cases.directPath, 'https://tsecbench.zc.tencent.com/api/v1/challenges');
  assert.equal(cases.listUrl, 'https://tsecbench.zc.tencent.com/api/v1/challenges');
  assert.match(cases.yaml, /baseURL: http:\/\/api\.deepseek\.com\.tsecbench\.gw\/v1/);
  assert.match(cases.yaml, /benchmark: https:\/\/tsecbench\.zc\.tencent\.com\n/);
  assert.match(cases.yaml, /note: keep https:\/\/tsecbench\.zc\.tencent\.com\/api\/v1\/challenges/);
  assert.equal(cases.settings.baseURL, 'http://api.openai.com.tsecbench.gw/v1');
  assert.equal(cases.settings.platform.baseURL, 'https://tsecbench.zc.tencent.com');
  assert.equal(cases.settings.extra, 'https://tsecbench.zc.tencent.com/openapi/v1/challenges');
  assert.deepEqual(
    cases.hits.map((hit) => hit.path),
    ['/openapi/v1/challenges', '/openapi/v1/challenges/start', '/openapi/v1/challenges/close'],
  );
  assert.deepEqual(cases.hits.map((hit) => hit.token), ['secret-token', 'secret-token', 'secret-token']);
  assert.equal(cases.hits[1].raw, '/openapi/v1/challenges/start?unique_code=a-1');
  assert.match(cases.hits[1].raw, /unique_code=/);
  assert.equal(cases.hits[2].raw, '/openapi/v1/challenges/close?unique_code=a-1');
  assert.ok(cases.headerNames.includes('BENCHMARK_TOKEN'));
  assert.match(cases.refused, /BENCHMARK_BASE_URL/);
  assert.match(result.stderr, /rewrote DEEPSEEK_BASE_URL: https:\/\/api\.deepseek\.com\/v1 → http:\/\/api\.deepseek\.com\.tsecbench\.gw\/v1/);
  assert.match(result.stderr, /BENCHMARK_BASE_URL unchanged: https:\/\/tsecbench\.zc\.tencent\.com/);
  assert.doesNotMatch(result.stderr, /rewrote BENCHMARK/);
  assert.doesNotMatch(cases.benchmark + cases.listUrl + cases.direct + cases.directPath, /tsecbench\.gw/);
});

test('平台已注入 *.tsecbench.gw 的 BENCHMARK_BASE_URL 时允许 list，DEEPSEEK 仍改写', () => {
  const script = [
    'import json, os, tempfile',
    'from pathlib import Path',
    'import driver',
    'from supervisor import core',
    'profile = Path(tempfile.mkdtemp())',
    'os.environ["CONTEST_DSH_PROFILE_DIR"] = str(profile)',
    'os.environ.pop("DSH_HOME", None)',
    'os.environ.pop("PLATFORM_BASE_URL", None)',
    'os.environ["SOLVER_GATEWAY"] = "1"',
    'injected = "http://tsecbench.zc.tencent.com.tsecbench.gw"',
    'os.environ["BENCHMARK_BASE_URL"] = injected',
    'os.environ["BENCHMARK_TOKEN"] = "secret-token"',
    'os.environ["DEEPSEEK_BASE_URL"] = "https://api.deepseek.com/v1"',
    'driver.apply_gateway_rewrites()',
    'base = os.environ["BENCHMARK_BASE_URL"]',
    'refused = ""',
    'try:',
    '    core.challenge_url("http://api.deepseek.com.tsecbench.gw", "/api/v1/challenges")',
    'except core.SupervisorError as exc:',
    '    refused = str(exc)',
    'print(json.dumps({',
    '    "benchmark": base,',
    '    "token": os.environ["BENCHMARK_TOKEN"],',
    '    "deepseek": os.environ["DEEPSEEK_BASE_URL"],',
    '    "listUrl": core.challenge_url(base, "/api/v1/challenges"),',
    '    "direct": driver.rewrite_model_base(injected),',
    '    "httpsDirect": driver.rewrite_model_base("https://tsecbench.zc.tencent.com.tsecbench.gw"),',
    '    "refused": refused,',
    '}))',
  ].join('\n');
  const result = runPython(['-c', script], { PYTHONPATH: path.join(repoRoot, 'contest') });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const cases = JSON.parse(result.stdout);
  assert.equal(cases.benchmark, 'http://tsecbench.zc.tencent.com.tsecbench.gw');
  assert.equal(cases.token, 'secret-token');
  assert.equal(cases.listUrl, 'http://tsecbench.zc.tencent.com.tsecbench.gw/api/v1/challenges');
  assert.equal(cases.direct, 'http://tsecbench.zc.tencent.com.tsecbench.gw');
  assert.equal(cases.httpsDirect, 'https://tsecbench.zc.tencent.com.tsecbench.gw');
  assert.equal(cases.deepseek, 'http://api.deepseek.com.tsecbench.gw/v1');
  assert.match(cases.refused, /BENCHMARK_BASE_URL/);
  assert.match(result.stderr, /rewrote DEEPSEEK_BASE_URL: https:\/\/api\.deepseek\.com\/v1 → http:\/\/api\.deepseek\.com\.tsecbench\.gw\/v1/);
  assert.match(result.stderr, /BENCHMARK_BASE_URL unchanged: http:\/\/tsecbench\.zc\.tencent\.com\.tsecbench\.gw/);
  assert.doesNotMatch(result.stderr, /rewrote BENCHMARK/);
  assert.doesNotMatch(result.stderr, /refusing Challenges API URL/);
});

test('start_challenge_live 把 unique_code 放在 query 上，不走 path start', () => {
  const script = `
import json, os, tempfile, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import driver
from supervisor import core

os.environ.pop("PLATFORM_BASE_URL", None)
os.environ["SOLVER_GATEWAY"] = "0"
os.environ["CONTEST_DSH_LAUNCH"] = "0"
os.environ["CONTEST_SUPERVISOR"] = "0"
os.environ.pop("CONTEST_FIXTURE", None)
os.environ["BENCHMARK_TOKEN"] = "secret-token"

seen = {"hits": []}

def split_target(raw):
    parts = urllib.parse.urlsplit(raw)
    return parts.path, urllib.parse.parse_qs(parts.query)

class Handler(BaseHTTPRequestHandler):
    def _body(self):
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def _record(self, raw):
        path, query = split_target(self.path)
        seen["hits"].append({
            "method": self.command,
            "path": self.path,
            "route": path,
            "query": query,
            "body": raw.decode("utf-8"),
            "token": self.headers.get("BENCHMARK_TOKEN"),
            "authorization": self.headers.get("Authorization"),
        })

    def _send(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        raw = self._body()
        self._record(raw)
        path, _query = split_target(self.path)
        if path == "/openapi/v1/challenges":
            self._send(200, {"challenges": [{
                "unique_code": "e1-02",
                "description": "demo",
                "is_completed": False,
            }]})
            return
        self._send(404, {"detail": "Not Found"})

    def do_POST(self):
        raw = self._body()
        self._record(raw)
        path, query = split_target(self.path)
        # Path form is not a start route on this platform.
        if path.endswith("/start") and not path.endswith("/challenges/start"):
            self._send(404, {"detail": "Not Found"})
            return
        if path in ("/openapi/v1/challenges/start", "/api/v1/challenges/start"):
            code = (query.get("unique_code") or [None])[0]
            if not code:
                self._send(422, {"detail": [{
                    "type": "missing",
                    "loc": ["query", "unique_code"],
                    "msg": "Field required",
                    "input": None,
                }]})
                return
            if path == "/api/v1/challenges/start" and code == "fallback-1":
                self._send(404, {"detail": "Not Found"})
                return
            self._send(200, {"container_addr": ["http://10.0.0.1:80"]})
            return
        self._send(404, {"detail": "Not Found"})

    def log_message(self, fmt, *args):
        return

server = HTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
thread.start()
base = "http://127.0.0.1:%s" % server.server_address[1]
os.environ["BENCHMARK_BASE_URL"] = base
payload = {}
try:
    prefix, _challenges = driver.list_challenges_live(base, "secret-token")
    addrs = driver.start_challenge_live(base, prefix, "secret-token", "e1-02")
    live_hits = list(seen["hits"])
    before_api = len(seen["hits"])
    api_addrs = driver.start_challenge_live(base, "/api/v1", "secret-token", "a-01")
    api_hits = seen["hits"][before_api:]
    before_empty = len(seen["hits"])
    empty_addrs = driver.start_challenge_live(base, "", "secret-token", "fallback-1")
    empty_hits = seen["hits"][before_empty:]
    body_only = ""
    try:
        driver._request(
            "POST",
            base + "/openapi/v1/challenges/start",
            "secret-token",
            {"unique_code": "e1-02"},
        )
    except driver.DriverError as exc:
        body_only = str(exc)
    path_only = ""
    try:
        driver._request(
            "POST",
            base + "/openapi/v1/challenges/e1-02/start",
            "secret-token",
            {},
        )
    except driver.DriverError as exc:
        path_only = str(exc)
    workdir = Path(tempfile.mkdtemp())
    visited = driver.visit(
        {"unique_code": "e1-02", "description": "demo", "is_completed": False},
        base=base,
        prefix=prefix,
        token="secret-token",
        workdir=workdir,
        fixture=False,
    )
    os.environ["BENCHMARK_BASE_URL"] = "http://tsecbench.zc.tencent.com.tsecbench.gw"
    os.environ.pop("PLATFORM_BASE_URL", None)
    allowed = core.challenge_url(
        os.environ["BENCHMARK_BASE_URL"],
        "/openapi/v1/challenges/start?unique_code=e1-02",
    )
    foreign = ""
    try:
        driver.start_challenge_live(
            "http://api.deepseek.com.tsecbench.gw",
            "/openapi/v1",
            "secret-token",
            "e1-02",
        )
    except driver.DriverError as exc:
        foreign = str(exc)
    payload = {
        "prefix": prefix,
        "addrs": addrs,
        "liveHits": live_hits,
        "apiAddrs": api_addrs,
        "apiHits": api_hits,
        "emptyAddrs": empty_addrs,
        "emptyHits": empty_hits,
        "bodyOnly": body_only,
        "pathOnly": path_only,
        "visitOk": bool(visited.get("ok")),
        "visitStatus": visited.get("status") or "",
        "visitError": visited.get("error") or "",
        "allowed": allowed,
        "foreign": foreign,
    }
finally:
    server.shutdown()
print(json.dumps(payload))
`;
  const result = runPython(['-c', script], { PYTHONPATH: path.join(repoRoot, 'contest') });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const cases = JSON.parse(result.stdout);
  assert.equal(cases.prefix, '/openapi/v1');
  assert.deepEqual(cases.addrs, ['http://10.0.0.1:80']);
  const posts = cases.liveHits.filter((hit) => hit.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/openapi/v1/challenges/start?unique_code=e1-02');
  assert.equal(posts[0].route, '/openapi/v1/challenges/start');
  assert.deepEqual(posts[0].query.unique_code, ['e1-02']);
  assert.equal(posts[0].body, '{}');
  assert.equal(posts[0].token, 'secret-token');
  assert.equal(posts[0].authorization, 'Bearer secret-token');
  assert.equal(
    cases.liveHits.some((hit) => /\/challenges\/[^/]+\/start/.test(hit.route)),
    false,
  );
  assert.match(cases.bodyOnly, /HTTP 422/);
  assert.match(cases.bodyOnly, /\["query", "unique_code"\]/);
  assert.match(cases.pathOnly, /HTTP 404/);
  assert.match(cases.pathOnly, /\/challenges\/e1-02\/start/);
  assert.deepEqual(cases.apiAddrs, ['http://10.0.0.1:80']);
  assert.equal(cases.apiHits.length, 1);
  assert.equal(cases.apiHits[0].path, '/api/v1/challenges/start?unique_code=a-01');
  assert.equal(cases.apiHits[0].body, '{}');
  assert.deepEqual(cases.emptyAddrs, ['http://10.0.0.1:80']);
  assert.deepEqual(
    cases.emptyHits.map((hit) => hit.path),
    [
      '/api/v1/challenges/start?unique_code=fallback-1',
      '/openapi/v1/challenges/start?unique_code=fallback-1',
    ],
  );
  assert.equal(cases.visitOk, true, cases.visitError);
  assert.equal(cases.visitStatus, 'seeded');
  assert.doesNotMatch(result.stderr, /HTTP 422/);
  assert.match(result.stderr, /visit e1-02 seeded/);
  assert.equal(
    cases.allowed,
    'http://tsecbench.zc.tencent.com.tsecbench.gw/openapi/v1/challenges/start?unique_code=e1-02',
  );
  assert.match(cases.foreign, /BENCHMARK_BASE_URL/);
  assert.match(cases.foreign, /api\.deepseek\.com\.tsecbench\.gw/);
});

test('submit_flag 在提交请求上带 BENCHMARK_TOKEN', async () => {
  // submit_flag 走 fetch。同进程 HTTP stub 会被 spawnSync 卡住，所以 stub 单独起进程。
  const scratch = tmpDir('fgs-submit-hdr-');
  const hitFile = path.join(scratch, 'hits.jsonl');
  const server = spawn(process.execPath, ['-e', [
    "const http = require('http');",
    "const fs = require('fs');",
    'const server = http.createServer((req, res) => {',
    '  fs.appendFileSync(process.env.HIT_FILE, JSON.stringify({',
    '    path: req.url,',
    '    token: req.headers.benchmark_token,',
    '    authorization: req.headers.authorization,',
    "  }) + '\\n');",
    "  res.writeHead(200, { 'content-type': 'application/json' });",
    "  res.end('{\"correct\":true}');",
    '});',
    "server.listen(0, '127.0.0.1', () => {",
    "  process.stdout.write('PORT ' + server.address().port + '\\n');",
    '});',
  ].join('\n')], {
    env: { ...process.env, HIT_FILE: hitFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('submit stub did not listen')), 5000);
    server.stdout.on('data', (chunk) => {
      buf += chunk;
      const match = buf.match(/PORT (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.on('error', reject);
    server.on('exit', (code) => reject(new Error(`submit stub exited ${code}`)));
  });
  try {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'submit_flag.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify({
        facts: [{ id: 'fact_001', title: 'flag{abcd1234}', content: 'got flag{abcd1234}' }],
      }),
      env: {
        ...process.env,
        BENCHMARK_BASE_URL: `http://127.0.0.1:${port}`,
        BENCHMARK_TOKEN: 'secret-token',
        FGS_UNIQUE_CODE: 'b-02',
      },
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const hits = fs.readFileSync(hitFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, '/openapi/v1/challenges/submit');
    assert.equal(hits[0].token, 'secret-token');
    assert.equal(hits[0].authorization, 'Bearer secret-token');
  } finally {
    server.kill();
  }
});

test('fixture 队列预种后图存在，第二次 driver 不改 graph.yaml', () => {
  const scratch = tmpDir('fgs-contest-');
  const workdir = path.join(scratch, 'work');
  const fixture = writeFixture(scratch, [
    {
      unique_code: 'A-10',
      description: '示例题面：找 flag',
      is_completed: false,
      container_addr: ['http://10.0.0.8:8080'],
    },
    {
      unique_code: 'done-1',
      description: '已通关',
      is_completed: true,
      container_addr: ['http://10.0.0.9'],
    },
  ]);
  const env = {
    BENCHMARK_TOKEN: 'test-token',
    BENCHMARK_BASE_URL: 'http://benchmark.invalid',
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: workdir,
    CONTEST_DSH_LAUNCH: '0',
    SOLVER_GATEWAY: '1',
    OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
    CONTEST_MAX_CONCURRENCY: '3',
  };
  const first = runPython([driver], env);
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  assert.match(first.stderr, /rewrote OPENAI_BASE_URL/);
  assert.match(first.stderr, /max concurrency/);
  assert.equal(fs.existsSync(path.join(workdir, 'done-1')), false);

  const cwd = path.join(workdir, 'a-10');
  const graphPath = path.join(cwd, '.fgs', 'projects', 'a-10', 'graph.yaml');
  const index = JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'competition.json'), 'utf8'));
  assert.equal(index.activeProblemId, 'a-10');
  const graph = new GraphStore(path.join(cwd, '.fgs', 'projects', 'a-10')).load();
  assert.equal(graph.facts[0].id, 'fact_origin');
  assert.equal(graph.goals[0].id, 'goal_final');
  assert.match(graph.goals[0].criterion, /correct=true/);
  const origin = JSON.parse(graph.facts[0].content);
  assert.equal(origin.target, 'http://10.0.0.8:8080');
  assert.match(origin.brief, /示例题面/);
  assert.match(origin.brief, /container_addr: http:\/\/10\.0\.0\.8:8080/);
  const launch = JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'dsh-launch.json'), 'utf8'));
  assert.equal(launch.stub, true);
  assert.equal(launch.provider, 'openai-completions');
  assert.match(fs.readFileSync(path.join(cwd, 'prompt.txt'), 'utf8'), /不要调用 fgs_project/);

  const bytes = fs.readFileSync(graphPath);
  const second = spawnSync(entrypoint, [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /already-seeded/);
  assert.deepEqual(fs.readFileSync(graphPath), bytes);
});

test('start 没有 container_addr 时不写 .fgs，entrypoint 缺 token/base 则失败', () => {
  const scratch = tmpDir('fgs-contest-empty-');
  const workdir = path.join(scratch, 'work');
  const fixture = writeFixture(scratch, [
    {
      unique_code: 'no-addr',
      description: 'start 失败',
      is_completed: false,
      container_addr: [],
    },
  ]);
  const failed = runPython([driver], {
    BENCHMARK_TOKEN: 'test-token',
    BENCHMARK_BASE_URL: 'http://benchmark.invalid',
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: workdir,
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /container_addr/);
  assert.equal(fs.existsSync(path.join(workdir, 'no-addr', '.fgs')), false);

  const noToken = spawnSync(entrypoint, [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, BENCHMARK_TOKEN: '', BENCHMARK_BASE_URL: 'http://benchmark.invalid' },
  });
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /BENCHMARK_TOKEN/);

  const noBase = spawnSync(entrypoint, [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, BENCHMARK_TOKEN: 't', BENCHMARK_BASE_URL: '' },
  });
  assert.notEqual(noBase.status, 0);
  assert.match(noBase.stderr, /BENCHMARK_BASE_URL/);
});

test('driver：v5.2 并发 Decide 的 4 个旋钮透传给编排器', () => {
  const script = [
    'import json, os',
    'from pathlib import Path',
    'import driver',
    'ws = Path("/tmp/ws")',
    'os.environ["CONTEST_DSH_LAUNCH"] = "1"',
    'os.environ.pop("CONTEST_ACTIVITY_RUNS", None)',
    'os.environ.pop("CONTEST_WORKER_CMD", None)',
    'os.environ.pop("CONTEST_CONCURRENT_DECIDE", None)',
    'os.environ.pop("CONTEST_DECIDE_TIMEOUT", None)',
    'os.environ.pop("CONTEST_MAX_DECIDES", None)',
    'os.environ.pop("CONTEST_REBASE_MODE", None)',
    'base = driver.activity_loop_argv(ws, "p-1")',
    'os.environ["CONTEST_CONCURRENT_DECIDE"] = "1"',
    'os.environ["CONTEST_DECIDE_TIMEOUT"] = "42"',
    'os.environ["CONTEST_MAX_DECIDES"] = "3"',
    'os.environ["CONTEST_REBASE_MODE"] = "append"',
    'tuned = driver.activity_loop_argv(ws, "p-1")',
    'os.environ["CONTEST_REBASE_MODE"] = "bogus"',
    'bogus = driver.activity_loop_argv(ws, "p-1")',
    'print(json.dumps({"base": base, "tuned": tuned, "bogus": bogus}))',
  ].join('\n');
  const bin = tmpDir('fgs-fake-dsh-');
  const fakeDsh = path.join(bin, 'dsh');
  fs.writeFileSync(fakeDsh, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeDsh, 0o755);
  const result = runPython(['-c', script], {
    PYTHONPATH: path.join(repoRoot, 'contest'),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  // 默认：不打开并发，但 Decide 超时/次数/模式始终显式传给编排器。
  assert.equal(payload.base.includes('--concurrent-decide'), false);
  assert.match(payload.base.join(' '), /--decide-timeout-sec 300/);
  assert.match(payload.base.join(' '), /--max-decides 12/);
  assert.match(payload.base.join(' '), /--rebase-mode full/);

  assert.equal(payload.tuned.includes('--concurrent-decide'), true);
  assert.match(payload.tuned.join(' '), /--decide-timeout-sec 42/);
  assert.match(payload.tuned.join(' '), /--max-decides 3/);
  assert.match(payload.tuned.join(' '), /--rebase-mode append/);

  // 非法模式不透传（编排器自己默认 full），不把脏值传下去。
  assert.equal(payload.bogus.includes('--rebase-mode'), false);
});
