#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

TARGET_SHA="${1:-}"
BRANCH="${WHUSU_SMART_WORKSPACE_DEPLOY_BRANCH:-main}"
REPO_DIR="${WHUSU_SMART_WORKSPACE_REPO_DIR:-/home/ubuntu/whusu-smart-workspace}"
RELEASES_DIR="${WHUSU_SMART_WORKSPACE_RELEASES_DIR:-/home/ubuntu/whusu-smart-workspace-releases}"
CURRENT_LINK="${WHUSU_SMART_WORKSPACE_CURRENT_LINK:-/home/ubuntu/whusu-smart-workspace-current}"
SHARED_DIR="${WHUSU_SMART_WORKSPACE_SHARED_DIR:-/home/ubuntu/whusu-smart-workspace-shared}"
DEPLOY_DIR="${WHUSU_SMART_WORKSPACE_DEPLOY_DIR:-/home/ubuntu/whusu-smart-workspace-deploy}"
STATE_DIR="$DEPLOY_DIR/state"
LOG_DIR="$DEPLOY_DIR/logs"
BACKUP_DIR="$DEPLOY_DIR/backups"
MAINTENANCE_FLAG="${WHUSU_SMART_WORKSPACE_MAINTENANCE_FLAG:-/var/lib/whusu-smart-workspace-deploy/maintenance.flag}"
LOCK_FILE="$DEPLOY_DIR/deploy.lock"
DRAIN_SECONDS="${WHUSU_SMART_WORKSPACE_DRAIN_SECONDS:-35}"
PUBLIC_HEALTH_URL="${WHUSU_SMART_WORKSPACE_PUBLIC_HEALTH_URL:-https://accumulation93.com/api/health}"
RELEASE_KEEP_COUNT="${WHUSU_SMART_WORKSPACE_RELEASE_KEEP_COUNT:-5}"
GIT_TIMEOUT_SECONDS="${WHUSU_SMART_WORKSPACE_GIT_TIMEOUT_SECONDS:-90}"

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "部署 SHA 必须是 40 位小写十六进制" >&2
  exit 64
fi

# 锁必须覆盖所有会改变远端状态的操作；仅允许为锁文件本身准备父目录。
mkdir -p "$DEPLOY_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "已有生产部署正在执行，本次提交交由后续任务处理"
  exit 75
fi

mkdir -p "$RELEASES_DIR" "$SHARED_DIR" "$STATE_DIR" "$LOG_DIR" "$BACKUP_DIR" \
  "$SHARED_DIR/uploads/audit/_tmp"

mapfile -t EXISTING_RELEASES < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print)
for existing_release in "${EXISTING_RELEASES[@]}"; do
  release_env="$existing_release/server/.env"
  if [[ -L "$release_env" || ! -e "$release_env" ]]; then
    ln -sfn "$SHARED_DIR/server.env" "$release_env"
  fi
done
git -C "$REPO_DIR" remote set-url origin git@github.com:Accumulation93/WHUSU-Smart-Workspace.git

LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S)-${TARGET_SHA:0:12}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

STARTED_AT="$(date +%s)"
OLD_RELEASE=""
OLD_SHA=""
NEW_RELEASE="$RELEASES_DIR/$TARGET_SHA"
SNAPSHOT=""
MAINTENANCE_ACTIVE=0
MIGRATION_STARTED=0
RELEASE_SWITCHED=0
WORKER_STOPPED=0
API_STOPPED=0
BACKUP_STOPPED=0
UTC_CUTOVER_REQUIRED=0

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

git_with_timeout() {
  timeout --signal=TERM --kill-after=10s "${GIT_TIMEOUT_SECONDS}s" git "$@"
}

atomic_link() {
  local target="$1"
  local temporary="$CURRENT_LINK.next.$$"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$CURRENT_LINK"
}

