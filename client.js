(() => {
  try {
    /* 富江破甲 (fujiang-armor) client half — realtime badge + runtime switch */
    window.__ModuleLoader__.load({
      id: "fujiang-armor",
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react = require("react");

        var inject = ["slots", "remote"];

        var ANIM_CSS = "@keyframes fujiangArmorPulse{0%,100%{box-shadow:0 0 2px rgba(16,185,129,.5);opacity:1}50%{box-shadow:0 0 14px rgba(16,185,129,1);opacity:.6}}@keyframes fujiangArmorFlash{0%{transform:scale(1)}30%{transform:scale(1.1)}100%{transform:scale(1)}}";

        var WRAP_STYLE = {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          flexWrap: "wrap",
          width: "100%"
        };
        var BADGE_STYLE = {
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          width: "fit-content",
          padding: "3px 10px",
          borderRadius: "6px",
          border: "1px solid rgba(16, 185, 129, 0.45)",
          background: "rgba(16, 185, 129, 0.12)",
          color: "inherit",
          fontSize: "11px",
          lineHeight: "16px",
          fontFamily: "inherit",
          userSelect: "none",
          whiteSpace: "nowrap"
        };
        var DOT_STYLE = {
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: "#10b981",
          flex: "none"
        };
        var BUTTON_STYLE = {
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "3px 8px",
          borderRadius: "6px",
          border: "1px solid rgba(127, 127, 127, 0.35)",
          background: "transparent",
          color: "inherit",
          fontSize: "11px",
          lineHeight: "16px",
          fontFamily: "inherit",
          cursor: "pointer",
          whiteSpace: "nowrap"
        };
        var ACTIVE_BUTTON_STYLE = Object.assign({}, BUTTON_STYLE, {
          border: "1px solid rgba(16, 185, 129, 0.55)",
          background: "rgba(16, 185, 129, 0.16)"
        });
        var OFF_BUTTON_STYLE = Object.assign({}, BUTTON_STYLE, {
          border: "1px solid rgba(239, 68, 68, 0.5)",
          background: "rgba(239, 68, 68, 0.12)"
        });
        var POPUP_STYLE = {
          display: "flex",
          alignItems: "center",
          gap: "6px",
          flexWrap: "wrap",
          width: "100%",
          justifyContent: "center",
          padding: "6px 8px",
          borderRadius: "6px",
          border: "1px dashed rgba(127, 127, 127, 0.4)",
          fontSize: "11px",
          lineHeight: "16px"
        };
        var FLASH_MS = 2500;
        var MODES = ["user", "legacy", "both"];

        // 宿主命令返回 { ok, value: { commandId, result } }，result.text 是本插件的 JSON。
        function parseState(result) {
          if (!result || !result.ok) return null;
          var value = result.value && result.value.result;
          if (!value || value.kind !== "success" || !value.text) return null;
          try {
            var parsed = JSON.parse(value.text);
            return parsed && typeof parsed === "object" ? parsed : null;
          } catch (err) {
            return null;
          }
        }

        function ArmorDock(props) {
          var useProjection = props.useProjection;
          var execute = props.execute;
          var armor = typeof useProjection === "function"
            ? useProjection("fujiang-armor")
            : undefined;

          var lastVerdictRef = react.useRef(null);
          var flashUntilRef = react.useRef(0);
          var tickPair = react.useState(0);
          var setTick = tickPair[1];
          var statePair = react.useState(null);
          var runtime = statePair[0];
          var setRuntime = statePair[1];
          var popupPair = react.useState(false);
          var showPopup = popupPair[0];
          var setShowPopup = popupPair[1];
          var aliveRef = react.useRef(true);
          var executeRef = react.useRef(execute);
          executeRef.current = execute;

          // 不把 execute 放进依赖：slot 每次注入可能给新函数引用，
          // 若 effect 跟着 run 重建会每帧重新请求 /fujiang status。
          function run(line) {
            var fn = executeRef.current;
            if (typeof fn !== "function") return Promise.resolve(null);
            try {
              return Promise.resolve(fn(line)).then(function (result) {
                var next = parseState(result);
                if (next && aliveRef.current) setRuntime(next);
                return next;
              }, function () { return null; });
            } catch (err) {
              return Promise.resolve(null);
            }
          }

          react.useEffect(function () {
            aliveRef.current = true;
            void run("/fujiang status");
            return function () { aliveRef.current = false; };
          }, []);

          react.useEffect(function () {
            var styleEl = null;
            if (!document.getElementById("fujiang-armor-css")) {
              styleEl = document.createElement("style");
              styleEl.id = "fujiang-armor-css";
              styleEl.textContent = ANIM_CSS;
              document.head.appendChild(styleEl);
            }
            return function () { if (styleEl) styleEl.remove(); };
          }, []);

          react.useEffect(function () {
            var v = armor && armor.verdict ? armor.verdict : null;
            if (v !== lastVerdictRef.current) {
              lastVerdictRef.current = v;
              if (v) flashUntilRef.current = Date.now() + FLASH_MS;
              setTick(Date.now());
            }
          }, [armor]);

          var running = !!(armor && armor.running);
          var words = armor && Array.isArray(armor.words) ? armor.words : [];
          var risk = armor && Array.isArray(armor.risk) ? armor.risk : [];
          var domain = armor && armor.domain ? armor.domain : null;
          var showVerdict = !running && lastVerdictRef.current !== null &&
            Date.now() < flashUntilRef.current;

          var enabled = !runtime || runtime.enabled !== false;
          var mode = runtime && runtime.mode ? runtime.mode : "user";

          var text = enabled ? "富江破甲已激活" : "富江破甲已关闭";
          var dotStyle = Object.assign({}, DOT_STYLE);
          var badgeStyle = Object.assign({}, BADGE_STYLE);

          if (!enabled) {
            badgeStyle.border = "1px solid rgba(127, 127, 127, 0.45)";
            badgeStyle.background = "rgba(127, 127, 127, 0.12)";
            dotStyle.background = "#9ca3af";
          } else if (running) {
            dotStyle.animation = "fujiangArmorPulse 1.2s ease-in-out infinite";
            text = "执行中…";
          } else if (showVerdict) {
            if (lastVerdictRef.current === "pass") {
              text = "✓ 通过" + (domain ? " · " + domain : "") + (risk.length ? " · 载荷x" + risk.length : "");
              badgeStyle.animation = "fujiangArmorFlash 1.2s ease";
            } else {
              text = "✗ " + (words[0] || "触发安全拒绝");
              badgeStyle.animation = "fujiangArmorFlash 1.6s ease";
              badgeStyle.borderColor = "rgba(239, 68, 68, 0.5)";
              badgeStyle.background = "rgba(239, 68, 68, 0.12)";
              dotStyle.background = "#ef4444";
            }
          }

          function onToggle() {
            if (enabled) {
              setShowPopup(true);
              return;
            }
            setShowPopup(false);
            void run("/fujiang on");
          }

          function offWith(how) {
            setShowPopup(false);
            void run("/fujiang off " + how);
          }

          var children = [
            react.createElement(
              "div",
              { key: "badge", style: badgeStyle, "data-armor": enabled ? "on" : "off", "data-plugin": "fujiang-armor", title: text },
              react.createElement("span", { style: dotStyle }),
              react.createElement("span", null, text)
            )
          ];

          if (typeof execute === "function") {
            children.push(react.createElement(
              "button",
              {
                key: "switch",
                type: "button",
                style: enabled ? BUTTON_STYLE : OFF_BUTTON_STYLE,
                onClick: onToggle,
                title: enabled ? "关闭富江破甲（全局）" : "打开富江破甲（全局）"
              },
              enabled ? "关闭" : "打开"
            ));
            children.push(react.createElement(
              "span",
              { key: "mode", style: { display: "inline-flex", gap: "4px" } },
              MODES.map(function (item) {
                return react.createElement(
                  "button",
                  {
                    key: item,
                    type: "button",
                    style: item === mode ? ACTIVE_BUTTON_STYLE : BUTTON_STYLE,
                    onClick: function () { void run("/fujiang mode " + item); },
                    title: "注入模式：" + item
                  },
                  item
                );
              })
            ));
          }

          if (showPopup) {
            children.push(react.createElement(
              "div",
              { key: "popup", style: POPUP_STYLE },
              react.createElement("span", null, "关闭方式："),
              react.createElement("button", {
                type: "button", style: OFF_BUTTON_STYLE, title: "立即作废：往当前会话追加一条「内核作废」提醒",
                onClick: function () { offWith("hard"); }
              }, "硬关 · 立即作废"),
              react.createElement("button", {
                type: "button", style: BUTTON_STYLE, title: "只停止后续注入；历史里那条内核仍在，直到压缩或开新会话",
                onClick: function () { offWith("soft"); }
              }, "软关 · 只管后续"),
              react.createElement("button", {
                type: "button", style: BUTTON_STYLE, title: "不写任何东西，提示你开新会话才彻底干净（默认）",
                onClick: function () { offWith("new"); }
              }, "开新会话 · 不写入"),
              react.createElement("button", {
                type: "button", style: BUTTON_STYLE, title: "取消",
                onClick: function () { offWith("new"); }
              }, "✕")
            ));
          }

          return react.createElement("div", { style: WRAP_STYLE }, ...children);
        }

        function apply(ctx) {
          // remote 是可用的客户端服务；declared in inject 后才能通过 guard。
          // 仍用 ctx.get 兜底：某些宿主把 remote 挂在 ctx 属性上，取不到时禁用开关按钮，
          // 但徽章本身无条件注册——绝不让「开关不可用」把整个状态栏拖没。
          var remote = ctx.remote;
          if (remote === undefined && typeof ctx.get === "function") {
            try { remote = ctx.get("remote"); } catch (err) { remote = undefined; }
          }
          var commands = remote && remote.commands;
          var canExecute = !!(commands && typeof commands.execute === "function");

          ctx.slots.inject("conversation.input.dock", () =>
            ctx.slots.register({
              name: "conversation.input.dock",
              id: "fujiang-armor:badge",
              order: 30,
              inject: function (sessionId) {
                return {
                  sessionId: sessionId,
                  execute: canExecute
                    ? function (line) { return commands.execute(sessionId, line, []); }
                    : undefined
                };
              }
            }, ArmorDock)
          );
        }

        exports.name = "fujiang-armor";
        exports.inject = inject;
        exports.apply = apply;
        return module.exports;
      }
    });
  } catch (err) {
    console.warn('[AI Client Sandbox] fujiang-armor runtime error:', err);
  }
})();
