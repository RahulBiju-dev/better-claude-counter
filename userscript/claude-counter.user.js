// ==UserScript==
// @name         AI Usage Counter
// @namespace    https://github.com/she-llac/claude-counter
// @version      0.6.0-userscript
// @description  Token count, cache timer and usage bars on claude.ai, plus estimated 5-hour and weekly usage bars on gemini.google.com.
// @match        https://claude.ai/*
// @match        https://gemini.google.com/*
// @run-at       document-start
// @grant        none
// @require      https://unpkg.com/gpt-tokenizer@2.9.0/dist/o200k_base.js
// ==/UserScript==

// --- src/shared/store.js ---------------------------------------------------
// Shared by both site modules, so deliberately not behind a hostname guard.
(() => {
	'use strict';
	if (globalThis.CCStore) return;

	function getStorageArea() {
		try {
			return globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local || null;
		} catch {
			return null;
		}
	}

	/**
	 * chrome.storage.local when running as an extension, localStorage otherwise
	 * (this userscript build has no extension APIs). Both are local-only.
	 */
	globalThis.CCStore = {
		async get(key) {
			const area = getStorageArea();
			if (area) {
				try {
					const result = await new Promise((resolve, reject) => {
						const maybePromise = area.get(key, (items) => {
							const err = globalThis.chrome?.runtime?.lastError;
							if (err) reject(new Error(err.message));
							else resolve(items);
						});
						// Firefox returns a promise instead of using the callback.
						if (maybePromise && typeof maybePromise.then === 'function') {
							maybePromise.then(resolve, reject);
						}
					});
					return result?.[key] ?? null;
				} catch {
					// fall through to localStorage
				}
			}
			try {
				const raw = localStorage.getItem(key);
				return raw ? JSON.parse(raw) : null;
			} catch {
				return null;
			}
		},

		async set(key, value) {
			const area = getStorageArea();
			if (area) {
				try {
					await new Promise((resolve, reject) => {
						const maybePromise = area.set({ [key]: value }, () => {
							const err = globalThis.chrome?.runtime?.lastError;
							if (err) reject(new Error(err.message));
							else resolve();
						});
						if (maybePromise && typeof maybePromise.then === 'function') {
							maybePromise.then(resolve, reject);
						}
					});
					return;
				} catch {
					// fall through to localStorage
				}
			}
			try {
				localStorage.setItem(key, JSON.stringify(value));
			} catch {
				// storage full or blocked; callers degrade to in-memory
			}
		}
	};
})();

(() => {
	'use strict';
	if (location.hostname !== 'claude.ai') return;

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__ccUserscriptWrapped) return;
	CC.__ccUserscriptWrapped = true;

	CC._ccInternal = CC._ccInternal || {};
	CC._ccInternal.onGenerationStart = CC._ccInternal.onGenerationStart || (() => {});
	CC._ccInternal.onGenerationEnd = CC._ccInternal.onGenerationEnd || (() => {});
	CC._ccInternal.onConversationData = CC._ccInternal.onConversationData || (() => {});
	CC._ccInternal.onMessageLimit = CC._ccInternal.onMessageLimit || (() => {});
	CC._ccInternal.onUrlChange = CC._ccInternal.onUrlChange || (() => {});

	const originalFetch = window.fetch ? window.fetch.bind(window) : null;
	CC._ccInternal.originalFetch = originalFetch;

	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	const dispatchUrlChange = () => {
		try {
			CC._ccInternal.onUrlChange();
		} catch {
			// ignore
		}
	};

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		dispatchUrlChange();
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		dispatchUrlChange();
		return result;
	};

	window.addEventListener('popstate', dispatchUrlChange);

	if (originalFetch) {
		window.fetch = async (...args) => {
			const url = toAbsoluteUrl(args[0]);
			const opts = args[1] || {};
			const method = (opts.method || 'GET').toUpperCase();

			if (url && method === 'POST' && (url.includes('/completion') || url.includes('/retry_completion'))) {
				try {
					CC._ccInternal.onGenerationStart();
				} catch {
					// ignore
				}
			}

			const response = await originalFetch(...args);
			const contentType = response.headers.get('content-type') || '';
			if (contentType.includes('event-stream')) {
				handleEventStream(response);
			}

			if (url && url.includes('/chat_conversations/') && url.includes('tree=')) {
				const meta = getConversationMeta(url);
				if (meta) {
					handleConversationResponse(meta, response);
				}
			}

			return response;
		};
	}

	function toAbsoluteUrl(input) {
		if (typeof input === 'string') {
			if (input.startsWith('/')) return `https://claude.ai${input}`;
			return input;
		}
		if (input instanceof URL) return input.href;
		if (input instanceof Request) return input.url;
		return '';
	}

	function getConversationMeta(url) {
		const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return match ? { orgId: match[1], conversationId: match[2] } : null;
	}

	async function handleConversationResponse({ orgId, conversationId }, response) {
		try {
			const cloned = response.clone();
			const data = await cloned.json();
			CC._ccInternal.onConversationData({ orgId, conversationId, data });
		} catch {
			// ignore parse failures
		}
	}

	async function handleEventStream(response) {
		let started = false;
		try {
			const cloned = response.clone();
			const reader = cloned.body?.getReader?.();
			if (!reader) return;
			started = true;
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r\n|\r|\n/);
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					try {
						const json = JSON.parse(raw);
						if (json?.type === 'message_limit' && json.message_limit) {
							CC._ccInternal.onMessageLimit(json.message_limit);
						}
					} catch {
						// ignore
					}
				}
			}
		} catch {
			// best-effort; do not break claude.ai
		} finally {
			// The stream ending is the reliable "a message just completed" signal.
			// message_limit only rides along on some completions, so this is what
			// drives the post-generation /usage re-fetch.
			if (started) {
				try {
					CC._ccInternal.onGenerationEnd();
				} catch {
					// ignore
				}
			}
		}
	}
})();