read_port() {
  node -e '
    const fs = require("fs");
    const line = fs.readFileSync(process.argv[1], "utf8")
      .split(/\r?\n/)
      .find((item) => /^\s*(?:export\s+)?PORT\s*=/.test(item));
    if (!line) {
      process.stdout.write("3000");
      process.exit(0);
    }
    let value = line.replace(/^\s*(?:export\s+)?PORT\s*=\s*/, "").trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("\x27") && value.endsWith("\x27"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.stdout.write(value || "3000");
  ' "$SHARED_DIR/server.env"
}

wait_for_health() {
  local port="$1"
  local attempt
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --max-time 4 "http://127.0.0.1:${port}/api/health" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

reload_release() {
  local process_release="${1:-$NEW_RELEASE}"
  if [[ ! -f "$process_release/server/ecosystem.config.js" ]]; then
    log "版本进程配置不存在，拒绝重载：$process_release"
    return 1
  fi
  WHUSU_SMART_WORKSPACE_SERVER_ROOT="$CURRENT_LINK/server" pm2 startOrReload "$process_release/server/ecosystem.config.js" --only whusu-smart-workspace-api --update-env
  WHUSU_SMART_WORKSPACE_SERVER_ROOT="$CURRENT_LINK/server" pm2 startOrReload "$process_release/server/ecosystem.config.js" --only whusu-smart-workspace-notification-worker --update-env
  # PM2 startOrReload keeps the old cwd for an existing fork process. Recreate
  # only the backup process so it always follows the atomically switched release.
  pm2 delete whusu-smart-workspace-backup >/dev/null 2>&1 || true
  WHUSU_SMART_WORKSPACE_SERVER_ROOT="$CURRENT_LINK/server" pm2 start "$process_release/server/ecosystem.config.js" --only whusu-smart-workspace-backup --update-env
}

resolve_rollback_tool_release() {
  local candidate
  for candidate in "$OLD_RELEASE" "$NEW_RELEASE"; do
    if [[ -n "$candidate"
      && -f "$candidate/server/scripts/deploymentDatabase.js"
      && -f "$candidate/server/scripts/migrateAuditUploads.js" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

stop_process_group() {
  local process_name="$1"
  local attempt
  pm2 stop "$process_name"
  for attempt in $(seq 1 15); do
    if pm2 jlist | node -e '
      let source = "";
      process.stdin.on("data", (chunk) => { source += chunk; });
      process.stdin.on("end", () => {
        const processes = JSON.parse(source);
        const name = process.argv[1];
        const active = processes.some((item) => item.name === name
          && item.pm2_env && item.pm2_env.status !== "stopped");
        process.exit(active ? 1 : 0);
      });
    ' "$process_name"; then
      return 0
    fi
    sleep 1
  done
  log "进程组 $process_name 未能确认停止"
  return 1
}

rollback() {
  local failed_line="$1"
  trap - ERR TERM INT HUP
  set +e
  log "部署在第 ${failed_line} 行失败，开始自动恢复"
  if [[ "$MIGRATION_STARTED" -eq 1 && -n "$SNAPSHOT" && -f "$SNAPSHOT" ]]; then
    log "确认停止 API、通知 Worker 与备份进程，释放数据库连接"
    local rollback_stop_failed=0
    stop_process_group whusu-smart-workspace-api || rollback_stop_failed=1
    stop_process_group whusu-smart-workspace-notification-worker || rollback_stop_failed=1
    stop_process_group whusu-smart-workspace-backup || rollback_stop_failed=1
    if [[ "$rollback_stop_failed" -ne 0 ]]; then
      log "无法确认全部数据库客户端已经停止，拒绝恢复快照或切换旧版本"
      touch "$MAINTENANCE_FLAG"
      exit 1
    fi
    local rollback_tool_release=""
    if ! rollback_tool_release="$(resolve_rollback_tool_release)"; then
      log "旧版本和失败版本均缺少数据库恢复工具，保留维护状态并停止回滚"
      touch "$MAINTENANCE_FLAG"
      exit 1
    fi
    log "使用稳定版本恢复工具：$rollback_tool_release"
    log "恢复部署前数据库快照"
    if ! node "$rollback_tool_release/server/scripts/deploymentDatabase.js" restore "$SNAPSHOT"; then
      log "数据库快照恢复失败，保留维护状态并停止回滚"
      touch "$MAINTENANCE_FLAG"
      exit 1
    fi
    if ! AUDIT_UPLOAD_DIR="$SHARED_DIR/uploads/audit" \
      AUDIT_UPLOAD_LEGACY_ROOTS="$REPO_DIR/server/uploads:$SHARED_DIR/uploads/audit:/home/ubuntu/redsu_scoring/server/uploads" \
      node "$rollback_tool_release/server/scripts/migrateAuditUploads.js"; then
      log "数据库回滚后附件路径恢复失败，保留维护状态并停止回滚"
      touch "$MAINTENANCE_FLAG"
      exit 1
    fi
  fi
  if [[ -n "$OLD_RELEASE" && -d "$OLD_RELEASE" ]]; then
    log "切回旧版本 $OLD_SHA"
    if ! atomic_link "$OLD_RELEASE"; then
      log "旧版本链接切换失败，保留维护状态"
      touch "$MAINTENANCE_FLAG"
      exit 1
    fi
    if ! reload_release "$OLD_RELEASE"; then
      log "旧版本进程重载失败，保留维护状态"
      touch "$MAINTENANCE_FLAG"
      exit 1
    fi
    local port
    port="$(read_port)"
    if wait_for_health "$port"; then
      pm2 save
      if [[ "$MAINTENANCE_ACTIVE" -eq 1 ]]; then rm -f "$MAINTENANCE_FLAG"; fi
      log "旧版本和数据库恢复成功"
    else
      log "旧版本健康检查仍失败，保留维护状态"
      touch "$MAINTENANCE_FLAG"
    fi
  else
    if [[ "$MAINTENANCE_ACTIVE" -eq 1 || "$API_STOPPED" -eq 1 || "$WORKER_STOPPED" -eq 1 || "$BACKUP_STOPPED" -eq 1 ]]; then
      log "未找到可回退的旧 release，保留维护状态"
      touch "$MAINTENANCE_FLAG"
    fi
  fi
  if [[ -d "$NEW_RELEASE" && "$NEW_RELEASE" != "$OLD_RELEASE" ]]; then
    git -C "$REPO_DIR" worktree remove --force "$NEW_RELEASE" >/dev/null 2>&1 || true
  fi
  exit 1
}

trap 'rollback "$LINENO"' ERR
trap 'rollback "$LINENO"' TERM INT HUP

log "开始部署 $TARGET_SHA"
[[ -d "$REPO_DIR/.git" ]] || { log "远端仓库不存在"; exit 1; }
[[ -f "$SHARED_DIR/server.env" ]] || { log "共享 server.env 不存在"; exit 1; }
if [[ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]]; then
  log "远端仓库存在已跟踪修改，拒绝覆盖"
  exit 1
fi

if [[ -L "$CURRENT_LINK" ]]; then
  OLD_RELEASE="$(readlink -f "$CURRENT_LINK")"
  OLD_SHA="$(basename "$OLD_RELEASE")"
fi

git_with_timeout -C "$REPO_DIR" fetch --prune origin "$BRANCH"
REMOTE_SHA="$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH")"
if [[ "$REMOTE_SHA" != "$TARGET_SHA" ]]; then
  log "提交已被更新的分支头替代，跳过过期部署：当前 $REMOTE_SHA"
  exit 0
fi
git -C "$REPO_DIR" switch "$BRANCH"
git_with_timeout -C "$REPO_DIR" pull --ff-only origin "$BRANCH"
[[ "$(git -C "$REPO_DIR" rev-parse HEAD)" == "$TARGET_SHA" ]] || { log "拉取结果与目标 SHA 不一致"; exit 1; }

if [[ -n "$OLD_SHA" && "$OLD_SHA" =~ ^[0-9a-f]{40}$ ]] && git -C "$REPO_DIR" diff --quiet "$OLD_SHA" "$TARGET_SHA" -- server; then
  printf '%s\n' "$TARGET_SHA" > "$STATE_DIR/repository_sha"
  log "服务端目录未变化，仅同步远端仓库"
  exit 0
fi

if [[ -e "$NEW_RELEASE" ]]; then
  [[ "$NEW_RELEASE" != "$OLD_RELEASE" ]] || { log "目标版本已经在运行"; exit 0; }
  git -C "$REPO_DIR" worktree remove --force "$NEW_RELEASE"
fi
git -C "$REPO_DIR" worktree add --detach "$NEW_RELEASE" "$TARGET_SHA"
ln -s "$SHARED_DIR/server.env" "$NEW_RELEASE/server/.env"
if [[ -e "$NEW_RELEASE/server/uploads" || -L "$NEW_RELEASE/server/uploads" ]]; then
  log "新 release 内存在非预期 uploads 路径，拒绝覆盖"
  exit 1
fi
ln -s "$SHARED_DIR/uploads" "$NEW_RELEASE/server/uploads"

log "安装锁定的生产依赖"
timeout --signal=TERM --kill-after=30s 300s npm --prefix "$NEW_RELEASE/server" ci --omit=dev --no-audit --no-fund
log "执行发布前语法与自动化检查"
while IFS= read -r -d '' file; do node --check "$file"; done < <(find "$NEW_RELEASE/server" -path '*/node_modules' -prune -o -name '*.js' -type f -print0)
node "$NEW_RELEASE/server/test/deploymentAutomation.test.js"

# 密钥只在受锁保护的生产服务器首次生成；清单和独立恢复副本必须同时自检通过。
export AUDIT_EVIDENCE_KEYRING_PATH="$SHARED_DIR/signing-evidence/keyring.json"
export AUDIT_EVIDENCE_BACKUP_KEYRING_PATH="$DEPLOY_DIR/key-backups/signing-evidence/keyring.json"
log "初始化或核验平台签署密钥与恢复副本"
timeout --signal=TERM --kill-after=10s 120s node "$NEW_RELEASE/server/scripts/provisionSigningEvidence.js"
timeout --signal=TERM --kill-after=10s 60s node "$NEW_RELEASE/server/scripts/preflightSigningEvidence.js"

PLAN_JSON="$(node "$NEW_RELEASE/server/scripts/runDeploymentMigrations.js" plan | tail -n 1)"
PENDING_COUNT="$(printf '%s' "$PLAN_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).pendingCount)))")"
if [[ "$PLAN_JSON" == *"20260825234500_score_calculation_context_snapshot.sql"* ]]; then
  log "执行旧评分记录不可变快照只读预检"
  timeout --signal=TERM --kill-after=30s 600s \
    node "$NEW_RELEASE/server/scripts/backfillScoreCalculationSnapshots.js" --require-all
