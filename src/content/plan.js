(() => {
	'use strict';

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

	/**
	 * Collect every org-shaped object out of the /api/bootstrap and
	 * /api/organizations payloads. Both have been reshaped by Anthropic before, so
	 * walk the plausible paths instead of trusting one.
	 */
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

	/** Prefer the org the user is actually in, if we can identify it. */
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

	/**
	 * The /usage response shape is the most reliable signal for *topology* (which
	 * windows exist) but cannot name the plan precisely, so it is only consulted
	 * after the account payloads have had their say.
	 */
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

		/**
		 * Detect from the account payloads. Best-effort throughout: a failure here
		 * just leaves the previous value (or the default) in place.
		 * @returns {Promise<boolean>} whether the detected plan changed
		 */
		async detect({ orgId } = {}) {
			let account = null;
			try {
				account = await CC.bridge.requestAccount();
			} catch (e) {
				debug('account fetch failed', e?.message || e);
				return false;
			}
			if (debugEnabled()) debug('raw account payload', account);

			const org = pickOrg(collectOrgs(account), orgId);
			if (debugEnabled()) debug('selected org', org);

			return this._setDetected(planFromOrg(org) || planFromDom());
		}

		/**
		 * Refine using the shape of a /usage response. Never downgrades a plan that
		 * a stronger source already established beyond what the shape proves.
		 * @returns {boolean} whether the detected plan changed
		 */
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