(() => {
	'use strict';
	if (location.hostname !== 'claude.ai') return;

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


// --- src/content/plan.js ---------------------------------------------------
// Same logic as the extension build; the only difference is that the account
// endpoints are fetched directly here instead of through the injected bridge.
(() => {
	'use strict';
	if (location.hostname !== 'claude.ai') return;

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const store = globalThis.CCStore;

	function debugEnabled() {
		try {
			return localStorage.getItem('cc:debug') === '1';
		} catch {
			return false;
		}
	}

	function debug(...args) {
		if (debugEnabled()) console.log('[cc:plan]', ...args);
	}

	/**
	 * Anthropic's tier strings are not documented and have changed shape before
	 * (`default_pro`, `claude_max_20x`, ...), so match loosely and order the tests
	 * most-specific first. Unknown strings return null rather than guessing.
	 */
	function planFromTierString(raw) {
		if (typeof raw !== 'string' || !raw) return null;
		const s = raw.toLowerCase();
		if (/enterprise/.test(s)) return 'enterprise';
		if (/team/.test(s)) return 'team';
		if (/(max.*20|20\s*x|max_20)/.test(s)) return 'max20';
		if (/(max.*5|5\s*x|max_5)/.test(s)) return 'max5';
		if (/max/.test(s)) return 'max5';
		if (/pro/.test(s)) return 'pro';
		if (/free/.test(s)) return 'free';
		return null;
	}

	function planFromCapabilities(caps) {
		if (!Array.isArray(caps)) return null;
		const joined = caps.filter((c) => typeof c === 'string').join(',').toLowerCase();
		if (!joined) return null;
		if (/enterprise/.test(joined)) return 'enterprise';
		if (/team/.test(joined)) return 'team';
		// Capabilities carry no 5x/20x distinction; max5 is the conservative read.
		if (/claude_max|\bmax\b/.test(joined)) return 'max5';
		if (/claude_pro|\bpro\b/.test(joined)) return 'pro';
		// A logged-in org that advertises chat but neither pro nor max is free.
		if (/chat/.test(joined)) return 'free';
		return null;
	}

	function collectOrgs(account) {
		const orgs = [];
		const push = (o) => {
			if (o && typeof o === 'object') orgs.push(o);
		};

		const organizations = account?.organizations;
		if (Array.isArray(organizations)) organizations.forEach(push);

		const bootstrap = account?.bootstrap;
		if (bootstrap && typeof bootstrap === 'object') {
			push(bootstrap.organization);
			push(bootstrap.account?.organization);
			const memberships = bootstrap.account?.memberships || bootstrap.memberships;
			if (Array.isArray(memberships)) {
				for (const m of memberships) push(m?.organization);
			}
		}

		return orgs;
	}

	function pickOrg(orgs, orgId) {
		if (!orgs.length) return null;
		if (orgId) {
			const match = orgs.find((o) => o?.uuid === orgId || o?.id === orgId);
			if (match) return match;
		}
		return orgs[0];
	}

	function planFromOrg(org) {
		if (!org || typeof org !== 'object') return null;

		const tierCandidates = [
			org.rate_limit_tier,
			org.settings?.rate_limit_tier,
			org.billing_type,
			org.subscription_tier,
			org.plan,
			org.plan_type,
			org.tier
		];
		for (const cand of tierCandidates) {
			const p = planFromTierString(cand);
			if (p) {
				debug('plan from tier string', cand, '->', p);
				return p;
			}
		}

		const p = planFromCapabilities(org.capabilities);
		if (p) debug('plan from capabilities', org.capabilities, '->', p);
		return p;
	}

	function planFromUsageShape(raw) {
		if (!raw || typeof raw !== 'object') return null;
		const hasOpusWeek = !!(raw.seven_day_opus || raw.seven_day?.opus);
		const hasWeek = !!raw.seven_day;
		const hasFiveHour = !!raw.five_hour;

		// A separate weekly Opus window only exists on the Max tiers.
		if (hasOpusWeek) return 'max5';
		// A 5-hour window with no weekly window at all is the Free shape.
		if (hasFiveHour && !hasWeek) return 'free';
		return null;
	}

	/** Last resort: the account menu usually names the plan in plain text. */
	function planFromDom() {
		let text = '';
		try {
			const candidates = document.querySelectorAll(
				'[data-testid="user-menu-button"], [aria-label*="profile" i], [aria-label*="account" i], nav button'
			);
			for (const el of candidates) {
				text += ` ${el.textContent || ''}`;
			}
		} catch {
			return null;
		}
		if (!text.trim()) return null;
		const s = text.toLowerCase();
		if (/max\s*20/.test(s)) return 'max20';
		if (/max\s*5/.test(s)) return 'max5';
		if (/\bmax\b/.test(s)) return 'max5';
		if (/\bpro\b/.test(s)) return 'pro';
		return null;
	}

	async function fetchAccount() {
		const originalFetch = CC._ccInternal?.originalFetch || (window.fetch ? window.fetch.bind(window) : null);
		if (!originalFetch) return null;

		// Fetched independently so one 404 doesn't sink the other.
		const getJson = async (url) => {
			try {
				const res = await originalFetch(url, { method: 'GET', credentials: 'include' });
				if (!res.ok) return null;
				return await res.json();
			} catch {
				return null;
			}
		};

		const [bootstrap, organizations] = await Promise.all([
			getJson('https://claude.ai/api/bootstrap'),
			getJson('https://claude.ai/api/organizations')
		]);
		return { bootstrap, organizations };
	}

	class PlanResolver {
		constructor() {
			this.override = null; // a CC.PLANS entry, or null for auto
			this.detected = null; // last successful auto-detection
			this.loaded = false;
			this._saveTimer = null;
		}

		async load() {
			try {
				const raw = await store?.get(CC.CONST.PLAN_STORAGE_KEY);
				if (raw && typeof raw === 'object') {
					if (CC.PLANS.includes(raw.override)) this.override = raw.override;
					if (CC.PLANS.includes(raw.detected)) this.detected = raw.detected;
				}
			} catch {
				// storage unavailable; stay on defaults
			}
			this.loaded = true;
			return this.get();
		}

		_scheduleSave() {
			if (this._saveTimer) clearTimeout(this._saveTimer);
			this._saveTimer = setTimeout(() => {
				this._saveTimer = null;
				store?.set(CC.CONST.PLAN_STORAGE_KEY, {
					override: this.override,
					detected: this.detected
				});
			}, 250);
		}

		/** @returns {{plan: string, source: 'manual'|'auto'|'default', detected: string|null}} */
		get() {
			if (this.override) return { plan: this.override, source: 'manual', detected: this.detected };
			if (this.detected) return { plan: this.detected, source: 'auto', detected: this.detected };
			return { plan: CC.DEFAULT_PLAN, source: 'default', detected: null };
		}

		spec() {
			return CC.PLAN_SPECS[this.get().plan] || CC.PLAN_SPECS[CC.DEFAULT_PLAN];
		}

		setOverride(plan) {
			this.override = CC.PLANS.includes(plan) ? plan : null;
			this._scheduleSave();
			return this.get();
		}

		/** Cycle auto -> free -> pro -> max5 -> max20 -> team -> enterprise -> auto. */
		cycle() {
			const order = [CC.PLAN_AUTO, ...CC.PLANS];
			const current = this.override || CC.PLAN_AUTO;
			const next = order[(order.indexOf(current) + 1) % order.length];
			return this.setOverride(next === CC.PLAN_AUTO ? null : next);
		}

		_setDetected(plan) {
			if (!plan || plan === this.detected) return false;
			this.detected = plan;
			this._scheduleSave();
			debug('detected plan ->', plan);
			return true;
		}

		async detect({ orgId } = {}) {
			let account = null;
			try {
				account = await fetchAccount();
			} catch (e) {
				debug('account fetch failed', e?.message || e);
				return false;
			}
			if (debugEnabled()) debug('raw account payload', account);

			const org = pickOrg(collectOrgs(account), orgId);
			if (debugEnabled()) debug('selected org', org);

			return this._setDetected(planFromOrg(org) || planFromDom());
		}

		observeUsageShape(raw) {
			if (debugEnabled()) debug('raw usage payload', raw);
			const shape = planFromUsageShape(raw);
			if (!shape) return false;

			// The shape read can't tell 5x from 20x, so don't clobber a detected 20x.
			if (shape === 'max5' && this.detected === 'max20') return false;
			// Nor should it demote a named tier to free on a transient partial response.
			if (shape === 'free' && this.detected && this.detected !== 'free') return false;

			return this._setDetected(shape);
		}
	}

	CC.plan = new PlanResolver();
	CC.planHelpers = { planFromTierString, planFromCapabilities, planFromUsageShape };
})();


(() => {
	'use strict';
	if (location.hostname !== 'claude.ai') return;

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const ROOT_MESSAGE_ID = '00000000-0000-4000-8000-000000000000';

	function stableStringify(value) {
		const seen = new WeakSet();

		const normalize = (v) => {
			if (v === null || typeof v !== 'object') return v;
			if (seen.has(v)) return '[Circular]';
			seen.add(v);

			if (Array.isArray(v)) return v.map(normalize);

			const out = {};
			for (const key of Object.keys(v).sort()) {
				out[key] = normalize(v[key]);
			}
			return out;
		};

		try {
			return JSON.stringify(normalize(value));
		} catch {
			return '';
		}
	}

	function getTokenizer() {
		return globalThis.GPTTokenizer_o200k_base || null;
	}

	function countTokens(text) {
		if (!text) return 0;
		const tokenizer = getTokenizer();
		if (!tokenizer?.countTokens) return 0;
		try {
			return tokenizer.countTokens(text);
		} catch {
			return 0;
		}
	}

	function buildTrunk(conversation) {
		const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
		const byId = new Map();
		for (const msg of messages) {
			if (msg?.uuid) byId.set(msg.uuid, msg);
		}

		const leaf = conversation?.current_leaf_message_uuid;
		if (!leaf) return [];

		const trunk = [];
		let currentId = leaf;
		while (currentId && currentId !== ROOT_MESSAGE_ID) {
			const msg = byId.get(currentId);
			if (!msg) break;
			trunk.push(msg);
			currentId = msg.parent_message_uuid;
		}

		trunk.reverse();
		return trunk;
	}

	function isCountableContentItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (typeof item.type !== 'string') return false;
		if (item.type === 'thinking' || item.type === 'redacted_thinking') return false;
		if (item.type === 'image' || item.type === 'document') return false;
		return true;
	}

	function stringifyCountableContentItem(item) {
		if (!isCountableContentItem(item)) return '';

		// Common fast-path for text blocks.
		if (item.type === 'text' && typeof item.text === 'string') return item.text;

		// Tool blocks: include observable payloads deterministically, but exclude "thinking".
		if (item.type === 'tool_use') {
			const minimal = {
				id: item.id,
				name: item.name,
				input: item.input
			};
			return stableStringify(minimal);
		}

		if (item.type === 'tool_result') {
			const minimal = {
				tool_use_id: item.tool_use_id,
				is_error: item.is_error,
				content: item.content
			};
			return stableStringify(minimal);
		}

		// Fallback: keep only known-ish textual fields to avoid pulling in huge binary-ish blobs.
		const minimal = {};
		if (typeof item.text === 'string') minimal.text = item.text;
		if (typeof item.title === 'string') minimal.title = item.title;
		if (typeof item.url === 'string') minimal.url = item.url;
		if (typeof item.content === 'string') minimal.content = item.content;
		if (Array.isArray(item.content)) minimal.content = item.content;
		if (Object.keys(minimal).length === 0) return '';
		return stableStringify(minimal);
	}

	function stringifyMessageCountables(message) {
		const parts = [];

		// Message content blocks (primary source for tools, text, etc).
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			const s = stringifyCountableContentItem(item);
			if (s) parts.push(s);
		}

		// Attachment extracted content (observable, already text).
		const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
		for (const a of attachments) {
			if (typeof a?.extracted_content === 'string' && a.extracted_content) {
				parts.push(a.extracted_content);
			}
		}

		return parts.join('\n');
	}

	async function hashString(str) {
		if (!crypto?.subtle?.digest) return null;
		try {
			const data = new TextEncoder().encode(str);
			const buffer = await crypto.subtle.digest('SHA-256', data);
			const bytes = new Uint8Array(buffer);
			// Use first 8 bytes (64 bits) for fingerprint
			return Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
		} catch {
			return null;
		}
	}

	async function fingerprint(text) {
		if (!text) return null;
		const hash = await hashString(text);
		if (!hash) return null;
		return `${text.length}:${hash}`;
	}

	class TokenCache {
		constructor() {
			this._byMessageId = new Map(); // uuid -> { fp, tokens }
		}

		async getMessageTokens(messageId, messageText) {
			const fp = await fingerprint(messageText);
			if (!fp) return countTokens(messageText);
			const cached = this._byMessageId.get(messageId);
			if (cached && cached.fp === fp) return cached.tokens;

			const tokens = countTokens(messageText);
			this._byMessageId.set(messageId, { fp, tokens });
			return tokens;
		}

		pruneToMessageIds(keepIds) {
			const keep = new Set(keepIds);
			for (const id of this._byMessageId.keys()) {
				if (!keep.has(id)) this._byMessageId.delete(id);
			}
		}
	}

	const tokenCache = new TokenCache();

	async function computeConversationMetrics(conversation) {
		const trunk = buildTrunk(conversation);
		const trunkIds = trunk.map((m) => m.uuid).filter(Boolean);
		tokenCache.pruneToMessageIds(trunkIds);

		let totalTokens = 0;
		let lastAssistantMs = null;

		for (const msg of trunk) {
			if (msg?.sender === 'assistant' && msg?.created_at) {
				const msgMs = Date.parse(msg.created_at);
				if (!lastAssistantMs || msgMs > lastAssistantMs) {
					lastAssistantMs = msgMs;
				}
			}

			const msgText = stringifyMessageCountables(msg);
			const msgTokens = msg?.uuid ? await tokenCache.getMessageTokens(msg.uuid, msgText) : countTokens(msgText);
			totalTokens += msgTokens;
		}
		const cachedUntil = lastAssistantMs ? lastAssistantMs + CC.CONST.CACHE_WINDOW_MS : null;

		return {
			trunkMessageCount: trunk.length,
			totalTokens,
			lastAssistantMs,
			cachedUntil
		};
	}

	CC.tokens = { computeConversationMetrics };
})();


