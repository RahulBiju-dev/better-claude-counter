(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

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

	/**
	 * Wait for an element to appear in the DOM using MutationObserver.
	 * More efficient than polling - reacts immediately when element appears.
	 * @param {string} selector - CSS selector
	 * @param {number} [timeoutMs] - Optional timeout in ms. Returns null if timeout expires.
	 */
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

	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;

		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				callback();
			}
		};

		// Listen for custom event from bridge (history methods wrapped early)
		window.addEventListener('cc:urlchange', fireIfChanged);
		// Also popstate for back/forward buttons
		window.addEventListener('popstate', fireIfChanged);

		return () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};
	}

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

	let usageState = null; // last snapshot
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
	ui.initialize();

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();

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

	/**
	 * @param {{force?: boolean}} [opts] force skips the min-interval floor; used
	 *   only for the explicit click-to-refresh, never for automatic triggers.
	 */
	async function refreshUsage({ force = false } = {}) {
		await bridgeReady;
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
			raw = await CC.bridge.requestUsage(orgId);
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
		await bridgeReady;
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			await CC.bridge.requestConversation(orgId, currentConversationId);
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

	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:generation_end', handleGenerationEnd);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) return;
		if (Date.now() - lastUsageUpdateMs > CC.CONST.USAGE_STALE_ON_VISIBLE_MS) {
			refreshUsage();
		}
	});

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		// Attach usage line and header independently - they have different anchor elements
		// and CHAT_MENU_TRIGGER doesn't exist on home/new pages
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

		// Best-effort orgId from cookie.
		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		// Usage is org-level, not conversation-level.
		if (!usageState) {
			await refreshUsage();
		} else {
			renderUsage();
		}
	}

	const unobserveUrl = observeUrlChanges(handleUrlChange);
	window.addEventListener('beforeunload', unobserveUrl);

	// Refresh on branch navigation - watch for the branch indicator to change
	let branchObserver = null;
	document.addEventListener('click', (e) => {
		if (!currentConversationId) return;
		const btn = e.target.closest('button[aria-label="Previous"], button[aria-label="Next"]');
		if (!btn) return;

		// Find the branch indicator span (matches "X / Y" pattern) near the clicked button
		const container = btn.closest('.inline-flex');
		const spans = container?.querySelectorAll('span') || [];
		const indicator = Array.from(spans).find((s) => /^\d+\s*\/\s*\d+$/.test(s.textContent.trim()));
		if (!indicator) return;

		const originalText = indicator.textContent;

		// Clean up any existing observer
		if (branchObserver) branchObserver.disconnect();

		// Watch for the indicator text to change (with cleanup timeout)
		branchObserver = new MutationObserver(() => {
			if (indicator.textContent !== originalText) {
				branchObserver.disconnect();
				branchObserver = null;
				refreshConversation();
			}
		});

		branchObserver.observe(indicator, { childList: true, characterData: true, subtree: true });

		// Clean up if nothing changes after 60 seconds
		setTimeout(() => {
			if (branchObserver) {
				branchObserver.disconnect();
				branchObserver = null;
			}
		}, 60000);
	});

	// Initial attach + fetches
	async function boot() {
		// The stored plan gates which bars render, so load it before the first paint.
		await CC.plan.load();
		ui.setPlan(CC.plan.get());

		handleUrlChange();

		await bridgeReady;
		if (await CC.plan.detect({ orgId: currentOrgId || getOrgIdFromCookie() })) {
			renderUsage();
		}
	}

	boot();

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

	// Keep countdowns + markers updated.
	setInterval(tick, 1000);
})();
