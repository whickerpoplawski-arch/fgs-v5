#!/bin/sh
# After grace, kill workers that are deferred/solved or already completed
# on the platform, then close the container. Does not dispatch.
set -eu

: "${RUN:?contest: missing RUN (set the run root; do not hardcode a run directory)}"
: "${BENCHMARK_TOKEN:?contest: missing BENCHMARK_TOKEN (platform injects this at runtime; do not bake it into the image)}"
: "${BENCHMARK_BASE_URL:?contest: missing BENCHMARK_BASE_URL (platform injects this at runtime; do not bake it into the image)}"

HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec python3 "$HERE/cli.py" retire "$@"