(() => {
	'use strict';
	if (location.hostname !== 'claude.ai') return;

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		// <= 0: reset time reached
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		// < 1 min: show seconds
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		// < 1 hour: show minutes
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		// < 1 day: show hours
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		// >= 1 day: show days
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'bg-bg-500 text-text-000 cc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	class CounterUI {
		constructor({ onUsageRefresh, onPlanCycle } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;
			this.onPlanCycle = onPlanCycle || null;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.cachedDisplay = null;
			this.lengthBar = null;
			this.lengthTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;

			this.usageLine = null;
			// New-chat screen: the scaled multimodal preview (Sonnet exact, others
			// scaled by CC.MODEL_USAGE_MULTIPLIERS).
			this.modelGroups = {};
			// Inside a conversation: the real rate-limit windows, unscaled.
			this.windowGroups = {};
			this.fiveHourIndicator = null;
			this.planButton = null;
			this.plan = null;
			this.isNewChat = false;
			this.activeModel = 'sonnet';
			this.refreshingUsage = false;

			this.domObserver = null;
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, markerColor } = this.getProgressChrome();

			const applyBarChrome = (bar, { fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.lengthBar, { fillWarn: fillColor });
			for (const group of [...Object.values(this.modelGroups || {}), ...Object.values(this.windowGroups || {})]) {
				applyBarChrome(group?.bar, { fillWarn: CC.COLORS.RED_WARNING });
			}
			if (this.planButton) {
				this.planButton.style.setProperty('--cc-stroke', strokeColor);
			}
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null; // reference to inner time span

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly)
			this._initUsageLine();

			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			// Track pending reattach attempts independently
			let usageReattachPending = false;
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className =
				'text-text-400 text-[11px] cc-usageRow cc-hidden flex flex-row items-center gap-4 w-full flex-nowrap';

			// A bar group: label + track + fill + window-progress marker. Used for
			// both the new-chat model preview and the in-conversation windows, which
			// differ only in label, width and whether the value is scaled.
			const buildGroup = ({ modifier, width, labelFirst = true }) => {
				const usageSpan = document.createElement('span');
				usageSpan.className = 'cc-usageText';

				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--usage';
				bar.style.width = width;
				bar.style.flex = `0 0 ${width}`;

				const barFill = document.createElement('div');
				barFill.className = 'cc-bar__fill';
				const marker = document.createElement('div');
				marker.className = 'cc-bar__marker cc-hidden';
				marker.style.left = '0%';
				bar.appendChild(barFill);
				bar.appendChild(marker);

				const group = document.createElement('div');
				group.className = `cc-usageGroup ${modifier}`;
				if (labelFirst) {
					group.appendChild(usageSpan);
					group.appendChild(bar);
				} else {
					group.appendChild(bar);
					group.appendChild(usageSpan);
				}

				this.usageLine.appendChild(group);
				return { group, usageSpan, bar, barFill, marker, resetMs: null, windowStartMs: null };
			};

			this.modelGroups = {};
			for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
				this.modelGroups[m] = buildGroup({
					modifier: 'cc-usageGroup--model',
					width: CC.MODEL_WIDTHS?.[m] || '96px'
				});
			}

			this.windowGroups = {};
			for (const win of (CC.WINDOWS || [])) {
				this.windowGroups[win.key] = buildGroup({
					modifier: `cc-usageGroup--window cc-usageGroup--${win.key}`,
					width: CC.WINDOW_WIDTHS?.[win.key] || '200px',
					// Weekly bars read bar-then-label, matching the previous layout.
					labelFirst: win.key === 'five_hour'
				});
			}

			// No ml-auto here: the plan pill that follows is the sole right-anchor, so
			// the indicator and the pill travel to the right edge as one unit whether
			// or not the indicator is visible.
			this.fiveHourIndicator = document.createElement('span');
			this.fiveHourIndicator.className = 'cc-usageText text-text-500 opacity-75 whitespace-nowrap select-none flex-shrink-0';
			this.fiveHourIndicator.textContent = '5-hour limit';
			this.usageLine.appendChild(this.fiveHourIndicator);

			// The only settings surface in the extension: click to override the
			// detected plan. Mirrors the Gemini tier pill.
			this.planButton = document.createElement('button');
			this.planButton.type = 'button';
			this.planButton.className = 'cc-planButton mr-3';
			this.planButton.textContent = 'Plan';
			this.usageLine.appendChild(this.planButton);

			this.refreshProgressChrome();

			this.usageLine.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});

			// The row itself is click-to-refresh, so the pill must not bubble.
			this.planButton.addEventListener('click', (e) => {
				e.stopPropagation();
				e.preventDefault();
				this.onPlanCycle?.();
			});
		}

		/** @param {{plan: string, source: string}} planInfo */
		setPlan(planInfo) {
			this.plan = planInfo || null;
			if (!this.planButton) return;
			const plan = planInfo?.plan;
			const name = CC.PLAN_NAMES?.[plan] || plan || '?';
			// '· auto' distinguishes a detected plan from one the user pinned.
			this.planButton.textContent = planInfo?.source === 'manual' ? name : `${name} · auto`;
			this.planButton.title = planInfo?.source === 'manual'
				? `Plan set manually to ${name}. Click to change.`
				: `Plan detected as ${name}. Click to override.`;
		}

		/** Window keys this plan is expected to have; empty means "no opinion". */
		_planWindowKeys() {
			const spec = CC.PLAN_SPECS?.[this.plan?.plan];
			return spec?.windows || [];
		}

		/**
		 * Models to show on the new-chat screen. Only `free` narrows the list, so a
		 * mis-detected plan can't silently drop bars.
		 */
		_planModelKeys() {
			const all = CC.MODELS || ['haiku', 'sonnet', 'opus'];
			if (this.plan?.plan !== 'free') return all;
			const spec = CC.PLAN_SPECS?.free;
			return all.filter((m) => spec?.models?.includes(m));
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip(
				"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nBecomes invalid after context compaction.\nBar scale: 200k tokens (Claude's maximum context length, will compact before then)."
			);
			setupTooltip(
				this.lengthGroup,
				this.lengthTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.cachedDisplay,
				makeTooltip("Messages sent while cached are significantly cheaper."),
				{ topOffset: 8 }
			);

			// The 5-hour budget is shared across models, so the per-model bars on the
			// new-chat screen are a relative-burn-rate preview. Say so in the tooltip
			// rather than letting the numbers imply three separate budgets.
			for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
				const mg = this.modelGroups?.[m];
				if (!mg?.group) continue;
				const name = CC.MODEL_NAMES?.[m] || m;
				const mult = CC.MODEL_USAGE_MULTIPLIERS?.[m] ?? 1;
				const note = mult === 1
					? 'This is your exact reported usage.'
					: `Scaled ${mult < 1 ? `x1/${Math.round(1 / mult)}` : `x${mult}`} from the reported figure to reflect ${name}'s relative burn rate.`;
				setupTooltip(
					mg.group,
					makeTooltip(`${name} - shared 5-hour session window.\n${note}\nThe line marks where you are in the window.`),
					{ topOffset: 8 }
				);
			}

			const windowTips = {
				five_hour: '5-hour session window, exactly as reported by Claude.\nShared across all models.\nThe line marks where you are in the window.',
				seven_day: '7-day usage window across all models.\nThe bar shows your usage.\nThe line marks where you are in the window.',
				seven_day_opus: '7-day Opus usage window.\nOpus has its own weekly cap on Max plans.\nThe line marks where you are in the window.'
			};
			for (const win of (CC.WINDOWS || [])) {
				const wg = this.windowGroups?.[win.key];
				if (!wg?.group) continue;
				setupTooltip(wg.group, makeTooltip(windowTips[win.key] || win.label), { topOffset: 8 });
			}
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			const chatMenu = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (!chatMenu) return;
			const anchor = chatMenu.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || chatMenu.parentElement;
			if (!anchor) return;
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			if (!this.usageLine) return;
			const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (!modelSelector) return;
			const gridContainer = modelSelector.closest('[data-testid="chat-input-grid-container"]');
			const gridArea = modelSelector.closest('[data-testid="chat-input-grid-area"]');
			const findToolbarRow = (el, stopAt) => {
				let cur = el;
				while (cur && cur !== document.body) {
					if (stopAt && cur === stopAt) break;
					if (cur !== el && cur.nodeType === 1) {
						const style = window.getComputedStyle(cur);
						if (style.display === 'flex' && style.flexDirection === 'row') {
							const buttons = cur.querySelectorAll('button').length;
							if (buttons > 1) return cur;
						}
					}
					cur = cur.parentElement;
				}
				return null;
			};

			const toolbarRow =
				(gridContainer ? findToolbarRow(modelSelector, gridArea || gridContainer) : null) ||
				findToolbarRow(modelSelector) ||
				modelSelector.parentElement?.parentElement?.parentElement;
			if (!toolbarRow) return;
			if (toolbarRow.nextElementSibling !== this.usageLine) {
				toolbarRow.after(this.usageLine);
			}
			this.refreshProgressChrome();
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			if (this.cacheTimeSpan) {
				if (pending) {
					this.cacheTimeSpan.style.color = '';
				} else {
					const { boldColor } = this.getProgressChrome();
					this.cacheTimeSpan.style.color = boldColor;
				}
			}
		}

		setConversationMetrics({ totalTokens, cachedUntil } = {}) {
			this.pendingCache = false;

			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.cachedDisplay.textContent = '';
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}

			const pct = Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
			this.lengthDisplay.textContent = `~${totalTokens.toLocaleString()} tokens`;

			// Mini bar (hide when full - context is definitely compacted by then)
			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
				if (this.lengthTooltip) {
					this.lengthTooltip.textContent =
						"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nThis count is invalid after compaction.";
				}
			} else {
				this.lengthDisplay.style.opacity = '';
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				if (pct >= 90) fill.classList.add('cc-warn');
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();

				const barContainer = document.createElement('span');
				barContainer.className = 'inline-flex items-center';
				barContainer.appendChild(bar);

				this.lengthGroup.replaceChildren(this.lengthDisplay, document.createTextNode('\u00A0\u00A0'), barContainer);
			}

			// Cache timer
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				const { boldColor } = this.getProgressChrome();
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this.cacheTimeSpan.style.color = boldColor;
				this.cachedDisplay.replaceChildren(document.createTextNode('cached for\u00A0'), this.cacheTimeSpan);
			} else {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.cachedDisplay.textContent = '';
			}

			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();

			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;

			if (!hasTokens) return;

			if (hasCache) {
				const gap = this.lengthBar ? '\u00A0\u00A0' : '\u00A0';
				this.headerDisplay.replaceChildren(
					this.lengthGroup,
					document.createTextNode(gap),
					this.cachedDisplay
				);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup);
			}

			this.headerContainer.appendChild(this.headerDisplay);
		}

		/**
		 * Paint one bar group from a normalized window ({utilization, resets_at,
		 * window_hours}). Returns nothing; stores the derived window bounds on the
		 * group so _updateMarkers and tick can reuse them.
		 */
		_paintGroup(group, win, label, { showReset = true, defaultHours = 5 } = {}) {
			if (!group) return;
			group.group.classList.remove('cc-hidden');

			if (!win || typeof win.utilization !== 'number') {
				group.usageSpan.textContent = `${label}: --`;
				group.barFill.style.width = '0%';
				group.barFill.classList.remove('cc-warn', 'cc-full');
				group.resetMs = null;
				group.windowStartMs = null;
				return;
			}

			const rawPct = win.utilization;
			group.resetMs = win.resets_at ? Date.parse(win.resets_at) : null;
			if (!Number.isFinite(group.resetMs)) group.resetMs = null;
			const windowHours = win.window_hours || defaultHours;
			group.windowStartMs = group.resetMs ? group.resetMs - windowHours * 60 * 60 * 1000 : null;

			const resetText = (showReset && group.resetMs) ? ` · resets in ${formatResetCountdown(group.resetMs)}` : '';
			group.usageSpan.textContent = `${label}: ${Math.round(rawPct * 10) / 10}%${resetText}`;

			const width = Math.max(0, Math.min(100, rawPct));
			group.barFill.style.width = `${width}%`;
			group.barFill.classList.toggle('cc-warn', width >= 90);
			group.barFill.classList.toggle('cc-full', width >= 99.5);
		}

		_hideGroup(group) {
			if (!group) return;
			group.group.classList.add('cc-hidden');
			group.resetMs = null;
			group.windowStartMs = null;
			group.barFill.classList.remove('cc-warn', 'cc-full');
		}

		setUsage(usage, { isNewChat = false, activeModel = 'sonnet', plan = null } = {}) {
			this.isNewChat = !!isNewChat;
			this.activeModel = activeModel;
			if (plan) this.setPlan(plan);

			this.refreshProgressChrome();

			const modelsFiveHour = usage?.models_five_hour || {};
			const fiveHour = usage?.five_hour || null;
			const hasAnyUsage = CC.WINDOWS.some((w) => !!usage?.[w.key]) || Object.keys(modelsFiveHour).length > 0;
			this.usageLine?.classList.toggle('cc-hidden', !hasAnyUsage);

			this.fiveHourResetMs = fiveHour?.resets_at ? Date.parse(fiveHour.resets_at) : null;
			if (!Number.isFinite(this.fiveHourResetMs)) this.fiveHourResetMs = null;

			if (isNewChat) {
				// --- New-chat screen: multimodal preview of the shared 5h window ---
				// Sonnet carries the exact reported figure; Haiku and Opus are scaled
				// by their relative burn rate (CC.MODEL_USAGE_MULTIPLIERS).
				const visibleModels = this._planModelKeys();
				for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
					const mg = this.modelGroups?.[m];
					if (!mg) continue;
					if (!visibleModels.includes(m)) {
						this._hideGroup(mg);
						continue;
					}
					const barWidth = CC.MODEL_WIDTHS?.[m] || '96px';
					mg.bar.style.width = barWidth;
					mg.bar.style.flex = `0 0 ${barWidth}`;
					// The shared countdown lives in the trailing indicator instead of
					// being repeated on all three bars.
					this._paintGroup(mg, modelsFiveHour[m] || fiveHour, CC.MODEL_NAMES?.[m] || m, { showReset: false });
				}

				// Weekly bars stay off the new-chat screen, as before.
				for (const win of (CC.WINDOWS || [])) this._hideGroup(this.windowGroups?.[win.key]);

				if (this.fiveHourIndicator) {
					this.fiveHourIndicator.style.display = '';
					const resetText = this.fiveHourResetMs ? ` · resets in ${formatResetCountdown(this.fiveHourResetMs)}` : '';
					this.fiveHourIndicator.textContent = `5h limit${resetText}`;
				}
			} else {
				// --- Inside a conversation: the real windows, no scaling ---
				for (const mg of Object.values(this.modelGroups || {})) this._hideGroup(mg);

				const planWindows = this._planWindowKeys();
				for (const win of (CC.WINDOWS || [])) {
					const wg = this.windowGroups?.[win.key];
					if (!wg) continue;
					const data = usage?.[win.key] || null;
					// The API is authoritative: anything it returned is rendered even if
					// the detected plan says this window shouldn't exist, so a wrong plan
					// can never erase a real bar.
					//
					// The plan spec's only job is the reverse case: if usage came back but
					// omitted a window this plan is supposed to have, show a '--'
					// placeholder rather than silently nothing - that's a reporting gap
					// the user should be able to see.
					const expected = planWindows.includes(win.key);
					if (!data && !(expected && hasAnyUsage)) {
						this._hideGroup(wg);
						continue;
					}
					this._paintGroup(wg, data, win.label, { defaultHours: win.hours });
				}

				if (this.fiveHourIndicator) this.fiveHourIndicator.style.display = 'none';
			}

			this._updateMarkers();
		}

		_updateMarkers() {
			const now = Date.now();

			const place = (group, show) => {
				if (!group?.marker) return;
				if (!show || !group.windowStartMs || !group.resetMs) {
					group.marker.classList.add('cc-hidden');
					return;
				}
				const total = group.resetMs - group.windowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - group.windowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				group.marker.classList.remove('cc-hidden');
				group.marker.style.left = `${Math.max(0, Math.min(100, ratio * 100))}%`;
			};

			// New chat: one marker, on Sonnet - the three bars share one window, so
			// three identical markers would just be noise.
			for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
				place(this.modelGroups?.[m], this.isNewChat && m === 'sonnet');
			}

			// In a conversation every visible window gets its own marker; they have
			// genuinely different spans.
			for (const win of (CC.WINDOWS || [])) {
				place(this.windowGroups?.[win.key], !this.isNewChat);
			}
		}

		tick() {
			// Cache countdown
			const now = Date.now();
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) {
					this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
				}
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.pendingCache = false;
				this.cachedDisplay.textContent = '';
				this._renderHeader();
			}

			// Reset countdown text. Patched in place rather than re-rendered.
			const groups = [...Object.values(this.modelGroups || {}), ...Object.values(this.windowGroups || {})];
			for (const group of groups) {
				if (!group?.resetMs || !group?.usageSpan?.textContent) continue;
				const idx = group.usageSpan.textContent.indexOf('· resets in');
				if (idx === -1) continue;
				const prefix = group.usageSpan.textContent.slice(0, idx + '· resets in '.length);
				group.usageSpan.textContent = `${prefix}${formatResetCountdown(group.resetMs)}`;
			}

			if (this.isNewChat && this.fiveHourResetMs && this.fiveHourIndicator?.textContent) {
				const idx = this.fiveHourIndicator.textContent.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = this.fiveHourIndicator.textContent.slice(0, idx + '· resets in '.length);
					this.fiveHourIndicator.textContent = `${prefix}${formatResetCountdown(this.fiveHourResetMs)}`;
				}
			}

			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI
	};
})();