fi
if [[ "$PLAN_JSON" == *"20260826170000_score_snapshot_v2_normalization.sql"* ]]; then
  log "执行评分计算快照 v2 全量规范化预检"
  timeout --signal=TERM --kill-after=30s 600s \
    node "$NEW_RELEASE/server/scripts/normalizeScoreCalculationSnapshots.js" --preflight
fi
if [[ "$PLAN_JSON" == *"20260823190000_utc_time_normalization.sql"* ]]; then
  log "执行生产时间来源只读预检"
  timeout --signal=TERM --kill-after=30s 300s node "$NEW_RELEASE/server/scripts/preflightUtcTimeMigration.js" --strict
  UTC_CUTOVER_REQUIRED=1
else
  UTC_CUTOVER_STATUS="$(timeout --signal=TERM --kill-after=10s 60s node "$NEW_RELEASE/server/scripts/materializeUtcTimeReviews.js" --status)"
  if [[ "$UTC_CUTOVER_STATUS" == "missing" ]]; then
    log "UTC 迁移已记账但切换记录缺失，拒绝继续发布"
    exit 1
  fi
  if [[ "$UTC_CUTOVER_STATUS" != "verified" && "$UTC_CUTOVER_STATUS" != "review_pending" ]]; then
    UTC_CUTOVER_REQUIRED=1
    log "检测到未完成的 UTC 切换状态：$UTC_CUTOVER_STATUS"
  fi
