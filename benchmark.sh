#!/bin/bash
# BunRadio Performance Benchmark — BunRadio vs Liquidsoap vs Icecast
# Requiere: docker, curl
# Uso: bash benchmark.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║     ⚡  RADIO STREAMING BENCHMARK                  ║"
echo "║     BunRadio vs Liquidsoap vs Icecast              ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Cleaning up containers...${NC}"
    docker rm -f bunradio-bench liquidsoap-bench icecast-bench 2>/dev/null || true
}
trap cleanup EXIT

RESULTS_FILE="/tmp/bench-results.txt"
> "$RESULTS_FILE"

measure() {
    local name=$1
    local image=$2
    local port=$3
    local extra_args=${4:-""}

    echo -e "\n${CYAN}━━━ Testing: $name ━━━${NC}"

    # Pull image
    echo -e "  Pulling $image..."
    docker pull "$image" > /dev/null 2>&1

    # Measure image size
    local image_size=$(docker image inspect "$image" --format '{{.Size}}' | awk '{printf "%.1f MB", $1/1024/1024}')
    echo -e "  Image size: ${GREEN}$image_size${NC}"

    # Start container and measure startup time
    local start_time=$(date +%s%N)
    docker run -d --name "$name-bench" -p "$port:$port" $extra_args "$image" > /dev/null 2>&1

    # Wait for container to be ready (up to 30s)
    local ready=false
    for i in $(seq 1 30); do
        if docker exec "$name-bench" curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/" 2>/dev/null | grep -q "200\|301\|302"; then
            ready=true
            break
        fi
        sleep 1
    done
    local end_time=$(date +%s%N)
    local startup_ms=$(( (end_time - start_time) / 1000000 ))

    if [ "$ready" = true ]; then
        echo -e "  Startup time: ${GREEN}${startup_ms}ms${NC}"
    else
        echo -e "  Startup time: ${YELLOW}>30s (not ready)${NC}"
        startup_ms=30000
    fi

    # Measure RAM usage (idle)
    sleep 2
    local ram_bytes=$(docker stats "$name-bench" --no-stream --format "{{.MemUsage}}" | awk '{print $1}')
    echo -e "  RAM idle: ${GREEN}$ram_bytes${NC}"

    # Measure HTTP response time (5 requests)
    if [ "$ready" = true ]; then
        local total_time=0
        local count=5
        for i in $(seq 1 $count); do
            local resp_time=$(curl -s -o /dev/null -w "%{time_total}" "http://localhost:$port/" 2>/dev/null || echo "0")
            total_time=$(echo "$total_time + $resp_time" | bc 2>/dev/null || echo "0")
        done
        local avg_time=$(echo "scale=3; $total_time / $count" | bc 2>/dev/null || echo "N/A")
        echo -e "  HTTP avg response: ${GREEN}${avg_time}s${NC}"
    else
        echo -e "  HTTP avg response: ${YELLOW}N/A${NC}"
        avg_time="N/A"
    fi

    # Save results
    echo "$name|$image_size|${startup_ms}ms|$ram_bytes|$avg_time" >> "$RESULTS_FILE"
}

# ---- Benchmarks ----

# 1. BunRadio
measure "BunRadio" \
    "ghcr.io/srsergi0/buncaster:latest" \
    "8080"

# 2. Icecast
measure "Icecast" \
    "moul/icecast" \
    "8000"

# 3. Liquidsoap (using radio-community image)
measure "Liquidsoap" \
    "savonet/liquidsoap:v2.2.5" \
    "8084" \
    "--entrypoint /bin/sh -c 'echo Done'"

# ---- Results ----
echo -e "\n${CYAN}╔══════════════════════════════════════════════════════╗"
echo "║                    📊 RESULTS                       ║"
echo "╚══════════════════════════════════════════════════════╝${NC}"
echo ""
printf "%-15s | %-12s | %-12s | %-10s | %-10s\n" "Tool" "Image Size" "Startup" "RAM Idle" "HTTP Avg"
printf "%-15s-+-%-12s-+-%-12s-+-%-10s-+-%-10s\n" "---------------" "------------" "------------" "----------" "----------"

while IFS='|' read -r name image_size startup ram http_avg; do
    printf "%-15s | %-12s | %-12s | %-10s | %-10s\n" "$name" "$image_size" "$startup" "$ram" "$http_avg"
done < "$RESULTS_FILE"

echo ""
echo -e "${GREEN}Benchmark complete.${NC}"
echo -e "Note: Results vary by hardware. Run multiple times for accuracy."