(() => {
	'use strict';
	if (location.hostname !== 'claude.ai') return;

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__ccUserscriptStarted) return;
	CC.__ccUserscriptStarted = true;

	const STYLE_ID = 'cc-userscript-styles';
	const STYLES = "/* Header: tokens + cache timer */\n.cc-header {\n\tmargin-top: 2px;\n\tuser-select: none;\n}\n\n.cc-headerItem {\n\twhite-space: nowrap;\n}\n\n/* Usage row: session + weekly */\n.cc-usageRow {\n\tposition: relative;\n\tz-index: 50;\n\tcursor: pointer;\n\tuser-select: none;\n\ttransition: opacity 150ms ease;\n\tflex-wrap: nowrap;\n}\n\n.cc-usageRow--dim {\n\topacity: 0.6;\n}\n\n.cc-usageGroup {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 6px;\n\tflex: 1 1 auto;\n\tmin-width: 0;\n}\n\n.cc-usageGroup--model {\n\tflex: 0 0 auto;\n}\n\n.cc-usageGroup--single {\n\twidth: 100%;\n}\n\n/* Rate-limit window bars (in-conversation). Their track carries an explicit\n   width, so the group must not stretch. */\n.cc-usageGroup--window {\n\tflex: 0 0 auto;\n}\n\n/* The weekly windows render bar-then-label, so they hug the right. */\n.cc-usageGroup--seven_day,\n.cc-usageGroup--seven_day_opus {\n\tjustify-content: flex-end;\n}\n\n.cc-usageText {\n\twhite-space: nowrap;\n}\n\n/* Bars (mini + usage) */\n.cc-bar {\n\t--cc-radius: 3px;\n\t--cc-stroke: transparent;\n\t--cc-fill: transparent;\n\t--cc-fill-warn: var(--cc-fill);\n\t--cc-marker: transparent;\n\n\tposition: relative;\n\tbox-sizing: border-box;\n\twidth: 100%;\n\theight: 6px;\n\tborder-radius: var(--cc-radius);\n\tborder: 1px solid var(--cc-stroke);\n\toverflow: visible;\n\tuser-select: none;\n}\n\n.cc-bar__fill {\n\twidth: 0%;\n\theight: 100%;\n\tbackground: var(--cc-fill);\n\ttransition: width 300ms ease, background-color 300ms ease;\n\tborder-top-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-top-right-radius: 0;\n\tborder-bottom-right-radius: 0;\n}\n\n.cc-bar__fill.cc-full {\n\tborder-top-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n}\n\n.cc-bar__fill.cc-warn {\n\tbackground: var(--cc-fill-warn);\n}\n\n.cc-bar__marker {\n\tposition: absolute;\n\ttop: 0;\n\tbottom: 0;\n\tleft: 0%;\n\twidth: 2px;\n\tbackground: var(--cc-marker);\n\tpointer-events: none;\n}\n\n.cc-bar--mini {\n\twidth: 60px;\n\theight: 7px;\n\t--cc-radius: 2px;\n}\n\n.cc-bar--usage {\n\theight: 10px;\n\tflex: 1;\n}\n\n/* Tooltips */\n.cc-tooltip {\n\tposition: fixed;\n\tz-index: 9999;\n\tpadding: 4px 8px;\n\tborder-radius: 4px;\n\tfont-size: 12px;\n\twhite-space: pre-line;\n\tuser-select: none;\n\tpointer-events: none;\n\topacity: 0;\n\ttransition: opacity 200ms ease;\n}\n\n.cc-tooltipTrigger {\n\t-webkit-touch-callout: none;\n\t-webkit-user-select: none;\n\tuser-select: none;\n\tcursor: help;\n}\n\n/* Hide optional elements completely (no layout space) */\n.cc-hidden {\n\tdisplay: none !important;\n}\n\n/* ==========================================================================\n   Gemini (gemini.google.com)\n   Reuses the .cc-bar primitives above. Gemini has none of Claude's utility\n   classes, so everything here is plain CSS.\n   ========================================================================== */\n\n.gc-usageRow {\n\t--gc-text: #5f6368;\n\n\tdisplay: flex;\n\tflex-direction: row;\n\talign-items: center;\n\tgap: 16px;\n\tflex-wrap: nowrap;\n\twidth: 100%;\n\tbox-sizing: border-box;\n\tmargin: 6px 0 2px;\n\tpadding: 0 4px;\n\tfont-size: 11px;\n\tline-height: 1.4;\n\tcolor: var(--gc-text);\n\tuser-select: none;\n}\n\n.gc-usageGroup {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 6px;\n\tflex: 1 1 0;\n\tmin-width: 0;\n}\n\n.gc-usageText {\n\twhite-space: nowrap;\n\tflex-shrink: 0;\n}\n\n.gc-usageRow .cc-bar--usage {\n\tflex: 1 1 auto;\n\tmin-width: 48px;\n}\n\n.gc-tierButton,\n.cc-planButton {\n\tflex-shrink: 0;\n\tmargin-left: auto;\n\tpadding: 1px 6px;\n\tborder-radius: 10px;\n\tbackground: transparent;\n\tfont: inherit;\n\tfont-size: 10px;\n\tline-height: 1.4;\n\twhite-space: nowrap;\n\tcursor: pointer;\n\topacity: 0.85;\n\ttransition: opacity 150ms ease;\n}\n\n.gc-tierButton {\n\tborder: 1px solid var(--gc-stroke, #c4c7c5);\n\tcolor: var(--gc-text);\n}\n\n/* Picks up the terracotta chrome refreshProgressChrome sets on the row. */\n.cc-planButton {\n\tborder: 1px solid var(--cc-stroke, #bfbfbf);\n\tcolor: inherit;\n}\n\n.gc-tierButton:hover,\n.cc-planButton:hover {\n\topacity: 1;\n}\n\n/* Gemini gradient fill.\n   The gradient must span the full bar, not the filled portion, or a 20% fill\n   would squash all five stops into a fifth of the bar. So the fill is always\n   full width and is revealed left-to-right with clip-path. */\n.cc-bar--gemini .cc-bar__fill {\n\twidth: 100%;\n\tbackground: linear-gradient(90deg, #1ba1e3 0%, #5489d6 25%, #9b72cb 50%, #d96570 75%, #f49c46 100%);\n\tclip-path: inset(0 calc(100% - var(--cc-pct, 0%)) 0 0);\n\ttransition: clip-path 300ms ease, background 300ms ease;\n\tborder-radius: max(0px, calc(var(--cc-radius) - 1px));\n}\n\n/* Near the cap, drop the gradient for the same solid red the context bar uses. */\n.cc-bar--gemini .cc-bar__fill.cc-warn {\n\tbackground: var(--cc-fill-warn);\n}\n\n.gc-tooltip {\n\tbackground: #1f1f1f;\n\tcolor: #e3e3e3;\n\tbox-shadow: 0 1px 3px rgb(0 0 0 / 30%);\n\tmax-width: 320px;\n}\n\n@media (prefers-color-scheme: light) {\n\t.gc-tooltip {\n\t\tbackground: #303030;\n\t\tcolor: #f1f3f4;\n\t}\n}\n";

	function injectStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = STYLES;
		(document.head || document.documentElement).appendChild(style);
	}

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				const el = document.querySelector(selector);
				if (el) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(el);
				}
			});

			observer.observe(document.body, { childList: true, subtree: true });

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}

	CC.waitForElement = waitForElement;

	function normalizeModelName(rawModel) {
		if (!rawModel || typeof rawModel !== 'string') return null;
		const lower = rawModel.toLowerCase();
		if (lower.includes('haiku')) return 'haiku';
		if (lower.includes('opus')) return 'opus';
		if (lower.includes('fable')) return 'fable';
		if (lower.includes('sonnet')) return 'sonnet';
		return null;
	}

	function parseOveruse(rawObj) {
		if (!rawObj || typeof rawObj !== 'object') return null;
		const cand = rawObj.extra_usage || rawObj.overage || rawObj.overuse || rawObj.overuse_credits || rawObj.credits || rawObj.extra_credits;
		if (!cand || typeof cand !== 'object') return null;
		if (cand.is_enabled === false) return null;

		let utilization = null;
		if (typeof cand.utilization === 'number' && Number.isFinite(cand.utilization)) {
			utilization = Math.max(0, Math.min(100, cand.utilization));
		} else if (typeof cand.used_percentage === 'number' && Number.isFinite(cand.used_percentage)) {
			utilization = Math.max(0, Math.min(100, cand.used_percentage));
		}

		let used = cand.used_credits ?? cand.used ?? cand.spent ?? cand.amount ?? null;
		let limit = cand.monthly_limit ?? cand.limit ?? cand.budget ?? cand.total ?? null;
		if (utilization === null && typeof used === 'number' && typeof limit === 'number' && limit > 0) {
			utilization = Math.max(0, Math.min(100, (used / limit) * 100));
		}

		return { utilization, used, limit, raw: cand };
	}

	/**
	 * /usage sends utilization as 0-100 but the SSE message_limit sends 0-1.
	 * Assuming one or the other silently multiplies (or divides) every reading by
	 * 100, so infer it: a genuine fraction can't exceed 1, and 1% of a window is
	 * close enough to 100% of nothing that the tie doesn't matter.
	 */
	function toPercent(value) {
		if (typeof value !== 'number' || !Number.isFinite(value)) return null;
		const pct = value <= 1 ? value * 100 : value;
		return Math.max(0, Math.min(100, pct));
	}

	/**
	 * Scaled per-model view of the shared 5-hour window, for the new-chat screen
	 * only. Anthropic reports ONE five_hour utilization; Sonnet shows it verbatim
	 * and the others are scaled by CC.MODEL_USAGE_MULTIPLIERS to preview relative
	 * burn rate. Intentional approximation - see the note on that constant.
	 */
	function scaleModelWindows(fiveHour) {
		if (!fiveHour || typeof fiveHour.utilization !== 'number') return {};
		const out = {};
		for (const model of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
			const mult = CC.MODEL_USAGE_MULTIPLIERS?.[model] ?? 1.0;
			out[model] = {
				utilization: Math.max(0, Math.min(100, fiveHour.utilization * mult)),
				resets_at: fiveHour.resets_at,
				window_hours: fiveHour.window_hours || 5,
				scaled: model !== 'sonnet'
			};
		}
		return out;
	}

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			const utilization = toPercent(w.utilization);
			if (utilization === null) return null;
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.five_hour, 5);
		const sevenDay = normalizeWindow(raw.seven_day, 24 * 7);
		const sevenDayOpus = normalizeWindow(raw.seven_day_opus || raw.seven_day?.opus, 24 * 7);
		const overuse = parseOveruse(raw);

		if (!fiveHour && !sevenDay && !sevenDayOpus && !overuse) return null;
		return {
			five_hour: fiveHour,
			seven_day: sevenDay,
			seven_day_opus: sevenDayOpus,
			overuse,
			models_five_hour: scaleModelWindows(fiveHour)
		};
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			const utilization = toPercent(w.utilization);
			if (utilization === null) return null;
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};

		const windows = raw.windows;
		const fiveHour = normalizeWindow(windows['5h'], 5);
		const sevenDay = normalizeWindow(windows['7d'], 24 * 7);
		const sevenDayOpus = normalizeWindow(windows['7d_opus'] || windows['7d_oauth_apps_opus'], 24 * 7);
		const overuse = parseOveruse(raw);

		if (!fiveHour && !sevenDay && !sevenDayOpus && !overuse) return null;
		return {
			five_hour: fiveHour,
			seven_day: sevenDay,
			seven_day_opus: sevenDayOpus,
			overuse,
			models_five_hour: scaleModelWindows(fiveHour)
		};
	}

	let currentConversationId = null;
	let currentConversationModel = null;
	let currentOrgId = null;

	let usageState = null;
	// Cached parsed timestamps, keyed by CC.WINDOWS key, so tick() avoids Date.parse.
	let usageResetMs = { five_hour: null, seven_day: null, seven_day_opus: null };
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	let lastUsageFetchMs = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null, seven_day_opus: null };

	function detectActiveModel() {
		if (currentConversationModel) {
			const m = normalizeModelName(currentConversationModel);
			if (m) return m;
		}
		const el = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
		if (el) {
			const m = normalizeModelName(el.textContent || '');
			if (m) return m;
		}
		return 'sonnet';
	}

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage({ force: true });
		},
		onPlanCycle: () => {
			CC.plan.cycle();
			renderUsage();
		}
	});

	const originalFetch = CC._ccInternal?.originalFetch || (window.fetch ? window.fetch.bind(window) : null);

	/** Re-render from the last snapshot without re-fetching. */
	function renderUsage() {
		if (!usageState) return;
		ui.setUsage(usageState, {
			isNewChat: !currentConversationId,
			activeModel: detectActiveModel(),
			plan: CC.plan.get()
		});
	}

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		usageState = normalized;
		lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		// Cache parsed timestamps to avoid Date.parse() every tick
		for (const { key } of CC.WINDOWS) {
			const resetsAt = normalized[key]?.resets_at;
			usageResetMs[key] = resetsAt ? Date.parse(resetsAt) : null;
		}

		renderUsage();
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function requestUsage(orgId) {
		if (!originalFetch) return null;
		const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
			method: 'GET',
			credentials: 'include'
		});
		return await res.json();
	}

	async function requestConversation(orgId, conversationId) {
		if (!originalFetch) return null;
		const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
		const res = await originalFetch(url, {
			method: 'GET',
			credentials: 'include'
		});
		const json = await res.json();
		return json;
	}

	/**
	 * @param {{force?: boolean}} [opts] force skips the min-interval floor; used
	 *   only for the explicit click-to-refresh, never for automatic triggers.
	 */
	async function refreshUsage({ force = false } = {}) {
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		// Several triggers can fire off one message; keep /usage from being hammered.
		if (!force && Date.now() - lastUsageFetchMs < CC.CONST.USAGE_MIN_INTERVAL_MS) return;

		usageFetchInFlight = true;
		lastUsageFetchMs = Date.now();
		let raw;
		try {
			raw = await requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		// The response shape itself tells us about the plan's window topology.
		const planChanged = CC.plan.observeUsageShape(raw);

		const parsed = parseUsageFromUsageEndpoint(raw);
		if (parsed) applyUsageUpdate(parsed, 'usage');
		else if (planChanged) renderUsage();
	}

	/** Re-fetch after `delayMs`. Coalesced by the floor inside refreshUsage. */
	function scheduleUsageRefresh(delayMs) {
		setTimeout(() => refreshUsage(), delayMs);
	}

	async function refreshConversation() {
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			const data = await requestConversation(orgId, currentConversationId);
			await handleConversationPayload({ orgId, conversationId: currentConversationId, data });
		} catch {
			// ignore
		}
	}

	function handleGenerationStart() {
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		const rawModel = data.model || data.chat_messages?.[0]?.model;
		const m = normalizeModelName(rawModel);
		if (m) {
			currentConversationModel = m;
			renderUsage();
		}

		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	function handleMessageLimit(messageLimit) {
		// Apply immediately for instant feedback, then confirm against /usage - the
		// SSE payload has been reshaped before, and an unrecognised shape parses to
		// null, which would otherwise leave the bars frozen until the safety refresh.
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
		scheduleUsageRefresh(CC.CONST.POST_GENERATION_DELAYS_MS[0]);
	}

	function handleGenerationEnd() {
		// The server's usage counter lags the end of the stream, so check twice.
		for (const delay of CC.CONST.POST_GENERATION_DELAYS_MS) {
			scheduleUsageRefresh(delay);
		}
	}

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
			if (el) ui.attachUsageLine();
		});
		waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
			if (el) ui.attachHeader();
		});

		if (!currentConversationId) {
			currentConversationModel = null;
			ui.setConversationMetrics();
			renderUsage();
			return;
		}

		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		if (!usageState) {
			await refreshUsage();
		} else {
			renderUsage();
		}
	}

	function tick() {
		ui.tick();

		// Refresh usage when a window ends. SSE won't fire at rollover unless a
		// message is sent, so the rollover has to be noticed locally.
		const now = Date.now();

		for (const { key } of CC.WINDOWS) {
			const resetMs = usageResetMs[key];
			if (resetMs && now >= resetMs && rolloverHandledForResetMs[key] !== resetMs) {
				rolloverHandledForResetMs[key] = resetMs;
				refreshUsage({ force: true });
			}
		}

		// Periodic safety refresh while the tab is visible. This used to be hourly,
		// which meant a bar could sit an hour out of date mid-session whenever the
		// SSE message_limit event didn't arrive.
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > CC.CONST.USAGE_REFRESH_MS && anyAge > CC.CONST.USAGE_REFRESH_MS) {
			refreshUsage();
		}
	}

	async function start() {
		injectStyles();
		ui.initialize();
		CC._ccInternal.onGenerationStart = handleGenerationStart;
		CC._ccInternal.onGenerationEnd = handleGenerationEnd;
		CC._ccInternal.onConversationData = handleConversationPayload;
		CC._ccInternal.onMessageLimit = handleMessageLimit;
		CC._ccInternal.onUrlChange = handleUrlChange;

		document.addEventListener('visibilitychange', () => {
			if (document.hidden) return;
			if (Date.now() - lastUsageUpdateMs > CC.CONST.USAGE_STALE_ON_VISIBLE_MS) {
				refreshUsage();
			}
		});

		setInterval(tick, 1000);

		// The stored plan gates which bars render, so load it before the first paint.
		await CC.plan.load();
		ui.setPlan(CC.plan.get());

		handleUrlChange();

		if (await CC.plan.detect({ orgId: currentOrgId || getOrgIdFromCookie() })) {
			renderUsage();
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start, { once: true });
	} else {
		start();
	}
})();