fi
if [[ "$PENDING_COUNT" -gt 0 || "$UTC_CUTOVER_REQUIRED" -eq 1 ]]; then
  log "检测到 $PENDING_COUNT 个待执行迁移，UTC 切换待恢复=$UTC_CUTOVER_REQUIRED，进入维护状态"
  touch "$MAINTENANCE_FLAG"
  MAINTENANCE_ACTIVE=1
  stop_process_group whusu-smart-workspace-api
  API_STOPPED=1
  stop_process_group whusu-smart-workspace-notification-worker
  WORKER_STOPPED=1
  stop_process_group whusu-smart-workspace-backup
  BACKUP_STOPPED=1
  sleep "$DRAIN_SECONDS"
  SNAPSHOT="$BACKUP_DIR/pre-${TARGET_SHA}-$(date +%Y%m%d-%H%M%S).sql.gz"
  timeout --signal=TERM --kill-after=30s 600s node "$NEW_RELEASE/server/scripts/deploymentDatabase.js" backup "$SNAPSHOT"
  MIGRATION_STARTED=1
  if [[ "$PENDING_COUNT" -gt 0 ]]; then
    timeout --signal=TERM --kill-after=30s 600s node "$NEW_RELEASE/server/scripts/runDeploymentMigrations.js" apply --sha "$TARGET_SHA"
  fi
  if [[ "$PLAN_JSON" == *"20260825234500_score_calculation_context_snapshot.sql"* ]]; then
    log "按活动回填或隔离旧评分记录不可变快照"
    timeout --signal=TERM --kill-after=30s 1200s \
      node "$NEW_RELEASE/server/scripts/backfillScoreCalculationSnapshots.js" --apply --require-all
  fi
  if [[ "$PLAN_JSON" == *"20260826170000_score_snapshot_v2_normalization.sql"* ]]; then
    log "统一全部评分计算快照为固定 v2 字段结构"
    timeout --signal=TERM --kill-after=30s 1200s \
      node "$NEW_RELEASE/server/scripts/normalizeScoreCalculationSnapshots.js" --apply
    log "逐条验证评分计算快照 v2 结构和签名"
    timeout --signal=TERM --kill-after=30s 1200s \
      node "$NEW_RELEASE/server/scripts/normalizeScoreCalculationSnapshots.js" --verify
  fi
  if [[ "$UTC_CUTOVER_REQUIRED" -eq 1 || "$PENDING_COUNT" -gt 0 ]]; then
    log "物化逐记录历史时间待核对账本"
    timeout --signal=TERM --kill-after=30s 1200s node "$NEW_RELEASE/server/scripts/materializeUtcTimeReviews.js" --materialize
    log "执行 UTC 迁移逐记录语义校验"
    timeout --signal=TERM --kill-after=30s 1200s node "$NEW_RELEASE/server/scripts/materializeUtcTimeReviews.js" --verify
  fi
  AUDIT_UPLOAD_DIR="$SHARED_DIR/uploads/audit" \
    AUDIT_UPLOAD_LEGACY_ROOTS="$REPO_DIR/server/uploads:$SHARED_DIR/uploads/audit:/home/ubuntu/redsu_scoring/server/uploads" \
    node "$NEW_RELEASE/server/scripts/migrateAuditUploads.js"
  log "加密并核验历史 PDF 签名私钥"
  PDF_SIGNING_KEY_ALLOW_LEGACY_PLAINTEXT=true \
    timeout --signal=TERM --kill-after=30s 600s \
    node "$NEW_RELEASE/server/scripts/migrateAuditSigningKeys.js" --apply
