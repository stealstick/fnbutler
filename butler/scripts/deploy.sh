#!/usr/bin/env bash
# Deploy keystone on the Postgres production stack.
#
# This wrapper keeps the old entry point working while delegating to the
# Cloud SQL + Cloud Run + Cloud Scheduler bootstrap script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$ROOT/scripts/gcloud-postgres-bootstrap.sh" "$@"