// ===========================================================================
// Gemini (gemini.google.com)
// Mirrors src/gemini/* from the extension build. Usage is estimated locally:
// Gemini exposes no usage API, so prompts are counted and weighted by model.
// ===========================================================================

(() => {
	'use strict';
	if (location.hostname !== 'gemini.google.com') return;

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	GC.CONST = Object.freeze({
		FIVE_HOUR_MS: 5 * 60 * 60 * 1000,
		SEVEN_DAY_MS: 7 * 24 * 60 * 60 * 1000,
		STORAGE_KEY: 'gc:usage:v1',
		BRIDGE_SCRIPT_ID: 'gc-bridge-script',
		MARKER: 'GeminiCounter',
		// A network send and the DOM fallback for the same prompt must not both count.
		SEND_DEDUPE_MS: 2000,
		// How long the DOM fallback waits for a matching request before counting it itself.
		DOM_FALLBACK_MS: 800
	});

	// Google's Gemini brand gradient.
	GC.GRADIENT = Object.freeze(['#1BA1E3', '#5489D6', '#9B72CB', '#D96570', '#F49C46']);

	GC.COLORS = Object.freeze({
		TRACK_DARK: '#3c4043',
		TRACK_LIGHT: '#c4c7c5',
		TEXT_DARK: '#c4c7c5',
		TEXT_LIGHT: '#5f6368',
		MARKER_DARK: '#ffffff',
		MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029'
	});

	// --- Calibration ---------------------------------------------------------
	// Google publishes no compute budget for the Gemini app, so these are
	// estimates, not documented figures. Tune them here as real throttling is
	// observed; nothing else in the module hardcodes a cost.

	GC.MODEL_WEIGHTS = Object.freeze({
		flash: 1,
		pro: 4,
		thinking: 8
	});

	GC.FEATURE_WEIGHTS = Object.freeze({
		deepResearch: 20,
		imageGen: 5,
		video: 40
	});

	GC.DEFAULT_MODEL = 'pro';

	GC.TIERS = Object.freeze(['free', 'pro', 'ultra']);

	GC.TIER_NAMES = Object.freeze({
		free: 'Free',
		pro: 'Pro',
		ultra: 'Ultra'
	});

	// Credits per 5-hour window. Google states Pro is ~4x and Ultra ~20x the
	// standard (free) allowance.
	GC.TIER_BUDGETS = Object.freeze({
		free: 100,
		pro: 400,
		ultra: 2000
	});

	GC.DEFAULT_TIER = 'pro';

	// Weekly budget = 5-hour budget x this. A 7-day span holds ~33.6 five-hour
	// windows, so a multiplier well below that is what makes the weekly cap bind
	// before you could exhaust every window.
	GC.WEEKLY_MULTIPLIER = 10;

	// --- DOM ------------------------------------------------------------------
	// Gemini is an Angular app with no stable test ids. Everything below is a
	// prioritised candidate list: first hit wins, and the UI re-attaches itself
	// if the SPA tears the row out.

	GC.DOM = Object.freeze({
		COMPOSER: [
			'input-area-v2',
			'input-container',
			'rich-textarea',
			'.ql-editor',
			'[contenteditable="true"][role="textbox"]',
			'[data-node-type="input-area"]'
		],
		MODEL_PICKER: [
			'bard-mode-switcher button',
			'[data-test-id="bard-mode-menu-button"]',
			'[data-test-id="mode-switcher-trigger"]',
			'button[aria-haspopup="menu"] .logo-pill-label-container',
			'.gds-mode-switch-button'
		],
		SEND_BUTTON: [
			'button.send-button',
			'[data-test-id="send-button"]',
			'button[aria-label*="Send" i]',
			'button[mattooltip*="Send" i]'
		]
	});

	GC.MODEL_NAMES = Object.freeze({
		flash: 'Flash',
		pro: 'Pro',
		thinking: 'Thinking'
	});
})();