fi

# 即使本次没有数据库迁移，也必须拒绝带明文或损坏签名私钥的版本上线。
timeout --signal=TERM --kill-after=10s 120s \
  node "$NEW_RELEASE/server/scripts/migrateAuditSigningKeys.js"

log "原子切换服务版本"
atomic_link "$NEW_RELEASE"
RELEASE_SWITCHED=1
reload_release "$NEW_RELEASE"
PORT="$(read_port)"
wait_for_health "$PORT"
curl --fail --silent --show-error --max-time 8 "$PUBLIC_HEALTH_URL" >/dev/null
TIME_CONFIG_JSON="$(curl --fail --silent --show-error --max-time 8 \
  -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:${PORT}/api/getTimeConfig")"
printf '%s' "$TIME_CONFIG_JSON" | node -e '
  let source = "";
  process.stdin.on("data", (chunk) => { source += chunk; });
  process.stdin.on("end", () => {
    const result = JSON.parse(source);
    const offset = Number(result.systemTimezoneOffset);
    const configVersion = Number(result.timezoneConfigVersion);
    const reviewCount = Number(result.timeReviewRecordCount);
    const verifiedCount = Number(result.timeVerifiedRecordCount);
    const unresolvedCount = Number(result.timeUnresolvedReviewCount);
    const mappedReviewCount = Number(result.timePresentationMappedReviewCount);
    const expectedCutoverStatus = unresolvedCount > 0 ? "review_pending" : "verified";
    if (result.status !== "success"
      || !Number.isInteger(offset) || offset < -12 || offset > 14
      || !Number.isInteger(configVersion) || configVersion < 1
      || typeof result.historicalTimeReviewRequired !== "boolean"
      || !Object.prototype.hasOwnProperty.call(result, "timeReviewConfigVersion")
      || result.timeCutoverStatus !== expectedCutoverStatus
      || result.timeMigrationKey !== "20260823190000"
      || !Number.isInteger(reviewCount) || reviewCount < 0
      || !Number.isInteger(verifiedCount) || verifiedCount !== reviewCount
      || !Number.isInteger(unresolvedCount) || unresolvedCount < 0 || unresolvedCount > reviewCount
      || !Number.isInteger(mappedReviewCount) || mappedReviewCount !== unresolvedCount
      || result.timePresentationMappingVersion !== "record-id+raw-value:v1"
      || result.historicalTimeReviewRequired !== (unresolvedCount > 0)) {
      throw new Error("时间配置语义健康检查未通过");
    }
  });
