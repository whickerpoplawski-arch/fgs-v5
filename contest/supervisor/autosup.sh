#!/bin/sh
# Worker-directory supervisor loop (gc → retire → reap → dual-guard dispatch).
# Hosted entrypoint does not start this. contest/driver.py is the contest
# scheduler; if its lock is held, this process exits instead of dispatching.
set -eu

: "${RUN:?contest: missing RUN (set the run root; do not hardcode a run directory)}"
: "${BENCHMARK_TOKEN:?contest: missing BENCHMARK_TOKEN (platform injects this at runtime; do not bake it into the image)}"
: "${BENCHMARK_BASE_URL:?contest: missing BENCHMARK_BASE_URL (platform injects this at runtime; do not bake it into the image)}"

HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec python3 "$HERE/cli.py" autosup "$@"
