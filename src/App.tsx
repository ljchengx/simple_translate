import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { availableMonitors, getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import type { Monitor } from "@tauri-apps/api/window";

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
  const log = (...args: unknown[]) => {
    if (import.meta.env.DEV) console.debug("[simple_translate]", ...args);
  };

  // 显示器缓存 + TTL 策略，避免每次翻译都发起 IPC 调用
  const monitorsCache = useRef<Monitor[]>([]);
  const monitorsCacheTime = useRef(0);
  const MONITORS_CACHE_TTL = 5000; // 5 秒缓存有效期

  // 确保显示器缓存可用（带 TTL，过期或为空时才刷新）
  const ensureMonitors = async () => {
    const now = Date.now();
    if (monitorsCache.current.length > 0 && now - monitorsCacheTime.current < MONITORS_CACHE_TTL) {
      return; // 缓存仍有效
    }
    try {
      monitorsCache.current = await availableMonitors();
      monitorsCacheTime.current = now;
      log("monitors-refresh", monitorsCache.current.map(m => ({
        name: m.name,
        pos: m.position,
        size: m.size,
        scale: m.scaleFactor,
      })));
    } catch (e) {
      log("monitors-refresh-error", String(e));
    }
  };

  // 查找坐标所在的显示器，未精确命中时降级到最近的显示器
  const findMonitorForPoint = (x: number, y: number): Monitor | null => {
    if (monitorsCache.current.length === 0) return null;

    // 1. 精确匹配：坐标在显示器矩形范围内
    for (const m of monitorsCache.current) {
      const mx = m.position.x;
      const my = m.position.y;
      const mw = m.size.width;
      const mh = m.size.height;
      if (x >= mx && x < mx + mw && y >= my && y < my + mh) {
        return m;
      }
    }

    // 2. 降级：匹配距离中心最近的显示器（处理屏幕缝隙/边缘坐标）
    let closest = monitorsCache.current[0];
    let minDist = Infinity;
    for (const m of monitorsCache.current) {
      const cx = m.position.x + m.size.width / 2;
      const cy = m.position.y + m.size.height / 2;
      const dist = (x - cx) ** 2 + (y - cy) ** 2;
      if (dist < minDist) {
        minDist = dist;
        closest = m;
      }
    }
    log("monitor-fallback-nearest", { x, y, closest: closest.name });
    return closest;
  };

  const clearHideTimer = () => {
    if (hideTimer.current) {
      log("clearHideTimer", { timerId: hideTimer.current });
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    } else {
      log("clearHideTimer", "no timer to clear");
    }
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
    if (!autoCloseEnabled) return; // 关闭自动关闭时不启动定时器
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
    const maxWidth = Math.min(600, window.screen.width * 0.5); // 不超过屏幕逻辑宽度的 50%（此处用于逻辑尺寸估算，精确度要求不高）

    // 根据文本长度估算宽度（每个字符约 8-10px，考虑换行）
    // 使用平方根函数让宽度增长更平滑
    const estimatedWidth = minWidth + Math.sqrt(textLength) * 15;

    return Math.min(Math.max(minWidth, Math.floor(estimatedWidth)), maxWidth);
  };

  const computePosition = ({
    anchor,
    width,
    height,
  }: {
    anchor: { x: number; y: number } | null;
    width: number;
    height: number;
  }) => {
    // anchor is in physical coordinates from the backend (virtual desktop coords)
    // width/height are logical sizes (CSS pixels)
    // We need to find which monitor the anchor is on, then clamp to that monitor's bounds

    const base = anchor ?? { x: 0, y: 0 };
    const monitor = findMonitorForPoint(base.x, base.y);

    // Monitor bounds in physical pixels
    const monX = monitor ? monitor.position.x : 0;
    const monY = monitor ? monitor.position.y : 0;
    const monW = monitor ? monitor.size.width : window.screen.width * (window.devicePixelRatio || 1);
    const monH = monitor ? monitor.size.height : window.screen.height * (window.devicePixelRatio || 1);
    const dpr = monitor ? monitor.scaleFactor : (window.devicePixelRatio || 1);

    // Convert logical popup size to physical pixels for this monitor's DPR
    const pWidth = width * dpr;
    const pHeight = height * dpr;

    const offset = Math.round(16 * dpr);
    const safe = Math.round(8 * dpr);

    let posX = Math.round(base.x) + offset;
    let posY = Math.round(base.y) + offset;

    // Boundary detection within the target monitor's physical bounds
    if (posX + pWidth > monX + monW - safe) {
      posX = Math.round(base.x) - pWidth - offset;
    }
    if (posY + pHeight > monY + monH - safe) {
      posY = Math.round(base.y) - pHeight - offset;
    }

    // Final safety clamp to the target monitor's bounds
    posX = Math.round(Math.max(monX + safe, Math.min(posX, monX + monW - pWidth - safe)));
    posY = Math.round(Math.max(monY + safe, Math.min(posY, monY + monH - pHeight - safe)));

    log("compute-position", {
      anchor: base,
      monitor: monitor ? { name: monitor.name, pos: monitor.position, size: monitor.size, scale: monitor.scaleFactor } : "fallback",
      popup: { pWidth, pHeight },
      monBounds: { monX, monY, monW, monH },
      result: { posX, posY },
    });

    return { posX, posY };
  };

  useEffect(() => {
    const unlisten = listen<TranslateEvent>("translate-text", async (event) => {
      const seq = (requestSeq.current += 1);
      clearHideTimer();

      await ensureMonitors();

      // 如果窗口已经显示，先隐藏它以确保唯一性
      if (view !== null) {
        const win = getCurrentWindow();
        await win.hide();
        setView(null);
        log("translate-text", "hiding existing window for new translation");
      }

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
          const { posX, posY } = computePosition({ anchor: { x, y }, width: width + padding, height: initialHeight + padding });
          await win.setPosition(new PhysicalPosition(posX, posY));
          await win.show();
          await win.setFocus();
          setIsFirstShow(false);
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
        const { posX, posY } = computePosition({ anchor: { x, y }, width: width + padding, height: initialHeight + padding });
        await win.setPosition(new PhysicalPosition(posX, posY));

        await win.show();
        await win.setFocus();
        setIsFirstShow(false); // 窗口显示后，禁用后续动画
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
        const { posX, posY } = computePosition({ anchor: lastAnchor.current, width: width + padding, height: initialHeight + padding });
        await win.setPosition(new PhysicalPosition(posX, posY));
        await win.show();
        await win.setFocus();
        setIsFirstShow(false);
      }
    });

    // 监听文本获取失败事件
    const unlistenError = listen<string>("translate-error", async (event) => {
      clearHideTimer();
      log("translate-error-event", event.payload);

      await ensureMonitors();

      const win = getCurrentWindow();
      const mousePos = await invoke<[number, number, number, number]>("get_mouse_position");
      lastAnchor.current = { x: mousePos[0], y: mousePos[1] };

      setView({ status: "done", result: { success: false, text: "", error: event.payload } });

      const width = 300;
      setPopupWidth(width);
      const padding = 16;
      const initialHeight = 100;
      await win.setSize(new LogicalSize(width + padding, initialHeight + padding));
      const { posX, posY } = computePosition({ anchor: lastAnchor.current, width: width + padding, height: initialHeight + padding });
      await win.setPosition(new PhysicalPosition(posX, posY));
      await win.show();
      await win.setFocus();
      setIsFirstShow(false);
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

    log("event-listeners", "added keydown, blur, focus listeners");

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
      log("event-listeners", "removed keydown, blur, focus listeners");
    };
  }, [view, autoCloseEnabled]);

  useLayoutEffect(() => {
    // 只在翻译完成后才调整窗口高度，避免 loading 状态时的布局跳动
    if (!view || view.status !== "done" || !contentRef.current) return;
    const win = getCurrentWindow();
    let cancelled = false;

    const raf = window.requestAnimationFrame(async () => {
      try {
        if (cancelled || !contentRef.current) return;

        await ensureMonitors();
        if (cancelled) return;

        // 立即检查鼠标是否在窗口内，如果不在则启动自动隐藏定时器
        // 这样可以确保定时器尽快启动，不会被后续的窗口调整延迟
        const isMouseOver = contentRef.current.matches(':hover');
        if (autoCloseEnabled && !isMouseOver && !hideTimer.current) {
          hideTimer.current = window.setTimeout(() => {
            log("hideTimer", "auto-hide timer elapsed, calling hideWindow");
            hideWindow();
          }, autoCloseTimeout);
          log("auto-hide-check", "mouse not over window, timer started", { timerId: hideTimer.current });
        }

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
        // Use the target monitor's logical height for maxHeight calculation
        const anchorMonitor = lastAnchor.current ? findMonitorForPoint(lastAnchor.current.x, lastAnchor.current.y) : null;
        const monLogicalHeight = anchorMonitor
          ? anchorMonitor.size.height / anchorMonitor.scaleFactor
          : window.screen.height;
        const maxHeight = Math.floor(monLogicalHeight * 0.85);
        const height = Math.min(Math.max(totalContentHeight, minHeight), maxHeight);

        // 添加 padding 空间以显示阴影和圆角
        const padding = 16; // 8px * 2

        if (cancelled) return;
        await win.setSize(new LogicalSize(width + padding, height + padding));

        if (cancelled) return;
        // 使用最新的物理尺寸计算位置
        const { posX, posY } = computePosition({ anchor: lastAnchor.current, width: width + padding, height: height + padding });
        await win.setPosition(new PhysicalPosition(posX, posY));

        log("window-layout", { width, height, totalContentHeight, posX, posY, status: view.status, resultLength });
      } catch (e) {
        if (!cancelled) {
          log("window-layout-error", String(e));
        }
      }
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
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
