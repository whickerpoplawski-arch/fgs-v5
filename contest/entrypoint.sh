#!/bin/sh
# TSecBench hosted Agent entry.
#
# The platform does not mandate ENTRYPOINT syntax. It does require the image
# to start solving by itself after the container launches. This script is that
# start: validate the injected env, then exec the driver. The driver lists
# challenges, starts each one, disk-seeds FGS, and only then launches dsh.
#
# CONTEST_SUPERVISOR defaults on. Reap / retire / the dual-guard refill run
# inside the driver so there is one scheduler. This script does not start
# contest/supervisor/autosup.sh (that loop is the worker-directory layout and
# would dispatch a second time).
#
# Do not bake BENCHMARK_TOKEN, BENCHMARK_BASE_URL, or LLM keys into the image.
# The platform injects the first two at runtime. Fill model keys on the upload
# page (or a runtime env file), never in this script.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ -z "${BENCHMARK_TOKEN:-}" ]; then
  echo "contest: missing BENCHMARK_TOKEN (platform injects this at runtime; do not bake it into the image)" >&2
  exit 1
fi

if [ -z "${BENCHMARK_BASE_URL:-}" ]; then
  echo "contest: missing BENCHMARK_BASE_URL (platform injects this at runtime; do not bake it into the image)" >&2
  exit 1
fi

# SOLVER_GATEWAY=1: the driver rewrites model base URLs only
#   (DEEPSEEK_BASE_URL, OPENAI_BASE_URL, and baseURL inside $DSH_HOME/profiles
#   or $CONTEST_DSH_PROFILE_DIR):
#   https://api.deepseek.com/v1 → http://api.deepseek.com.tsecbench.gw/v1
# This script does not rewrite env or profiles. BENCHMARK_BASE_URL,
# BENCHMARK_TOKEN, and Challenges API URLs stay as the platform injected them.
# Hosted sandboxes have no public internet. Leave the flag unset for local runs.
#
# VPN is optional. Integration docs say challenge addresses need a task VPN;
# the hosted upload page does not say the sandbox already includes one.
# Default is off (CONTEST_VPN unset) so pre-seed is not blocked on that ambiguity.
# Set CONTEST_VPN=1 plus CONTEST_VPN_CONFIG and CONTEST_VPN_EXEC to opt in.
#
# CONTEST_SUPERVISOR=0 skips the in-driver loop (local one-shot). Any other
# value, including unset, turns it on.

case "${CONTEST_SUPERVISOR:-1}" in
  0|false|no|off|FALSE|NO|OFF)
    export CONTEST_SUPERVISOR=0
    ;;
  *)
    export CONTEST_SUPERVISOR=1
    ;;
esac

if [ -z "${RUN:-}" ]; then
  if [ -n "${CONTEST_WORKDIR:-}" ]; then
    export RUN="$CONTEST_WORKDIR"
  else
    export RUN="$ROOT/contest-work"
  fi
fi

exec python3 "$ROOT/contest/driver.py" "$@"
