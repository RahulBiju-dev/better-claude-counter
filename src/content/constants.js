(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"]',
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		CONTEXT_LIMIT_TOKENS: 200000,

		// --- Usage freshness ---
		// The SSE `message_limit` event only arrives on some completions, so it can
		// never be the only in-session update path or the bars freeze mid-session.
		// Everything below exists to keep /usage the authoritative, current number.
		//
		// Periodic re-fetch while the tab is visible.
		USAGE_REFRESH_MS: 5 * 60 * 1000,
		// Hard floor between /usage requests, whatever asks for one. Deliberately
		// smaller than the gap between POST_GENERATION_DELAYS_MS so both of those
		// checks still land - it exists to coalesce simultaneous triggers (the SSE
		// message_limit and the stream ending fire together), not to throttle them.
		USAGE_MIN_INTERVAL_MS: 3 * 1000,
		// The server's counter lags the end of the stream, so re-check twice.
		POST_GENERATION_DELAYS_MS: Object.freeze([1500, 8000]),
		// On becoming visible again, only re-fetch if the data is at least this old.
		USAGE_STALE_ON_VISIBLE_MS: 60 * 1000,

		PLAN_STORAGE_KEY: 'cc:plan:v1'
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#d97757',
		PROGRESS_FILL_LIGHT: '#c96442',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5'
	});

	CC.MODELS = Object.freeze(['haiku', 'sonnet', 'opus']);

	CC.MODEL_NAMES = Object.freeze({
		haiku: 'Haiku',
		sonnet: 'Sonnet',
		opus: 'Opus',
		fable: 'Fable'
	});

	CC.MODEL_WIDTHS = Object.freeze({
		haiku: '96px',
		sonnet: '96px',
		opus: '96px'
	});

	/**
	 * New-chat screen only.
	 *
	 * Anthropic's /usage reports ONE shared five_hour utilization for all models,
	 * so a true per-model split does not exist. On the new-chat screen we still
	 * want a multimodal at-a-glance preview, so Sonnet shows the real number and
	 * Haiku/Opus are scaled by their relative burn rate. This is a deliberate
	 * approximation, not a bug - do not "fix" it.
	 *
	 * Inside a conversation these are NOT applied: the row switches to a single
	 * unscaled 5h bar (see CC.WINDOWS) so the number on screen is exactly the
	 * number the API returned.
	 */
	CC.MODEL_USAGE_MULTIPLIERS = Object.freeze({
		haiku: 1 / 3,
		sonnet: 1.0,
		opus: 2.0
	});

	/**
	 * The real rate-limit windows, as returned by /usage. Rendered inside a
	 * conversation, one bar each, every value straight from the API.
	 */
	CC.WINDOWS = Object.freeze([
		Object.freeze({ key: 'five_hour', label: '5h', hours: 5 }),
		Object.freeze({ key: 'seven_day', label: 'Weekly', hours: 7 * 24 }),
		Object.freeze({ key: 'seven_day_opus', label: 'Weekly Opus', hours: 7 * 24 })
	]);

	CC.WINDOW_WIDTHS = Object.freeze({
		five_hour: '200px',
		seven_day: '200px',
		seven_day_opus: '200px'
	});

	// 'auto' is not a plan; it is the sentinel meaning "use whatever we detected".
	CC.PLAN_AUTO = 'auto';

	CC.PLANS = Object.freeze(['free', 'pro', 'max5', 'max20', 'team', 'enterprise']);

	CC.PLAN_NAMES = Object.freeze({
		free: 'Free',
		pro: 'Pro',
		max5: 'Max 5x',
		max20: 'Max 20x',
		team: 'Team',
		enterprise: 'Enterprise'
	});

	CC.DEFAULT_PLAN = 'pro';

	/**
	 * Which bars a plan has.
	 *   windows - rate-limit windows shown inside a conversation.
	 *   models  - model bars shown on the new-chat screen.
	 *
	 * This only ever *fills gaps*. A window the API actually returned is always
	 * rendered even if the spec says the plan shouldn't have it, so a wrong plan
	 * can't erase a real bar. Likewise only `free` narrows the model list.
	 */
	CC.PLAN_SPECS = Object.freeze({
		free: Object.freeze({
			windows: Object.freeze(['five_hour']),
			models: Object.freeze(['sonnet'])
		}),
		pro: Object.freeze({
			windows: Object.freeze(['five_hour', 'seven_day']),
			models: Object.freeze(['haiku', 'sonnet', 'opus'])
		}),
		max5: Object.freeze({
			windows: Object.freeze(['five_hour', 'seven_day', 'seven_day_opus']),
			models: Object.freeze(['haiku', 'sonnet', 'opus'])
		}),
		max20: Object.freeze({
			windows: Object.freeze(['five_hour', 'seven_day', 'seven_day_opus']),
			models: Object.freeze(['haiku', 'sonnet', 'opus'])
		}),
		team: Object.freeze({
			windows: Object.freeze(['five_hour', 'seven_day']),
			models: Object.freeze(['haiku', 'sonnet', 'opus'])
		}),
		enterprise: Object.freeze({
			windows: Object.freeze(['five_hour', 'seven_day']),
			models: Object.freeze(['haiku', 'sonnet', 'opus'])
		})
	});
})();

