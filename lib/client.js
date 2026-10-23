window.__ModuleLoader__.load({
	id: "dsh-empty-turn-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		/**
		 * Namespace of the guard's user-owned settings.
		 * Spelled here rather than imported: a client package must not depend on a
		 * Host package. It equals the plugin row's `id` in cordis.patch.yml,
		 * because dsh-settings names a namespace after the row id.
		 */
		const HOST_NS = "dsh-empty-turn-guard";
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.emptyTurnGuard";
		/** English copy. */
		const en = {
			title: "Empty-turn guard",
			tab: "Empty-turn guard",
			description: "Retries a reply whose whole content is protocol markup.",
			enabled: "Retry markup-only replies",
			enabledHint:
				"When the model ends a step with nothing but DSML/thinking leftovers (or punctuation), the step becomes a retryable empty response instead of a finished turn.",
			stateOn: "On",
			stateOff: "Off",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct."
		};
		/** Simplified Chinese copy. */
		const zh = {
			title: "空回合守卫",
			tab: "空回合守卫",
			description: "整条回复只剩协议残渣时自动重试。",
			enabled: "残渣空回合自动重试",
			enabledHint:
				"当某一步的正文只剩 DSML／thinking 残渣（或纯标点）时，把它判成可重试的空回复，而不是当作正常说完结束回合。",
			stateOn: "已开启",
			stateOff: "已关闭",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。"
		};
		/**
		 * The form frame's copy, read from this page's dictionary.
		 * @param t - the page's locale reader.
		 * @returns the labels the shared settings form renders.
		 */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		/**
		 * A switch-backed boolean field over the namespace section.
		 * Shaped like the shared `settingsTextField`/`settingsNumberField` specs so
		 * the staged form can diff, format and parse it the same way.
		 * @param field - field name inside the namespace section.
		 * @returns the field's conversion spec.
		 */
		function settingsBooleanField(field) {
			return {
				field,
				format: (value) => (value === true ? "true" : value === false ? "false" : ""),
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "true") return { kind: "set", value: true };
					if (trimmed === "false") return { kind: "set", value: false };
					return { kind: "clear" };
				}
			};
		}
		/**
		 * Render the guard's card: a one-liner for the Plugins row, or the form.
		 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
		 * @returns the one-liner, or the switch inside the shared settings frame.
		 */
		function EmptyTurnGuardCard(props) {
			const t = typeof props.t === "function" ? props.t : props.copy;
			if (props.view === "summary") return t("description");
			const read = props.useEmptyTurnGuardCard !== void 0
				? props.useEmptyTurnGuardCard
				: props.hooks !== void 0 ? props.hooks.emptyTurnGuardCard : void 0;
			const state = typeof read === "function"
				? read((snapshot) => snapshot)
				: read !== void 0 && typeof read.getSnapshot === "function" ? read.getSnapshot() : void 0;
			if (state === void 0) return null;
			const checked = state.enabled !== void 0 && state.enabled.text === "true";
			const row = react.createElement(
				"div",
				{ style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" } },
				react.createElement("div", { style: { minWidth: 0 } }, [
					react.createElement(
						"div",
						{ key: "label", style: { fontSize: "13px", fontWeight: 500 } },
						t("enabled")
					),
					react.createElement(
						"div",
						{ key: "hint", style: { fontSize: "12px", opacity: 0.7, marginTop: "2px" } },
						t("enabledHint")
					),
					react.createElement(
						"div",
						{ key: "state", style: { fontSize: "12px", opacity: 0.55, marginTop: "4px" } },
						checked ? t("stateOn") : t("stateOff")
					)
				]),
				react.createElement(primitives.Switch, {
					key: "switch",
					checked,
					label: t("enabled"),
					disabled: !state.writable,
					onChange: (next) => {
						props.edit("enabled", next ? "true" : "false");
					}
				})
			);
			return react.createElement(
				primitives.SettingsForm,
				{
					labels: formLabels(t),
					state,
					onSave: props.save,
					onDiscard: props.discard
				},
				row
			);
		}
		/**
		 * Bridges the guard's settings scope onto the page's staged form.
		 */
		var EmptyTurnGuardCardController = class {
			form;
			store;
			/** @param scope - the bound settings scope for the guard's namespace. */
			constructor(scope) {
				this.form = new primitives.SettingsFormModel(scope, [settingsBooleanField("enabled")]);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					enabled: this.form.field("enabled")
				};
			}
			/**
			 * Build the face the slot registrations inject.
			 * @returns the page's snapshot and its form actions.
			 */
			inject() {
				return {
					hooks: { emptyTurnGuardCard: this.store },
					...this.form.actions()
				};
			}
			/** Release accepted-value subscriptions. */
			dispose() {
				this.form.dispose();
			}
		};
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"configForms"
		];
		/**
		 * Mount the guard's settings surface twice: as a card on the Plugins panel
		 * (where every configurable plugin lives) and as a tab under
		 * Settings → Built-in plugins, so both entry points reach the same switch.
		 * Both registrations wait until the Host serves the guard's namespace, so a
		 * deployment that never loads the plugin shows no trace of it.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			const copy = (key) => t(key);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "empty-turn-guard: dictionaries");
			const card = new EmptyTurnGuardCardController(ctx.configForms.get(HOST_NS));
			ctx.effect(() => () => {
				card.dispose();
			}, "empty-turn-guard: form subscription");
			ctx.effect(() => ctx.configForms.whileServed([HOST_NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
				name: "plugins.item",
				id: "empty-turn-guard",
				order: 60,
				label: () => t("title"),
				locale: NS,
				inject: () => ({
					copy,
					...card.inject()
				})
			}, EmptyTurnGuardCard))), "empty-turn-guard: plugins card");
			ctx.effect(() => ctx.configForms.whileServed([HOST_NS], () => ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "empty-turn-guard",
				order: 60,
				label: () => t("tab"),
				locale: NS,
				inject: () => ({
					copy,
					...card.inject()
				})
			}, EmptyTurnGuardCard))), "empty-turn-guard: settings tab");
		}
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