'

pm2 save
bash "$NEW_RELEASE/server/scripts/setupCollabSession.sh"

mkdir -p "$DEPLOY_DIR/bin"
install -m 755 "$NEW_RELEASE/server/scripts/deployEntrypoint.sh" "$DEPLOY_DIR/bin/deploy-entrypoint"

printf '%s\n' "$TARGET_SHA" > "$STATE_DIR/server_sha"
printf '%s\n' "$TARGET_SHA" > "$STATE_DIR/repository_sha"
if [[ "$MAINTENANCE_ACTIVE" -eq 1 ]]; then
  rm -f "$MAINTENANCE_FLAG"
  MAINTENANCE_ACTIVE=0
fi

mapfile -t RELEASES < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
if [[ "${#RELEASES[@]}" -gt "$RELEASE_KEEP_COUNT" ]]; then
  for release in "${RELEASES[@]:$RELEASE_KEEP_COUNT}"; do
    resolved="$(readlink -f "$release")"
    [[ "$resolved" == "$RELEASES_DIR/"* ]] || continue
    [[ "$resolved" == "$(readlink -f "$CURRENT_LINK")" ]] && continue
    git -C "$REPO_DIR" worktree remove --force "$resolved" || true
  done
fi
git -C "$REPO_DIR" worktree prune

trap - ERR
ELAPSED="$(( $(date +%s) - STARTED_AT ))"
log "部署成功，用时 ${ELAPSED}s，运行版本 $TARGET_SHA"