(() => {
	'use strict';
	if (location.hostname !== 'gemini.google.com') return;
	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});
	GC.__STYLES = "/* Header: tokens + cache timer */\n.cc-header {\n\tmargin-top: 2px;\n\tuser-select: none;\n}\n\n.cc-headerItem {\n\twhite-space: nowrap;\n}\n\n/* Usage row: session + weekly */\n.cc-usageRow {\n\tposition: relative;\n\tz-index: 50;\n\tcursor: pointer;\n\tuser-select: none;\n\ttransition: opacity 150ms ease;\n\tflex-wrap: nowrap;\n}\n\n.cc-usageRow--dim {\n\topacity: 0.6;\n}\n\n.cc-usageGroup {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 6px;\n\tflex: 1 1 auto;\n\tmin-width: 0;\n}\n\n.cc-usageGroup--model {\n\tflex: 0 0 auto;\n}\n\n.cc-usageGroup--single {\n\twidth: 100%;\n}\n\n.cc-usageGroup--weekly {\n\tjustify-content: flex-end;\n}\n\n.cc-usageGroup--overuse {\n\tflex: 0 0 auto;\n\tjustify-content: flex-end;\n}\n\n.cc-usageText {\n\twhite-space: nowrap;\n}\n\n/* Bars (mini + usage) */\n.cc-bar {\n\t--cc-radius: 3px;\n\t--cc-stroke: transparent;\n\t--cc-fill: transparent;\n\t--cc-fill-warn: var(--cc-fill);\n\t--cc-marker: transparent;\n\n\tposition: relative;\n\tbox-sizing: border-box;\n\twidth: 100%;\n\theight: 6px;\n\tborder-radius: var(--cc-radius);\n\tborder: 1px solid var(--cc-stroke);\n\toverflow: visible;\n\tuser-select: none;\n}\n\n.cc-bar__fill {\n\twidth: 0%;\n\theight: 100%;\n\tbackground: var(--cc-fill);\n\ttransition: width 300ms ease, background-color 300ms ease;\n\tborder-top-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-top-right-radius: 0;\n\tborder-bottom-right-radius: 0;\n}\n\n.cc-bar__fill.cc-full {\n\tborder-top-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n}\n\n.cc-bar__fill.cc-warn {\n\tbackground: var(--cc-fill-warn);\n}\n\n.cc-bar__marker {\n\tposition: absolute;\n\ttop: 0;\n\tbottom: 0;\n\tleft: 0%;\n\twidth: 2px;\n\tbackground: var(--cc-marker);\n\tpointer-events: none;\n}\n\n.cc-bar--mini {\n\twidth: 60px;\n\theight: 7px;\n\t--cc-radius: 2px;\n}\n\n.cc-bar--usage {\n\theight: 10px;\n\tflex: 1;\n}\n\n/* Tooltips */\n.cc-tooltip {\n\tposition: fixed;\n\tz-index: 9999;\n\tpadding: 4px 8px;\n\tborder-radius: 4px;\n\tfont-size: 12px;\n\twhite-space: pre-line;\n\tuser-select: none;\n\tpointer-events: none;\n\topacity: 0;\n\ttransition: opacity 200ms ease;\n}\n\n.cc-tooltipTrigger {\n\t-webkit-touch-callout: none;\n\t-webkit-user-select: none;\n\tuser-select: none;\n\tcursor: help;\n}\n\n/* Hide optional elements completely (no layout space) */\n.cc-hidden {\n\tdisplay: none !important;\n}\n\n/* ==========================================================================\n   Gemini (gemini.google.com)\n   Reuses the .cc-bar primitives above. Gemini has none of Claude's utility\n   classes, so everything here is plain CSS.\n   ========================================================================== */\n\n.gc-usageRow {\n\t--gc-text: #5f6368;\n\n\tdisplay: flex;\n\tflex-direction: row;\n\talign-items: center;\n\tgap: 16px;\n\tflex-wrap: nowrap;\n\twidth: 100%;\n\tbox-sizing: border-box;\n\tmargin: 6px 0 2px;\n\tpadding: 0 4px;\n\tfont-size: 11px;\n\tline-height: 1.4;\n\tcolor: var(--gc-text);\n\tuser-select: none;\n}\n\n.gc-usageGroup {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 6px;\n\tflex: 1 1 0;\n\tmin-width: 0;\n}\n\n.gc-usageText {\n\twhite-space: nowrap;\n\tflex-shrink: 0;\n}\n\n.gc-usageRow .cc-bar--usage {\n\tflex: 1 1 auto;\n\tmin-width: 48px;\n}\n\n.gc-tierButton {\n\tflex-shrink: 0;\n\tmargin-left: auto;\n\tpadding: 1px 6px;\n\tborder: 1px solid var(--gc-stroke, #c4c7c5);\n\tborder-radius: 10px;\n\tbackground: transparent;\n\tcolor: var(--gc-text);\n\tfont: inherit;\n\tfont-size: 10px;\n\tline-height: 1.4;\n\twhite-space: nowrap;\n\tcursor: pointer;\n\topacity: 0.85;\n\ttransition: opacity 150ms ease;\n}\n\n.gc-tierButton:hover {\n\topacity: 1;\n}\n\n/* Gemini gradient fill.\n   The gradient must span the full bar, not the filled portion, or a 20% fill\n   would squash all five stops into a fifth of the bar. So the fill is always\n   full width and is revealed left-to-right with clip-path. */\n.cc-bar--gemini .cc-bar__fill {\n\twidth: 100%;\n\tbackground: linear-gradient(90deg, #1ba1e3 0%, #5489d6 25%, #9b72cb 50%, #d96570 75%, #f49c46 100%);\n\tclip-path: inset(0 calc(100% - var(--cc-pct, 0%)) 0 0);\n\ttransition: clip-path 300ms ease, background 300ms ease;\n\tborder-radius: max(0px, calc(var(--cc-radius) - 1px));\n}\n\n/* Near the cap, drop the gradient for the same solid red the context bar uses. */\n.cc-bar--gemini .cc-bar__fill.cc-warn {\n\tbackground: var(--cc-fill-warn);\n}\n\n.gc-tooltip {\n\tbackground: #1f1f1f;\n\tcolor: #e3e3e3;\n\tbox-shadow: 0 1px 3px rgb(0 0 0 / 30%);\n\tmax-width: 320px;\n}\n\n@media (prefers-color-scheme: light) {\n\t.gc-tooltip {\n\t\tbackground: #303030;\n\t\tcolor: #f1f3f4;\n\t}\n}\n";
})();


(() => {
	'use strict';
	if (location.hostname !== 'gemini.google.com') return;

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});
	const STYLE_ID = 'gc-userscript-styles';

	// The extension ships styles.css via the manifest; the userscript must
	// inject the same stylesheet itself.
	GC.injectStyles = function injectStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = GC.__STYLES;
		(document.head || document.documentElement).appendChild(style);
	};
})();


