#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# News Agent Runner
# Runs the OpenClaw news agent to generate
# news JSON files for stratcraft.ai
# ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$HOME/.openclaw/workspace/news-output"
PROMPT_FILE="$SCRIPT_DIR/news-agent-prompt.md"
CONFIG_FILE="$SCRIPT_DIR/config.json"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Preflight checks ──
echo -e "${YELLOW}[preflight]${NC} Checking requirements..."

if ! command -v openclaw &>/dev/null; then
    echo -e "${RED}[error]${NC} openclaw is not installed. Run: npm install -g openclaw"
    exit 1
fi

if [ ! -f "$PROMPT_FILE" ]; then
    echo -e "${RED}[error]${NC} Prompt file not found: $PROMPT_FILE"
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}[error]${NC} Config file not found: $CONFIG_FILE"
    exit 1
fi

echo -e "${GREEN}[preflight]${NC} All checks passed."

# ── Prepare output directory ──
mkdir -p "$OUTPUT_DIR/images"
echo -e "${GREEN}[setup]${NC} Output directory: $OUTPUT_DIR"

# ── Copy config to workspace so agent can read it ──
cp "$CONFIG_FILE" "$OUTPUT_DIR/config.json"

# ── Run the agent ──
echo -e "${YELLOW}[agent]${NC} Starting OpenClaw news agent..."
echo -e "${YELLOW}[agent]${NC} This may take 5-10 minutes depending on network and LLM speed."
echo ""

PROMPT_CONTENT=$(cat "$PROMPT_FILE")

openclaw agent --local --message "
You are a news curation agent. Read the config file at $OUTPUT_DIR/config.json and follow the instructions below to generate news JSON files.

$PROMPT_CONTENT
" 2>&1 | tee "$OUTPUT_DIR/agent-run.log"

# ── Post-run check ──
echo ""
echo -e "${YELLOW}[check]${NC} Checking output files..."

MISSING=0
for f in nexusfix-news.json clawnexus-news.json quantnexus-news.json; do
    if [ -f "$OUTPUT_DIR/$f" ]; then
        ARTICLES=$(python3 -c "import json; d=json.load(open('$OUTPUT_DIR/$f')); print(len(d.get('articles',[])))" 2>/dev/null || echo "?")
        echo -e "${GREEN}  [ok]${NC} $f — $ARTICLES articles"
    else
        echo -e "${RED}  [missing]${NC} $f"
        MISSING=$((MISSING + 1))
    fi
done

if [ "$MISSING" -gt 0 ]; then
    echo -e "${RED}[warn]${NC} $MISSING file(s) missing. Check $OUTPUT_DIR/agent-run.log for errors."
    exit 1
fi

echo ""
echo -e "${GREEN}[done]${NC} News files generated in: $OUTPUT_DIR"
echo ""
echo "Next steps:"
echo "  1. Review the JSON files in $OUTPUT_DIR"
echo "  2. Copy to your deployment target:"
echo "     cp $OUTPUT_DIR/*.json <nonassa>/newhome-nuxt/public/news-data/"
echo "     cp $OUTPUT_DIR/images/* <nonassa>/newhome-nuxt/public/news-data/images/"
echo "  3. Deploy: deploy-wordpress.sh --production"
