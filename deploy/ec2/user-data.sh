#!/bin/bash
# EC2 bootstrap (Ubuntu 24.04): installs Docker and runs the stack with docker-compose.prod.yml.
# __REPO_URL__ and __REPO_REF__ are substituted by deploy.sh.
set -euxo pipefail
exec > >(tee -a /var/log/cloud-job-runner-bootstrap.log) 2>&1

REPO_URL="__REPO_URL__"
REPO_REF="__REPO_REF__"
APP_DIR=/opt/cloud-job-runner

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Docker Hub can rate-limit anonymous pulls; use the GCR mirror and tag to the names compose expects.
for image in node:22-alpine redis:7-alpine; do
  docker pull "mirror.gcr.io/library/$image" && docker tag "mirror.gcr.io/library/$image" "$image" || true
done

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git fetch --all --tags
git checkout --detach "origin/$REPO_REF" 2>/dev/null || git checkout --detach "$REPO_REF"

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
