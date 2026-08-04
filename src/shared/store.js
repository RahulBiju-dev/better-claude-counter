(() => {
	'use strict';

	// Shared by both site modules. Kept provider-agnostic on purpose: the Claude
	// module persists the user's plan, the Gemini module persists usage windows.
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
	 * (the userscript build has no extension APIs). Both are local-only.
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
