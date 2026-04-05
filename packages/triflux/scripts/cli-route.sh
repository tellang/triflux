#!/usr/bin/env bash
# cli-route.sh — backward-compat 래퍼
exec bash "$(dirname "$0")/tfx-route.sh" "$@"