(() => {
	'use strict';
	if (location.hostname !== 'gemini.google.com') return;

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	class BridgeClient {
		constructor() {
			this._listeners = new Map();

			window.addEventListener('message', (event) => {
				if (event.source !== window) return;
				const data = event.data;
				if (!data || data.gc !== GC.CONST.MARKER) return;
				this._emit(data.type, data.payload);
			});
		}

		_emit(type, payload) {
			const listeners = this._listeners.get(type);
			if (!listeners) return;
			for (const fn of listeners) {
				try {
					fn(payload);
				} catch {
					// one bad listener must not stop the others
				}
			}
		}

		on(type, fn) {
			if (!this._listeners.has(type)) this._listeners.set(type, new Set());
			this._listeners.get(type).add(fn);
			return () => this._listeners.get(type)?.delete(fn);
		}
	}

	let bridgeReadyPromise = null;

	// Userscript build: run the bridge inline rather than injecting a script.
	GC.injectBridgeOnce = function () {
		if (bridgeReadyPromise) return bridgeReadyPromise;
		bridgeReadyPromise = Promise.resolve(true);

		(() => {
			'use strict';

			const GC_MARKER = 'GeminiCounter';

			// Gemini's generate RPC. Matched strictly: batchexecute also carries title
			// generation, history sync and other chatter, so a loose match would count
			// prompts the user never sent. If Google renames this, the content script's
			// DOM fallback still catches the send.
			const GENERATE_PATTERNS = [
				/BardFrontendService\/StreamGenerate/i,
				/\/StreamGenerate(\?|$)/i
			];

			function isGenerateRequest(url, method) {
				if (!url || String(method || 'GET').toUpperCase() !== 'POST') return false;
				return GENERATE_PATTERNS.some((re) => re.test(url));
			}

			function post(type, payload) {
				try {
					window.postMessage({ gc: GC_MARKER, type, payload }, '*');
				} catch {
					// ignore
				}
			}

			function toAbsoluteUrl(input) {
				try {
					if (typeof input === 'string') return new URL(input, location.href).href;
					if (input instanceof URL) return input.href;
					if (input instanceof Request) return input.url;
				} catch {
					// ignore
				}
				return '';
			}

			// --- SPA navigation -------------------------------------------------------
			// Wrapped early, before Angular caches the originals.
			const originalPushState = history.pushState.bind(history);
			const originalReplaceState = history.replaceState.bind(history);

			history.pushState = function (...args) {
				const result = originalPushState(...args);
				window.dispatchEvent(new CustomEvent('gc:urlchange'));
				return result;
			};

			history.replaceState = function (...args) {
				const result = originalReplaceState(...args);
				window.dispatchEvent(new CustomEvent('gc:urlchange'));
				return result;
			};

			// --- fetch ----------------------------------------------------------------
			const originalFetch = window.fetch;

			if (typeof originalFetch === 'function') {
				window.fetch = function (...args) {
					try {
						const url = toAbsoluteUrl(args[0]);
						const method = args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET');
						if (isGenerateRequest(url, method)) {
							post('gc:prompt_sent', { url, at: Date.now(), source: 'fetch' });
						}
					} catch {
						// never break the host page
					}
					return originalFetch.apply(this, args);
				};
			}

			// --- XMLHttpRequest -------------------------------------------------------
			// Gemini has historically used XHR for chat RPCs, so a fetch-only wrapper
			// would miss sends entirely.
			const XHR = window.XMLHttpRequest;
			if (XHR?.prototype) {
				const originalOpen = XHR.prototype.open;
				const originalSend = XHR.prototype.send;

				XHR.prototype.open = function (method, url, ...rest) {
					try {
						this.__gcMethod = method;
						this.__gcUrl = toAbsoluteUrl(url);
					} catch {
						// ignore
					}
					return originalOpen.call(this, method, url, ...rest);
				};

				XHR.prototype.send = function (...args) {
					try {
						if (isGenerateRequest(this.__gcUrl, this.__gcMethod)) {
							post('gc:prompt_sent', { url: this.__gcUrl, at: Date.now(), source: 'xhr' });
						}
					} catch {
						// never break the host page
					}
					return originalSend.apply(this, args);
				};
			}

			post('gc:bridge_ready', {});
		})();

		return bridgeReadyPromise;
	};

	GC.bridge = new BridgeClient();
})();


(() => {
	'use strict';
	if (location.hostname !== 'gemini.google.com') return;

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	// chrome.storage.local with a localStorage fallback; see the shared CCStore
	// IIFE at the top of this file.
	const store = globalThis.CCStore;

	function emptyWindow() {
		return { start: null, credits: 0 };
	}

	function sanitizeWindow(w) {
		if (!w || typeof w !== 'object') return emptyWindow();
		const start = typeof w.start === 'number' && Number.isFinite(w.start) ? w.start : null;
		const credits = typeof w.credits === 'number' && Number.isFinite(w.credits) && w.credits > 0 ? w.credits : 0;
		// A window with credits but no anchor is meaningless; drop both.
		if (start === null) return emptyWindow();
		return { start, credits };
	}

	/**
	 * Estimates Gemini usage locally.
	 *
	 * Gemini exposes no usage endpoint, so usage is inferred from prompts the
	 * user sends, weighted per model. Windows are *anchored*, mirroring Claude:
	 * the window opens on the first prompt after the previous one expired and
	 * closes a fixed span later, which gives us a real resets_at for the
	 * countdown and the window-progress marker.
	 */
	class UsageEstimator {
		constructor() {
			this.state = {
				fiveHour: emptyWindow(),
				sevenDay: emptyWindow(),
				tier: GC.DEFAULT_TIER
			};
			this.loaded = false;
			this._saveTimer = null;
		}

		async load() {
			const raw = await store.get(GC.CONST.STORAGE_KEY);
			if (raw && typeof raw === 'object') {
				this.state.fiveHour = sanitizeWindow(raw.fiveHour);
				this.state.sevenDay = sanitizeWindow(raw.sevenDay);
				this.state.tier = GC.TIERS.includes(raw.tier) ? raw.tier : GC.DEFAULT_TIER;
			}
			this.loaded = true;
			this.roll();
			return this.state;
		}

		_scheduleSave() {
			if (this._saveTimer) clearTimeout(this._saveTimer);
			this._saveTimer = setTimeout(() => {
				this._saveTimer = null;
				store.set(GC.CONST.STORAGE_KEY, this.state);
			}, 250);
		}

		/** Expire any window whose span has elapsed. Returns true if anything reset. */
		roll(now = Date.now()) {
			let changed = false;

			const expire = (win, spanMs) => {
				if (win.start !== null && now >= win.start + spanMs) {
					win.start = null;
					win.credits = 0;
					return true;
				}
				return false;
			};

			if (expire(this.state.fiveHour, GC.CONST.FIVE_HOUR_MS)) changed = true;
			if (expire(this.state.sevenDay, GC.CONST.SEVEN_DAY_MS)) changed = true;

			if (changed) this._scheduleSave();
			return changed;
		}

		/**
		 * @param {string} model - normalized model key (flash | pro | thinking)
		 * @param {string[]} [features] - keys into GC.FEATURE_WEIGHTS
		 */
		creditsFor(model, features = []) {
			const base = GC.MODEL_WEIGHTS[model] ?? GC.MODEL_WEIGHTS[GC.DEFAULT_MODEL];
			let cost = base;
			for (const f of features) {
				const extra = GC.FEATURE_WEIGHTS[f];
				if (typeof extra === 'number') cost += extra;
			}
			return cost;
		}

		record({ model = GC.DEFAULT_MODEL, features = [] } = {}, now = Date.now()) {
			this.roll(now);
			const cost = this.creditsFor(model, features);

			for (const win of [this.state.fiveHour, this.state.sevenDay]) {
				if (win.start === null) win.start = now;
				win.credits += cost;
			}

			this._scheduleSave();
			return cost;
		}

		getTier() {
			return this.state.tier;
		}

		setTier(tier) {
			if (!GC.TIERS.includes(tier)) return;
			this.state.tier = tier;
			this._scheduleSave();
		}

		cycleTier() {
			const idx = GC.TIERS.indexOf(this.state.tier);
			const next = GC.TIERS[(idx + 1) % GC.TIERS.length];
			this.setTier(next);
			return next;
		}

		budgets() {
			const fiveHour = GC.TIER_BUDGETS[this.state.tier] ?? GC.TIER_BUDGETS[GC.DEFAULT_TIER];
			return { fiveHour, sevenDay: fiveHour * GC.WEEKLY_MULTIPLIER };
		}

		/**
		 * Snapshot shaped like the Claude module's normalized usage object, so
		 * the UI reads utilization (0-100) and resets_at the same way.
		 */
		snapshot(now = Date.now()) {
			this.roll(now);
			const budget = this.budgets();

			const build = (win, spanMs, limit) => {
				const utilization = limit > 0 ? Math.max(0, Math.min(100, (win.credits / limit) * 100)) : 0;
				return {
					utilization,
					credits: win.credits,
					limit,
					window_start: win.start,
					resets_at: win.start !== null ? win.start + spanMs : null,
					window_ms: spanMs
				};
			};

			return {
				five_hour: build(this.state.fiveHour, GC.CONST.FIVE_HOUR_MS, budget.fiveHour),
				seven_day: build(this.state.sevenDay, GC.CONST.SEVEN_DAY_MS, budget.sevenDay),
				tier: this.state.tier
			};
		}
	}

	GC.UsageEstimator = UsageEstimator;
})();


