#!/bin/bash
# CrawDaddy Seller Watchdog - restarts seller if dead + alarm on failures
# Fixed 2026-03-30: 15-minute window for error checks (no more historical false alerts)

# QSL-7 Guard: exit immediately if seller.ts is already running (prevent duplicate spawn)
if pgrep -f "seller.ts" > /dev/null 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Seller already running (PID $(pgrep -f 'seller.ts' | head -1)) -- skipping" >> /home/ubuntu/crawdaddy-security/logs/watchdog.log
    exit 0
fi

LOG="/home/ubuntu/crawdaddy-security/logs/watchdog.log"
ALARM="/home/ubuntu/crawdaddy-security/scripts/alarm.sh"
SELLER_LOG="/home/ubuntu/.openclaw/virtuals-acp/logs/seller.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERT_STATE="/tmp/.watchdog-alerted"

if ! pgrep -f "seller.ts" > /dev/null; then
    echo "[$TIMESTAMP] Seller DOWN - restarting..." >> $LOG
    $ALARM CRITICAL "CrawDaddy seller is DOWN. PID missing."
    cd /home/ubuntu/.openclaw/virtuals-acp
    nohup npx tsx src/seller/runtime/seller.ts >> logs/seller.log 2>&1 &
    sleep 5
    if pgrep -f "seller.ts" > /dev/null; then
        echo "[$TIMESTAMP] Seller restarted OK" >> $LOG
        $ALARM WARNING "CrawDaddy seller restarted successfully"
    else
        echo "[$TIMESTAMP] Seller restart FAILED" >> $LOG
        $ALARM CRITICAL "CrawDaddy seller restart FAILED"
    fi
else
    echo "[$TIMESTAMP] Seller OK" >> $LOG
fi

# Check for issues in RECENT logs only (last 100 lines, not full history)
if [ -f "$SELLER_LOG" ]; then
    RECENT=$(tail -100 "$SELLER_LOG")

    # Job rejections in recent lines
    REJECTIONS=$(echo "$RECENT" | grep -c "accept=false" || true)
    if [ "$REJECTIONS" -gt 0 ] 2>/dev/null; then
        LAST_REJECTION=$(echo "$RECENT" | grep "accept=false" | tail -1)
        # Only alert once per hour via state file
        SHOULD_ALERT=false
        if [ ! -f "${ALERT_STATE}.rejections" ]; then
            SHOULD_ALERT=true
        elif [ -n "$(find "${ALERT_STATE}.rejections" -mmin +60 2>/dev/null)" ]; then
            SHOULD_ALERT=true
        fi
        if [ "$SHOULD_ALERT" = "true" ]; then
            $ALARM WARNING "CrawDaddy rejected $REJECTIONS job(s) recently. Last: $LAST_REJECTION"
            touch "${ALERT_STATE}.rejections"
        fi
        echo "[$TIMESTAMP] $REJECTIONS rejection(s) in recent logs" >> $LOG
    fi

    # TransformErrors in recent lines
    TRANSFORM_ERRORS=$(echo "$RECENT" | grep -c "TransformError" || true)
    if [ "$TRANSFORM_ERRORS" -gt 0 ] 2>/dev/null; then
        SHOULD_ALERT=false
        if [ ! -f "${ALERT_STATE}.transform" ]; then
            SHOULD_ALERT=true
        elif [ -n "$(find "${ALERT_STATE}.transform" -mmin +60 2>/dev/null)" ]; then
            SHOULD_ALERT=true
        fi
        if [ "$SHOULD_ALERT" = "true" ]; then
            $ALARM CRITICAL "CrawDaddy has $TRANSFORM_ERRORS TransformError(s) recently"
            touch "${ALERT_STATE}.transform"
        fi
        echo "[$TIMESTAMP] ALERT: $TRANSFORM_ERRORS TransformError(s) in recent logs" >> $LOG
    fi
fi
