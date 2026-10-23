# TSecBench hosted Agent image (example).
#
# The platform does not mandate Dockerfile / ENTRYPOINT / CMD / WORKDIR.
# The behavioral rule is: after the container starts, it must begin solving
# on its own. ENTRYPOINT below is how this repo meets that rule.
#
# Do not bake secrets into the image. The platform injects BENCHMARK_TOKEN and
# BENCHMARK_BASE_URL at runtime — do not set them here or on the upload form.
# Put LLM keys in the upload-page env. Upload cap is 3GB (.tar / .tar.gz / .tgz).
#
# Hosted has no public internet. Set SOLVER_GATEWAY=1 at runtime so the driver
# rewrites model bases only (never BENCHMARK_BASE_URL):
#   https://api.deepseek.com/v1 → http://api.deepseek.com.tsecbench.gw/v1
#
# dsh is not vendored in this P0 skeleton. Install the harness in the real
# image and set CONTEST_DSH_LAUNCH=1. Until then the driver still pre-seeds
# `.fgs/` and records a dsh launch stub.
#
# The driver also runs the contest supervisor (reap / retire / dual-guard).
# Do not add a second autosup process to this image.
#
#   docker build -f contest/Dockerfile -t fgs-contest .
#   docker save fgs-contest:latest | gzip > agent.tar.gz
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/fgs
COPY . .
RUN chmod +x contest/entrypoint.sh contest/supervisor/*.sh \
 && mkdir -p /var/lib/fgs-contest

# Per-challenge cwds. Token and base URL stay out of the image.
ENV CONTEST_WORKDIR=/var/lib/fgs-contest

ENTRYPOINT ["contest/entrypoint.sh"]
