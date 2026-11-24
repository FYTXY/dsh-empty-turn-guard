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
		/**
		 * The switches this card renders, in the order the Host schema lists them.
		 * `enabled` stays first: it is the master switch, and the other five only
		 * narrow which judgements run while it is on.
		 */
		const SWITCHES = [
			{ field: "enabled" },
			{ field: "toolCallResidue" },
			{ field: "narrationStop" },
			{ field: "streamStall" },
			{ field: "repetition" },
			{ field: "thinkingLeak" }
		];
		/** English copy. */
		const en = {
			title: "Empty-turn guard",
			tab: "Empty-turn guard",
			description: "Retries a step that broke instead of ending the turn on it.",
			enabled: "Guard this turn",
			enabledHint:
				"A step that cannot be a finished answer becomes a retryable error, so the harness retries it with backoff instead of showing a half reply and a continue button.",
			toolCallResidue: "Leaked tool-call markup",
			toolCallResidueHint:
				"The reply is prose followed by tool-call markup that never became a call — the “stopped halfway” case. Markup quoted inside an explanation is left alone.",
			narrationStop: "Announced but never called",
			narrationStopHint:
				"The reply ends on a short line announcing the next tool call (“reading lines 4320-4429 now.”) and then stops, so nothing was actually run. Only a bare one-clause announcement counts; an answer that offers to continue is left alone.",
			streamStall: "Stalled or truncated stream",
			streamStallHint:
				"Retries when the model stream sends nothing for 90 seconds, or ends without saying how it finished.",
			repetition: "Repeated empty thinking",
			repetitionHint:
				"Cut off a model looping on empty <thinking> pairs instead of generating the whole loop before retrying.",
			thinkingLeak: "Leaked chain of thought",
			thinkingLeakHint:
				"Off by default. Retries a short reply that is entirely unterminated thinking; a long reply in that shape may be a complete answer that merely lost its closing tag.",
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
			description: "某一步崩掉时自动重试，而不是就此结束回合。",
			enabled: "守卫本轮",
			enabledHint:
				"当某一步不可能是一条正常回答时，把它判成可重试的错误，让宿主带退避重试，而不是给你半条回复加一个「继续」按钮。",
			toolCallResidue: "工具调用残骸",
			toolCallResidueHint:
				"正文之后拖着一段没能变成工具调用的协议标记——就是「输出一半卡死」。解释里引用这些标记的正常回答不会被动。",
			narrationStop: "只说不做",
			narrationStopHint:
				"回复以一句宣告结束——「读 L4320-4429 区间和 L2667 附近（main）。」——然后就没有了，工具根本没调用。只认单独成句的短宣告；问你「要不要我继续」这类正常收尾不会被动。",
			streamStall: "流卡死与截断",
			streamStallHint:
				"模型流 90 秒没有任何新内容，或结束了却没报告怎么结束的，都会重试。",
			repetition: "空 thinking 刷屏",
			repetitionHint:
				"模型在空 <thinking> 对上死循环时直接切断，不必先把它整段生成完再重试。",
			thinkingLeak: "思考泄漏",
			thinkingLeakHint:
				"默认关闭。只拦「整条回复就是一个没闭合的 thinking」的短回复；同样形态的长回复可能只是掉了闭合标签的完整答案，所以放过。",
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
		 * One labelled row: name, explanation, current state, and the switch.
		 *
		 * A plain factory, not a component: the row is one static tree with no
		 * state of its own, and building it eagerly keeps the switch reachable by
		 * anything walking the returned element.
		 *
		 * @param props - the localized copy, the field's snapshot, and the actions.
		 * @returns the row element.
		 */
		function switchRow(props) {
			const t = props.t;
			const spec = props.spec;
			const field = props.field;
			const checked = field !== void 0 && field.text === "true";
			return react.createElement(
				"div",
				{
					key: spec.field,
					style: {
						display: "flex",
						alignItems: "flex-start",
						justifyContent: "space-between",
						gap: "12px",
						paddingTop: spec.field === "enabled" ? void 0 : "12px",
						borderTop: spec.field === "enabled" ? void 0 : "1px solid rgba(128,128,128,0.18)"
					}
				},
				react.createElement("div", { style: { minWidth: 0 } }, [
					react.createElement(
						"div",
						{ key: "label", style: { fontSize: "13px", fontWeight: 500 } },
						t(spec.field)
					),
					react.createElement(
						"div",
						{ key: "hint", style: { fontSize: "12px", opacity: 0.7, marginTop: "2px" } },
						t(spec.field + "Hint")
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
					label: t(spec.field),
					disabled: !props.writable,
					onChange: (next) => {
						props.edit(spec.field, next ? "true" : "false");
					}
				})
			);
		}
		/**
		 * Render the guard's card: a one-liner for the Plugins row, or the form.
		 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
		 * @returns the one-liner, or the switches inside the shared settings frame.
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
			const rows = SWITCHES.map((spec) =>
				switchRow({
					key: spec.field,
					t,
					spec,
					field: state[spec.field],
					writable: state.writable,
					edit: props.edit
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
				rows
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
				this.form = new primitives.SettingsFormModel(
					scope,
					SWITCHES.map((spec) => settingsBooleanField(spec.field))
				);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				const rows = {};
				for (const spec of SWITCHES) rows[spec.field] = this.form.field(spec.field);
				return {
					...this.form.shell(),
					...rows
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
		 * Settings → Built-in plugins, so both entry points reach the same switches.
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
