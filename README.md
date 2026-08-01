# Claude Counter

A minimal browser extension that shows token count, cache timer, and dynamic multi-model usage bars on claude.ai.

### Existing Conversation
![Claude Counter existing chat screenshot](./screenshot.png)

### New Chat (Multi-Model Comparison)
![Claude Counter new chat multi-model bars screenshot](./screenshot2.png)

## Features

- **Token count** — Approximate token count for the current conversation, with a mini progress bar against the 200k context limit
- **Cache timer** — Countdown showing how long the conversation remains cached (cheaper to continue)
- **Multi-Model Usage Comparison (New Chat)** — On new conversations, view individual 5-hour session usage bars for **Haiku**, **Sonnet**, and **Opus** side-by-side, scaled by relative model consumption rates (Opus 2.0x, Sonnet 1.0x, Haiku 0.33x). Includes a baseline 5-hour rolling window marker line on Sonnet.
- **Dynamic Session & Weekly Bars (Existing Chat)** — Once a model is selected, the bar row dynamically simplifies to display only the active model's 5-hour usage bar alongside the weekly 7-day usage bar at a prominent 200px width each. Both bars include live `"· resets in <duration>"` countdown timers and accurate vertical white window progress markers.
- **Unrounded Precision** — Uses Claude's `/usage` plus live SSE `message_limit` data; the SSE provides exact, unrounded utilization fractions, making progress bars more accurate than the rounded percentages shown on Claude's native `/usage` page.

## Installation

**Chrome / Edge / Chromium**

1. Download [`claude-counter-0.4.2.zip`](../../releases/download/v0.4.2/claude-counter-0.4.2.zip)
2. Go to `chrome://extensions` and enable **Developer mode**
3. Drag and drop the zip onto the page

**Firefox**

1. Download [`claude-counter-0.4.2.xpi`](../../releases/download/v0.4.2/claude-counter-0.4.2.xpi)
2. Drag it into any Firefox window and click **Add**

**Userscript**

1. Install the userscript from [`claude-counter.user.js`](./userscript/claude-counter.user.js)

## How it works

- Intercepts Claude's API responses to read conversation data and usage info
- Uses a vendored tokenizer (`o200k_base`) for approximate token counting
- Uses Claude’s `/usage` plus live SSE `message_limit` data; the SSE provides exact, unrounded utilization fractions, so the progress bars are more accurate than the rounded percentages shown on Claude’s native `/usage` page
- Applies relative model usage multipliers (`Haiku: 0.33x`, `Sonnet: 1.0x`, `Opus: 2.0x`) so 5-hour session usage bars accurately reflect each model's relative consumption rate
- Dynamically switches between a multi-model comparison view on new chats and an active-model + weekly view on existing conversations
- Watches for DOM changes to inject UI elements as you navigate

## Privacy

- All data stays local — no external servers, no tracking
- Reads your `lastActiveOrg` cookie to query Claude's `/usage` endpoint
- Makes requests only to `claude.ai`

## Credits

- Token counting via [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT)
- Inspired by [Claude Usage Tracker](https://github.com/lugia19/Claude-Usage-Extension) by lugia19

## License

MIT