(() => {
	'use strict';
	if (location.hostname !== 'gemini.google.com') return;

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	function formatResetCountdown(timestampMs) {
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'cc-tooltip gc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-gc-tooltip-setup')) return;
		element.setAttribute('data-gc-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});
		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});
		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});
		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});
	}

	function queryFirst(selectors) {
		for (const sel of selectors) {
			try {
				const el = document.querySelector(sel);
				if (el) return el;
			} catch {
				// invalid selector for this browser; try the next
			}
		}
		return null;
	}

	GC.queryFirst = queryFirst;

	/**
	 * Gemini has no stable test ids, so find the composer via a priority list
	 * and then walk up to its outer wrapper. Inserting after `.ql-editor` alone
	 * would drop the row *inside* the input box.
	 */
	function findComposerAnchor() {
		const OUTER_TAGS = new Set(['INPUT-AREA-V2', 'INPUT-CONTAINER']);

		const el = queryFirst(GC.DOM.COMPOSER);
		if (!el) return null;
		if (OUTER_TAGS.has(el.tagName)) return el;

		// Climb while the box keeps getting wider, stopping before we reach a
		// container tall enough to be the whole chat panel.
		let best = el;
		let cur = el.parentElement;
		let hops = 0;
		const maxHeight = window.innerHeight * 0.5;

		while (cur && cur !== document.body && hops < 8) {
			if (OUTER_TAGS.has(cur.tagName)) return cur;
			const rect = cur.getBoundingClientRect();
			if (rect.height > maxHeight) break;
			if (rect.width > best.getBoundingClientRect().width) best = cur;
			cur = cur.parentElement;
			hops += 1;
		}

		return best;
	}

	class GeminiUsageUI {
		constructor({ onTierCycle } = {}) {
			this.onTierCycle = onTierCycle || null;

			this.row = null;
			this.groups = {};
			this.tierButton = null;
			this.domObserver = null;
			this.snapshot = null;

			this._reattachPending = false;
		}

		isDark() {
			const cls = `${document.body?.className || ''} ${document.documentElement?.className || ''}`;
			if (/\bdark[-_]?theme\b/i.test(cls)) return true;
			if (/\blight[-_]?theme\b/i.test(cls)) return false;
			return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
		}

		refreshChrome() {
			if (!this.row) return;
			const dark = this.isDark();
			const stroke = dark ? GC.COLORS.TRACK_DARK : GC.COLORS.TRACK_LIGHT;
			const marker = dark ? GC.COLORS.MARKER_DARK : GC.COLORS.MARKER_LIGHT;

			this.row.style.setProperty('--gc-text', dark ? GC.COLORS.TEXT_DARK : GC.COLORS.TEXT_LIGHT);
			this.row.style.setProperty('--gc-stroke', stroke);

			// .cc-bar declares --cc-stroke/--cc-marker/--cc-fill-warn on itself,
			// which shadows anything inherited from the row, so these have to be
			// set per bar (inline style wins over the stylesheet declaration).
			for (const key of ['five_hour', 'seven_day']) {
				const bar = this.groups[key]?.bar;
				if (!bar) continue;
				bar.style.setProperty('--cc-stroke', stroke);
				bar.style.setProperty('--cc-marker', marker);
				bar.style.setProperty('--cc-fill-warn', GC.COLORS.RED_WARNING);
			}
		}

		initialize() {
			this._buildRow();
			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_buildBar() {
			const bar = document.createElement('div');
			bar.className = 'cc-bar cc-bar--usage cc-bar--gemini';

			const fill = document.createElement('div');
			fill.className = 'cc-bar__fill';
			fill.style.setProperty('--cc-pct', '0%');

			const marker = document.createElement('div');
			marker.className = 'cc-bar__marker cc-hidden';
			marker.style.left = '0%';

			bar.appendChild(fill);
			bar.appendChild(marker);
			return { bar, fill, marker };
		}

		_buildRow() {
			this.row = document.createElement('div');
			this.row.className = 'gc-usageRow cc-hidden';

			for (const key of ['five_hour', 'seven_day']) {
				const label = document.createElement('span');
				label.className = 'gc-usageText';

				const { bar, fill, marker } = this._buildBar();

				const group = document.createElement('div');
				group.className = 'gc-usageGroup';
				group.appendChild(label);
				group.appendChild(bar);

				this.groups[key] = { group, label, bar, fill, marker, resetMs: null, startMs: null };
				this.row.appendChild(group);
			}

			this.tierButton = document.createElement('button');
			this.tierButton.type = 'button';
			this.tierButton.className = 'gc-tierButton';
			this.tierButton.textContent = 'Pro · est.';
			this.tierButton.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.onTierCycle?.();
			});
			this.row.appendChild(this.tierButton);

			this.refreshChrome();
		}

		_setupTooltips() {
			setupTooltip(
				this.groups.five_hour.group,
				makeTooltip(
					'Estimated 5-hour usage window.\nThe bar shows your usage; the line marks where you are in the window.\nGemini publishes no usage API, so this is estimated from prompts you send, weighted by model.'
				),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.groups.seven_day.group,
				makeTooltip(
					'Estimated weekly usage window.\nGemini refreshes your limit every 5 hours until you reach this weekly cap.\nEstimated locally, not read from Google.'
				),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.tierButton,
				makeTooltip('Your Google AI plan. Click to cycle Free / Pro / Ultra.\nThis scales the estimated budget.\n"est." is a reminder that these numbers are estimates.'),
				{ topOffset: 8 }
			);
		}

		_observeTheme() {
			const observer = new MutationObserver(() => this.refreshChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
			if (document.body) {
				observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
			}
			window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.refreshChrome());
		}

		_observeDom() {
			this.domObserver = new MutationObserver(() => {
				if (!this.row || document.contains(this.row) || this._reattachPending) return;
				this._reattachPending = true;
				// Let the SPA finish its re-render before hunting for the anchor.
				setTimeout(() => {
					this._reattachPending = false;
					this.attach();
				}, 200);
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		attach() {
			if (!this.row) return false;
			const anchor = findComposerAnchor();
			if (!anchor) return false;
			if (anchor.nextElementSibling !== this.row) {
				anchor.after(this.row);
			}
			this.refreshChrome();
			return true;
		}

		setTierLabel(tier) {
			if (!this.tierButton) return;
			this.tierButton.textContent = `${GC.TIER_NAMES[tier] || tier} · est.`;
		}

		setUsage(snapshot) {
			if (!snapshot) return;
			this.snapshot = snapshot;
			this.refreshChrome();
			this.setTierLabel(snapshot.tier);

			// Always visible: a 0% bar is useful information on Gemini, where
			// there is no native usage display at all.
			this.row?.classList.remove('cc-hidden');

			const labels = { five_hour: '5h', seven_day: 'Weekly' };

			for (const key of ['five_hour', 'seven_day']) {
				const g = this.groups[key];
				const win = snapshot[key];
				if (!g || !win) continue;

				const rawPct = typeof win.utilization === 'number' ? win.utilization : 0;
				const pct = Math.round(rawPct * 10) / 10;
				const width = Math.max(0, Math.min(100, rawPct));

				g.resetMs = win.resets_at;
				g.startMs = win.window_start;

				const resetText = g.resetMs ? ` · resets in ${formatResetCountdown(g.resetMs)}` : '';
				g.label.textContent = `${labels[key]}: ${pct}%${resetText}`;

				g.fill.style.setProperty('--cc-pct', `${width}%`);
				g.fill.classList.toggle('cc-warn', width >= 90);
				g.fill.classList.toggle('cc-full', width >= 99.5);
			}

			this._updateMarkers();
		}

		_updateMarkers() {
			const now = Date.now();
			for (const key of ['five_hour', 'seven_day']) {
				const g = this.groups[key];
				if (!g?.marker) continue;

				if (g.startMs && g.resetMs && g.resetMs > g.startMs) {
					const total = g.resetMs - g.startMs;
					const elapsed = Math.max(0, Math.min(total, now - g.startMs));
					const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));
					g.marker.classList.remove('cc-hidden');
					g.marker.style.left = `${pct}%`;
				} else {
					g.marker.classList.add('cc-hidden');
				}
			}
		}

		tick() {
			for (const key of ['five_hour', 'seven_day']) {
				const g = this.groups[key];
				if (!g?.resetMs || !g.label.textContent) continue;
				const idx = g.label.textContent.indexOf('· resets in');
				if (idx === -1) continue;
				const prefix = g.label.textContent.slice(0, idx + '· resets in '.length);
				g.label.textContent = `${prefix}${formatResetCountdown(g.resetMs)}`;
			}
			this._updateMarkers();
		}
	}

	GC.ui = { GeminiUsageUI, formatResetCountdown };
})();


(() => {
	'use strict';
	if (location.hostname !== 'gemini.google.com') return;

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});
	if (GC.__started) return;
	GC.__started = true;

	// Inject before anything else so the bridge wraps fetch/XHR ahead of Angular.
	const bridgeReady = GC.injectBridgeOnce();

	const estimator = new GC.UsageEstimator();
	let ui = null;

	function whenBodyReady() {
		if (document.body) return Promise.resolve();
		return new Promise((resolve) => {
			document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
		});
	}

	/** Resolve once the composer anchor exists, or null on timeout. */
	function waitForAnchor(timeoutMs = 60000) {
		return new Promise((resolve) => {
			if (ui?.attach()) {
				resolve(true);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				if (ui?.attach()) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(true);
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });

			timeoutId = setTimeout(() => {
				observer.disconnect();
				resolve(false);
			}, timeoutMs);
		});
	}

	// --- Model + feature detection -------------------------------------------

	function normalizeModelName(raw) {
		if (!raw || typeof raw !== 'string') return null;
		const lower = raw.toLowerCase();
		// Order matters: "3.1 Pro Thinking" is a thinking model, not a pro one.
		if (lower.includes('thinking') || lower.includes('deep think')) return 'thinking';
		if (lower.includes('flash') || lower.includes('fast')) return 'flash';
		if (lower.includes('pro')) return 'pro';
		return null;
	}

	function detectModel() {
		const el = GC.queryFirst(GC.DOM.MODEL_PICKER);
		if (el) {
			const m = normalizeModelName(el.textContent || '');
			if (m) return m;
		}
		return GC.DEFAULT_MODEL;
	}

	const FEATURE_PATTERNS = [
		{ key: 'deepResearch', re: /deep research/i },
		{ key: 'imageGen', re: /create image|image generation|nano banana/i },
		{ key: 'video', re: /\bveo\b|create video|video generation/i }
	];

	/** Best-effort: which expensive tool chips are toggled on right now. */
	function detectFeatures() {
		const found = new Set();
		let candidates;
		try {
			candidates = document.querySelectorAll(
				'[aria-pressed="true"], [aria-selected="true"], .is-selected, .toolbox-drawer-item-button.is-selected'
			);
		} catch {
			return [];
		}

		for (const el of candidates) {
			const text = el.textContent || el.getAttribute('aria-label') || '';
			if (!text) continue;
			for (const { key, re } of FEATURE_PATTERNS) {
				if (re.test(text)) found.add(key);
			}
		}
		return Array.from(found);
	}

	// --- Send detection -------------------------------------------------------
	// A prompt can be signalled twice: by the network interceptor and by the DOM
	// fallback. Both feed one "send cycle", which commits at most once.

	let cycle = null;

	function commit(c) {
		if (!c || c.counted) return;
		c.counted = true;
		if (c.timer) {
			clearTimeout(c.timer);
			c.timer = null;
		}
		estimator.record({ model: detectModel(), features: detectFeatures() });
		render();
	}

	function signalSend(source) {
		const now = Date.now();

		if (cycle && now - cycle.openedAt < GC.CONST.SEND_DEDUPE_MS) {
			// The network is the trustworthy signal; if it lands while the DOM
			// fallback is still pending, commit now instead of waiting it out.
			if (source === 'network' && !cycle.counted) commit(cycle);
			return;
		}

		cycle = { openedAt: now, counted: false, timer: null };

		if (source === 'network') {
			commit(cycle);
		} else {
			const c = cycle;
			c.timer = setTimeout(() => commit(c), GC.CONST.DOM_FALLBACK_MS);
		}
	}

	function isSendAction(target) {
		if (!(target instanceof Element)) return false;
		for (const sel of GC.DOM.SEND_BUTTON) {
			try {
				if (target.closest(sel)) return true;
			} catch {
				// invalid selector; skip
			}
		}
		return false;
	}

	function installDomFallback() {
		document.addEventListener(
			'click',
			(e) => {
				if (isSendAction(e.target)) signalSend('dom');
			},
			true
		);

		document.addEventListener(
			'keydown',
			(e) => {
				if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
				const el = e.target;
				if (!(el instanceof Element)) return;
				const editable = el.closest('[contenteditable="true"], textarea, rich-textarea');
				if (editable) signalSend('dom');
			},
			true
		);
	}

	// --- Render ---------------------------------------------------------------

	function render() {
		if (!ui) return;
		ui.setUsage(estimator.snapshot());
	}

	// --- Boot -----------------------------------------------------------------

	async function boot() {
		await whenBodyReady();
		GC.injectStyles();
		await estimator.load();

		ui = new GC.ui.GeminiUsageUI({
			onTierCycle: () => {
				estimator.cycleTier();
				render();
			}
		});
		ui.initialize();

		render();
		waitForAnchor();

		installDomFallback();

		await bridgeReady;
		GC.bridge.on('gc:prompt_sent', () => signalSend('network'));

		const onUrlChange = () => waitForAnchor(30000);
		window.addEventListener('gc:urlchange', onUrlChange);
		window.addEventListener('popstate', onUrlChange);

		setInterval(() => {
			// roll() zeroes an expired window; re-render so the bar drops to 0
			// even if the user has not sent anything since.
			if (estimator.roll()) render();
			ui.tick();
		}, 1000);
	}

	boot();
})();
