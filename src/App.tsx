import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, PhysicalPosition, availableMonitors } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";

interface TranslateResult {
  success: boolean;
  text: string;
  error: string | null;
}

interface AppSettings {
  api_key: string;
  auto_close_enabled: boolean;
  auto_close_timeout: number;
  source_lang: string;
  target_lang: string;
  first_run: boolean;
}

type ViewState =
  | { status: "loading" }
  | { status: "done"; result: TranslateResult };

interface TranslateEvent {
  text: string;
  x: number;
  y: number;
}

function App() {
  const [view, setView] = useState<ViewState | null>(null);
  const [popupWidth, setPopupWidth] = useState(300);
  const [isFirstShow, setIsFirstShow] = useState(true);
  const [autoCloseEnabled, setAutoCloseEnabled] = useState(true);
  const [autoCloseTimeout, setAutoCloseTimeout] = useState(1500);
  const [sourceLang, setSourceLang] = useState("EN");
  const [targetLang, setTargetLang] = useState("ZH");
  const [copied, setCopied] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);
  const lastAnchor = useRef<{ x: number; y: number } | null>(null);
  const autoCloseEnabledRef = useRef(autoCloseEnabled);
  const autoCloseTimeoutRef = useRef(autoCloseTimeout);
  const log = (...args: unknown[]) => {
    if (import.meta.env.DEV) console.debug("[simple_translate]", ...args);
  };

  // Keep refs in sync with state so event handler closures always have current values
  useEffect(() => {
    autoCloseEnabledRef.current = autoCloseEnabled;
    autoCloseTimeoutRef.current = autoCloseTimeout;
  }, [autoCloseEnabled, autoCloseTimeout]);

  const clearHideTimer = () => {
    if (hideTimer.current) {
      log("clearHideTimer", { timerId: hideTimer.current });
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    } else {
      log("clearHideTimer", "no timer to clear");
    }
  };

  /** Start auto-hide timer. Uses refs so it's safe to call from stale closures. */
  const startHideTimer = () => {
    if (!autoCloseEnabledRef.current || autoCloseTimeoutRef.current === 0) return;
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => {
      log("hideTimer", "auto-hide timer elapsed, calling hideWindow");
      hideWindow();
    }, autoCloseTimeoutRef.current);
    log("startHideTimer", { timerId: hideTimer.current, timeout: autoCloseTimeoutRef.current });
  };

  const hideWindow = async () => {
    log("hideWindow", "starting to hide window");
    clearHideTimer();
    const win = getCurrentWindow();
    await win.hide();
    setView(null);
    setIsFirstShow(true); // 重置动画状态
    log("hideWindow", "window hidden successfully");
  };

  const handleMouseLeave = () => {
    if (!autoCloseEnabled || autoCloseTimeout === 0) return; // 关闭自动关闭或无限时间时不启动定时器
    log("handleMouseLeave", "mouse left window, setting timer");
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => {
      log("hideTimer", "timer elapsed, calling hideWindow");
      hideWindow();
    }, autoCloseTimeout);
    log("handleMouseLeave", { timerId: hideTimer.current });
  };

  const handleMouseEnter = () => {
    log("handleMouseEnter", "mouse entered window, canceling timer");
    clearHideTimer();
  };

  const getPopupWidth = (textLength: number = 0) => {
    // 根据文本长度动态计算宽度
    // 短文本：300px，长文本：最大 600px
    const minWidth = 300;
    const maxWidth = Math.min(600, window.screen.width * 0.5); // 不超过屏幕宽度的 50%

    // 根据文本长度估算宽度（每个字符约 8-10px，考虑换行）
    // 使用平方根函数让宽度增长更平滑
    const estimatedWidth = minWidth + Math.sqrt(textLength) * 15;

    return Math.min(Math.max(minWidth, Math.floor(estimatedWidth)), maxWidth);
  };

  const computePosition = async ({
    anchor,
    width,
    height,
  }: {
    anchor: { x: number; y: number } | null;
    width: number;
    height: number;
  }) => {
    // anchor is in physical coordinates from Rust
    // width/height are logical sizes (CSS pixels)

    // Get all monitors to support multi-monitor setups
    const monitors = await availableMonitors();

    // Default to primary screen estimate
    const defaultDpr = window.devicePixelRatio || 1;
    let monitorX = 0;
    let monitorY = 0;
    let monitorWidth = window.screen.width * defaultDpr;
    let monitorHeight = window.screen.height * defaultDpr;
    let scaleFactor = defaultDpr;

    // Find which monitor contains the anchor point
    if (anchor && monitors.length > 0) {
      for (const m of monitors) {
        const mx = m.position.x;
        const my = m.position.y;
        const mw = m.size.width;
        const mh = m.size.height;
        if (anchor.x >= mx && anchor.x < mx + mw && anchor.y >= my && anchor.y < my + mh) {
          monitorX = mx;
          monitorY = my;
          monitorWidth = mw;
          monitorHeight = mh;
          scaleFactor = m.scaleFactor;
          break;
        }
      }
    }

    // Convert logical sizes to physical using the target monitor's scale factor
    const pWidth = width * scaleFactor;
    const pHeight = height * scaleFactor;

    const offset = 16 * scaleFactor;
    const safe = 8 * scaleFactor;

    // If no anchor, center on the target monitor
    const base = anchor ?? { x: monitorX + monitorWidth / 2, y: monitorY + safe };

    let posX = Math.round(base.x) + offset;
    let posY = Math.round(base.y) + offset;

    // Boundary detection within the target monitor
    if (posX + pWidth > monitorX + monitorWidth - safe) {
      posX = Math.round(base.x) - pWidth - offset;
    }
    if (posY + pHeight > monitorY + monitorHeight - safe) {
      posY = Math.round(base.y) - pHeight - offset;
    }

    // Safety clamping within the target monitor bounds
    posX = Math.round(Math.max(monitorX + safe, Math.min(posX, monitorX + monitorWidth - pWidth - safe)));
    posY = Math.round(Math.max(monitorY + safe, Math.min(posY, monitorY + monitorHeight - pHeight - safe)));

    log("compute-position", {
      anchor: base,
      width: pWidth,
      height: pHeight,
      monitor: { x: monitorX, y: monitorY, w: monitorWidth, h: monitorHeight, scaleFactor },
      result: { posX, posY },
    });

    return { posX, posY };
  };

  useEffect(() => {
    const unlisten = listen<TranslateEvent>("translate-text", async (event) => {
      const seq = (requestSeq.current += 1);
      clearHideTimer();

      const { text, x, y } = event.payload;
      // x, y 是后端传来的物理坐标，直接存储
      lastAnchor.current = { x, y };
      log("translate-text", { seq, length: text.length, x, y });

      try {
        // 先调用翻译 API，不显示窗口
        log("translate-api", "calling translate API");
        const res = await invoke<TranslateResult>("translate", { text });
        if (seq !== requestSeq.current) {
          log("translate-api", "sequence mismatch, ignoring result");
          return;
        }

        // 翻译失败时也显示错误信息，而不是静默
        if (!res.success) {
          log("translate-api", "translation failed, showing error", { error: res.error });
          setView({ status: "done", result: res });

          const win = getCurrentWindow();
          const width = 300;
          setPopupWidth(width);
          const padding = 16;
          const initialHeight = 100;
          await win.setSize(new LogicalSize(width + padding, initialHeight + padding));
          const { posX, posY } = await computePosition({ anchor: { x, y }, width: width + padding, height: initialHeight + padding });
          await win.setPosition(new PhysicalPosition(posX, posY));
          await win.show();
          await win.setFocus();
          setIsFirstShow(false);
          startHideTimer();
          return;
        }

        if (!res.text || res.text.trim() === "") {
          log("translate-api", "empty result, not showing window");
          return;
        }

        log("translate-api", "translation successful, showing window");

        // 翻译成功，准备显示窗口
        setView({ status: "done", result: res });

        const win = getCurrentWindow();
        const width = getPopupWidth(res.text.length);
        setPopupWidth(width);

        // 添加 padding 空间以显示阴影和圆角
        const padding = 16; // 8px * 2
        const initialHeight = 140; // 容纳头部 + 两行内容
        await win.setSize(new LogicalSize(width + padding, initialHeight + padding));

        // 计算物理坐标位置
        const { posX, posY } = await computePosition({ anchor: { x, y }, width: width + padding, height: initialHeight + padding });
        await win.setPosition(new PhysicalPosition(posX, posY));

        await win.show();
        await win.setFocus();
        setIsFirstShow(false); // 窗口显示后，禁用后续动画
        startHideTimer();
        log("window-show", { posX, posY, resultLength: res.text.length });

        log("translate-result", { seq, success: res.success, length: res.text.length });
      } catch (e) {
        if (seq !== requestSeq.current) return;
        log("translate-error", { seq, error: String(e) });
        // 翻译异常时显示错误
        setView({ status: "done", result: { success: false, text: "", error: `翻译请求异常: ${String(e)}` } });
        const win = getCurrentWindow();
        const width = 300;
        setPopupWidth(width);
        const padding = 16;
        const initialHeight = 100;
        await win.setSize(new LogicalSize(width + padding, initialHeight + padding));
        const { posX, posY } = await computePosition({ anchor: lastAnchor.current, width: width + padding, height: initialHeight + padding });
        await win.setPosition(new PhysicalPosition(posX, posY));
        await win.show();
        await win.setFocus();
        setIsFirstShow(false);
        startHideTimer();
      }
    });

    // 监听文本获取失败事件
    const unlistenError = listen<string>("translate-error", async (event) => {
      clearHideTimer();
      log("translate-error-event", event.payload);

      const win = getCurrentWindow();
      const mousePos = await invoke<[number, number, number, number]>("get_mouse_position");
      lastAnchor.current = { x: mousePos[0], y: mousePos[1] };

      setView({ status: "done", result: { success: false, text: "", error: event.payload } });

      const width = 300;
      setPopupWidth(width);
      const padding = 16;
      const initialHeight = 100;
      await win.setSize(new LogicalSize(width + padding, initialHeight + padding));
      const { posX, posY } = await computePosition({ anchor: lastAnchor.current, width: width + padding, height: initialHeight + padding });
      await win.setPosition(new PhysicalPosition(posX, posY));
      await win.show();
      await win.setFocus();
      setIsFirstShow(false);
      startHideTimer();
    });

    // 监听快捷键注册失败事件
    const unlistenShortcut = listen<string>("shortcut-error", async (event) => {
      log("shortcut-error-event", event.payload);
      // 快捷键错误不显示在翻译弹窗中（设置窗口会自动打开）
      // 但记录日志以便调试
    });

    return () => {
      unlisten.then((f) => f());
      unlistenError.then((f) => f());
      unlistenShortcut.then((f) => f());
      clearHideTimer();
    };
  }, []);

  // Load settings and listen for updates
  useEffect(() => {
    // Load initial settings
    invoke<AppSettings>("get_settings")
      .then((settings) => {
        setAutoCloseEnabled(settings.auto_close_enabled);
        setAutoCloseTimeout(settings.auto_close_timeout);
        setSourceLang(settings.source_lang);
        setTargetLang(settings.target_lang);
        log("Settings loaded", { autoCloseEnabled: settings.auto_close_enabled, timeout: settings.auto_close_timeout, sourceLang: settings.source_lang, targetLang: settings.target_lang });
      })
      .catch((e) => {
        log("Failed to load settings", e);
      });

    // Listen for settings updates
    const unlisten = listen<AppSettings>("settings-updated", (event) => {
      setAutoCloseEnabled(event.payload.auto_close_enabled);
      setAutoCloseTimeout(event.payload.auto_close_timeout);
      setSourceLang(event.payload.source_lang);
      setTargetLang(event.payload.target_lang);
      log("Settings updated", { autoCloseEnabled: event.payload.auto_close_enabled, timeout: event.payload.auto_close_timeout, sourceLang: event.payload.source_lang, targetLang: event.payload.target_lang });
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // ESC 键监听：强制隐藏窗口
  useEffect(() => {
    if (!view) return; // 只在窗口显示时监听

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        log("keydown", "ESC key pressed, hiding window");
        hideWindow();
      }
    };

    const handleBlur = () => {
      log("window-blur", "window lost focus");
      if (!autoCloseEnabled) {
        log("window-blur", "auto-close disabled, hiding on blur");
        hideWindow();
      }
    };

    const handleFocus = () => {
      log("window-focus", "window gained focus");
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);

    // 不自动关闭模式：注册全局 ESC 快捷键，使鼠标不在窗口上时也能关闭
    let cancelled = false;
    let globalEscRegistered = false;
    if (autoCloseEnabled && autoCloseTimeout === 0) {
      register("Escape", (event) => {
        if (event.state === "Pressed") {
          log("global-esc", "global ESC pressed, hiding window");
          hideWindow();
        }
      }).then(() => {
        if (cancelled) {
          // effect 已清理，立即注销
          unregister("Escape").catch(() => {});
        } else {
          globalEscRegistered = true;
          log("global-esc", "registered");
        }
      }).catch((e) => {
        log("global-esc", "register failed", e);
      });
    }

    log("event-listeners", "added keydown, blur, focus listeners");

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
      if (globalEscRegistered) {
        unregister("Escape").catch((e) => {
          log("global-esc", "unregister failed", e);
        });
        log("global-esc", "unregistered");
      }
      log("event-listeners", "removed keydown, blur, focus listeners");
    };
  }, [view, autoCloseEnabled, autoCloseTimeout]);

  useLayoutEffect(() => {
    // 只在翻译完成后才调整窗口高度，避免 loading 状态时的布局跳动
    if (!view || view.status !== "done" || !contentRef.current) return;
    const win = getCurrentWindow();

    const raf = window.requestAnimationFrame(async () => {
      if (!contentRef.current) return;

      // 根据翻译结果长度重新计算宽度
      const resultLength = view.result.success ? view.result.text.length : 0;
      const width = getPopupWidth(resultLength);
      setPopupWidth(width); // 更新状态以便下次使用

      // 测量实际内容的高度
      const header = contentRef.current.querySelector('.translate-header') as HTMLElement;
      const content = contentRef.current.querySelector('.translate-content') as HTMLElement;
      if (!header || !content) return;

      // 测量内部实际内容元素的高度（而不是容器的高度）
      const contentInner = content.querySelector('.trans-text, .loading-text, .error-text') as HTMLElement;
      if (!contentInner) return;

      const headerHeight = header.offsetHeight;
      const contentPadding = 32; // .translate-content 的 padding: 16px 20px (上下各 16px)
      const contentInnerHeight = contentInner.offsetHeight;
      const totalContentHeight = headerHeight + contentInnerHeight + contentPadding;

      const minHeight = 80;
      const maxHeight = Math.floor(window.screen.height * 0.85);
      const height = Math.min(Math.max(totalContentHeight, minHeight), maxHeight);

      // 添加 padding 空间以显示阴影和圆角
      const padding = 16; // 8px * 2
      await win.setSize(new LogicalSize(width + padding, height + padding));

      // 使用最新的物理尺寸计算位置
      const { posX, posY } = await computePosition({ anchor: lastAnchor.current, width: width + padding, height: height + padding });
      await win.setPosition(new PhysicalPosition(posX, posY));

      log("window-layout", { width, height, totalContentHeight, posX, posY, status: view.status, resultLength });
    });

    return () => window.cancelAnimationFrame(raf);
  }, [view]);

  const copyText = () => {
    log("copyText", "copying translation result");
    if (view?.status === "done" && view.result.success && view.result.text) {
      navigator.clipboard.writeText(view.result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      log("copyText", "copied successfully");
    }
  };

  if (!view) {
    log("render", "view is null, returning null");
    return null;
  }

  log("render", { status: view.status, hasTimer: !!hideTimer.current });

  return (
    <div
      ref={contentRef}
      className="translate-window"
      style={{ width: popupWidth }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={`translate-popover ${isFirstShow ? 'translate-popover-in' : ''}`}>
        {/* Header - 固定高度区域 */}
        <div className="translate-header">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
              </svg>
              <span className="lang-badge">{sourceLang} → {targetLang}</span>
            </div>
            <button
              onClick={copyText}
              className={`copy-btn ${copied ? 'copied' : ''}`}
              style={{
                visibility: view.status === "done" && view.result.success ? "visible" : "hidden"
              }}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                {copied ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                )}
              </svg>
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          </div>
        </div>

        {/* Content - 可滚动区域 */}
        <div className="translate-content">
          {view.status === "loading" ? (
            <div className="loading-text">
              <span className="spinner"></span>
              <span>翻译中…</span>
            </div>
          ) : view.result.success ? (
            <p className="trans-text">{view.result.text}</p>
          ) : (
            <div className="error-text">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{view.result.error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
