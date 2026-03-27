# News Agent — OpenClaw-powered News Curation

Automated news curation pipeline for [silverstream.tech](https://silverstream.tech) product pages. Uses OpenClaw AI agent to search, fetch, rewrite, and output news articles as static JSON.

Powers three news pages:
- [NexusFix News](https://silverstream.tech/nexusfix/news) — C++ & FIX protocol
- [ClawNexus News](https://silverstream.tech/clawnexus/news) — OpenClaw & AI agents
- [QuantNexus News](https://silverstream.tech/quantnexus/news) — Algorithmic trading

## Prerequisites

### Required

| Dependency | Version | Install |
|-----------|---------|---------|
| Node.js | ≥22 | [nodejs.org](https://nodejs.org/) |
| OpenClaw | latest | `npm install -g openclaw` |
| LLM API key | — | Anthropic Claude key in OpenClaw config |

### Web Search Setup (choose one)

The agent needs web search to find news articles. Pick one option:

**Option A: DuckDuckGo (easiest, zero config)**

Add to `~/.openclaw/openclaw.json`:
```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "duckduckgo"
      }
    }
  }
}
```

Then restart: `openclaw gateway restart`

**Option B: Google via Gemini (best quality)**

```bash
openclaw onboard --auth-choice google-gemini-cli
```

Then install the Google Search skill:
```bash
mkdir -p ~/.openclaw/workspace/skills/google-search
# Download SKILL.md + index.js from:
# https://gist.github.com/flowforgelab/dbd5e0f65077697975e8043226761435
```

**Option C: Brave Search (requires API key)**

Get a free API key at https://api-dashboard.search.brave.com/ then:
```bash
openclaw configure --section web
# Enter your BRAVE_API_KEY when prompted
```

### Optional

| Dependency | Install | Why |
|-----------|---------|-----|
| blogwatcher | `go install github.com/Hyaxia/blogwatcher/cmd/blogwatcher@latest` | RSS feed monitoring for incremental updates |

## Quick Start

```bash
# 1. Clone the repo (if not already)
git clone https://github.com/SilverstreamsAI/ClawNexus.git
cd ClawNexus/tools/news-agent

# 2. Run the agent
./run-news-agent.sh

# 3. Review output
ls ~/.openclaw/workspace/news-output/
# nexusfix-news.json  clawnexus-news.json  quantnexus-news.json  images/

# 4. Copy to deployment target
cp ~/.openclaw/workspace/news-output/*.json /path/to/newhome-nuxt/public/news-data/
cp ~/.openclaw/workspace/news-output/images/* /path/to/newhome-nuxt/public/news-data/images/
```

## How It Works

```
web_search (keywords from config.json)
  → select top 6 articles per product (recency + relevance)
  → web_fetch each article (HTML → Markdown)
  → LLM rewrites content (200-400 words, avoids copyright)
  → downloads thumbnail images (curl)
  → outputs JSON files matching frontend schema
  → validates all fields
```

The agent runs locally via `openclaw agent --local`. All processing happens on your machine. The LLM (Claude) is used for content rewriting only.

## Files

| File | Purpose |
|------|---------|
| `config.json` | Product definitions, keywords, RSS sources, scraping settings |
| `news-agent-prompt.md` | Full agent instructions (system prompt for OpenClaw) |
| `run-news-agent.sh` | One-click runner script with preflight checks |
| `README.md` | This file |

## Configuration

Edit `config.json` to:
- Add/remove search keywords per product
- Change the number of articles per product (`scraping.articles_per_product`)
- Add RSS sources for blogwatcher integration
- Modify the tags pool per product

## Output Schema

Each JSON file follows this schema (required by the Nuxt frontend):

```json
{
  "product": "nexusfix",
  "lastUpdated": "2026-03-27T08:00:00Z",
  "articles": [
    {
      "id": "nfx-001",
      "title": "Article Title (max 110 chars)",
      "slug": "url-friendly-slug",
      "summary": "25-160 char summary for meta description",
      "content": "<p>HTML content with allowed tags only</p>",
      "source": "Original Source Name",
      "sourceUrl": "https://original-url.com/article",
      "date": "2026-03-27",
      "thumbnail": "/news-data/images/nfx-001.jpg",
      "tags": ["C++", "performance"],
      "featured": true,
      "readTimeMinutes": 3
    }
  ]
}
```

Allowed HTML in `content`: `<p>`, `<h2>`, `<h3>`, `<ul>`, `<li>`, `<strong>`, `<em>`, `<a>`, `<code>`

## Daily Automation (optional)

```bash
# Add to crontab
crontab -e

# Run every day at 08:00
0 8 * * * /path/to/ClawNexus/tools/news-agent/run-news-agent.sh >> /var/log/news-agent.log 2>&1
```

## Troubleshooting

**"openclaw is not installed"**
→ `npm install -g openclaw`

**Agent runs but no search results**
→ Check web_search provider config in `~/.openclaw/openclaw.json`

**web_fetch returns empty content**
→ Site may be JS-rendered. The agent will try next candidate automatically.

**Fewer than 6 articles for a product**
→ Normal for niche topics. The agent reports this in the validation summary.

**Images not downloading**
→ Some sites block direct image downloads. Placeholder SVGs are used as fallback.
