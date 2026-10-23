#!/usr/bin/env python3
"""一次性假模型（OpenAI-completions 流式）：给离线冒烟测试用。

脚本化行为（按会话内 tool 结果数量推进）：
  0 个 tool 结果  → 调 fgs_open_step {action, from:[fact_origin]}
  1 个 tool 结果  → 调 fgs_commit {}
  >=2 个 tool 结果 → 纯文本 "activity done"

用于验证：真实 DSH + FGS 活动模式（注册期工具隔离、上下文注入、真实 dispatch、台账）。
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791

STATE = {"calls": 0}


def tool_call(name, args):
    return {
        "id": f"call_{STATE['calls']}",
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
    }


def decide_tool(messages):
    tool_results = [m for m in messages if m.get("role") == "tool"]
    known = " ".join(str(m.get("content", ""))[:200] for m in tool_results)
    if len(tool_results) == 0:
        return tool_call("fgs_open_step", {"action": "冒烟：确认真实 host 能改图", "from": ["fact_origin"]})
    if "已记入草稿" in known or len(tool_results) == 1:
        return tool_call("fgs_commit", {})
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("fake-llm: " + (fmt % args) + "\n")

    def _json(self, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _sse(self, chunks):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_GET(self):
        if self.path.endswith("/models"):
            self._json({"object": "list", "data": [{"id": "fake-1", "object": "model"}]})
            return
        self._json({"ok": True})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {}
        STATE["calls"] += 1
        messages = body.get("messages") or []
        call = decide_tool(messages)
        stream = bool(body.get("stream"))

        if call is not None:
            deltas = [
                {"choices": [{"index": 0, "delta": {"role": "assistant", "content": None}}]},
                {"choices": [{"index": 0, "delta": {"tool_calls": [{
                    "index": 0, "id": call["id"], "type": "function", "function": call["function"],
                }]}}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
            ]
            finish = "tool_calls"
            message = {"role": "assistant", "content": None, "tool_calls": [call]}
        else:
            deltas = [
                {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "activity "}}]},
                {"choices": [{"index": 0, "delta": {"content": "done"}}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            ]
            finish = "stop"
            message = {"role": "assistant", "content": "activity done"}

        if stream:
            self._sse(deltas)
            return
        self._json({
            "id": f"chatcmpl-{STATE['calls']}",
            "object": "chat.completion",
            "created": 0,
            "model": body.get("model", "fake-1"),
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        })


def main():
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"fake-llm listening on {PORT}", file=sys.stderr, flush=True)
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        import time
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
