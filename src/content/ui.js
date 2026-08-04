(() => {
	'use strict';

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
