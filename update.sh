#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo ">>> [pi-qoder] 正在更新 Qoder 核心协议 (Git Submodule)..."
git -C "$DIR" submodule update --remote --merge
echo ">>> 更新完成！当前 Submodule 最新 Commit:"
git -C "$DIR/vendor/dsh-connect-qoder" log -1 --pretty=format:"%h - %s (%cr)"
echo ""
