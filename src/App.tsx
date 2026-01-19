import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";

interface TranslateResult {
  success: boolean;
  text: string;
  error: string | null;
}

interface AppSettings {
  api_key: string;
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

  const computePosition = ({
    anchor,
    width,
    height,
  }: {
    anchor: { x: number; y: number } | null;
    width: number;
    height: number;
  }) => {
    // 总是按桌面模式处理
    // anchor 是物理坐标，width/height 是逻辑尺寸（因为 CSS 像素）
    // 但我们需要计算最终的物理坐标传给 Tauri
    // Tauri 的 setSize(LogicalSize) 会自动处理缩放，但 setPosition(PhysicalPosition) 不会
    // 所以这里我们需要小心：如果 anchor 是物理坐标，那么计算偏移量时也要考虑缩放吗？
    // 为了简单且准确，我们假设传入的 width/height 已经包含 DPI 缩放（或者我们在这里获取 DPR）
    
    const dpr = window.devicePixelRatio || 1;
    // 将逻辑尺寸转为物理尺寸进行计算
    const pWidth = width * dpr;
    const pHeight = height * dpr;

    // 屏幕物理分辨率（注意：window.screen.width 返回的是逻辑分辨率）
    // 如果要获取真实的物理分辨率，应该用 screen.width * dpr
    const screenWidth = window.screen.width * dpr;
    const screenHeight = window.screen.height * dpr;

    const offset = 16 * dpr;
    const safe = 8 * dpr;

    // 如果没有 anchor，居中
    const base = anchor ?? { x: screenWidth / 2, y: safe };
    
    let posX = Math.round(base.x) + offset;
    let posY = Math.round(base.y) + offset;

    // 边界检测（全部在物理像素空间进行）
    if (posX + pWidth > screenWidth - safe) {
      posX = Math.round(base.x) - pWidth - offset;
    }
    if (posY + pHeight > screenHeight - safe) {
      posY = Math.round(base.y) - pHeight - offset;
    }

    // 最后的安全边界限制
    posX = Math.max(safe, Math.min(posX, screenWidth - pWidth - safe));
    posY = Math.max(safe, Math.min(posY, screenHeight - pHeight - safe));

    log("compute-position", {
      anchor: base,
      width: pWidth,
      height: pHeight,
      screen: { w: screenWidth, h: screenHeight },
      result: { posX, posY },
    });

    return { posX, posY };
  };

  useEffect(() => {
    const unlisten = listen<TranslateEvent>("translate-text", async (event) => {
      const seq = (requestSeq.current += 1);
      clearHideTimer();

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

        // 检查翻译是否成功且有结果
        if (!res.success || !res.text || res.text.trim() === "") {
          log("translate-api", "no valid result, not showing window", { success: res.success, hasText: !!res.text, error: res.error });
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
        // 翻译失败，不显示窗口
      }
    });

    return () => {
      unlisten.then((f) => f());
      clearHideTimer();
    };
  }, []);

  // Load settings and listen for updates
  useEffect(() => {
    // Load initial settings
    invoke<AppSettings>("get_settings")
      .then((settings) => {
        setAutoCloseTimeout(settings.auto_close_timeout);
        setSourceLang(settings.source_lang);
        setTargetLang(settings.target_lang);
        log("Settings loaded", { timeout: settings.auto_close_timeout, sourceLang: settings.source_lang, targetLang: settings.target_lang });
      })
      .catch((e) => {
        log("Failed to load settings", e);
      });

    // Listen for settings updates
    const unlisten = listen<AppSettings>("settings-updated", (event) => {
      setAutoCloseTimeout(event.payload.auto_close_timeout);
      setSourceLang(event.payload.source_lang);
      setTargetLang(event.payload.target_lang);
      log("Settings updated", { timeout: event.payload.auto_close_timeout, sourceLang: event.payload.source_lang, targetLang: event.payload.target_lang });
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
  }, [view]);

  useLayoutEffect(() => {
    // 只在翻译完成后才调整窗口高度，避免 loading 状态时的布局跳动
    if (!view || view.status !== "done" || !contentRef.current) return;
    const win = getCurrentWindow();

    const raf = window.requestAnimationFrame(async () => {
      if (!contentRef.current) return;

      // 立即检查鼠标是否在窗口内，如果不在则启动自动隐藏定时器
      // 这样可以确保定时器尽快启动，不会被后续的窗口调整延迟
      const isMouseOver = contentRef.current.matches(':hover');
      if (!isMouseOver && !hideTimer.current) {
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
      const maxHeight = Math.floor(window.screen.height * 0.85);
      const height = Math.min(Math.max(totalContentHeight, minHeight), maxHeight);

      // 添加 padding 空间以显示阴影和圆角
      const padding = 16; // 8px * 2
      await win.setSize(new LogicalSize(width + padding, height + padding));

      // 使用最新的物理尺寸计算位置
      const { posX, posY } = computePosition({ anchor: lastAnchor.current, width: width + padding, height: height + padding });
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
