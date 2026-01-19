use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_store::StoreExt;
use tauri_plugin_autostart::ManagerExt;
use enigo::{Enigo, Key, Keyboard, Settings};
use arboard::Clipboard;
use serde::{Deserialize, Serialize};
use std::thread;
use std::time::{Duration, Instant};
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;
use once_cell::sync::Lazy;
use log::{info, warn, error, debug};
use rdev::{listen, EventType, Button};

static LAST_TRIGGER: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_CLICK_POS: Mutex<(i32, i32)> = Mutex::new((0, 0));

#[derive(Serialize, Deserialize)]
struct TranslateRequest {
    text: String,
    source_lang: String,
    target_lang: String,
}

#[derive(Serialize, Deserialize)]
struct TranslateResponse {
    code: i32,
    data: Option<String>,
}

#[derive(Clone, Serialize)]
struct TranslateResult {
    success: bool,
    text: String,
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct AppSettings {
    api_key: String,
    auto_close_timeout: u64,
    source_lang: String,
    target_lang: String,
    first_run: bool,
    shortcut: String,
    auto_start: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            auto_close_timeout: 1500,
            source_lang: "EN".to_string(),
            target_lang: "ZH".to_string(),
            first_run: true,
            shortcut: "Ctrl+Q".to_string(),
            auto_start: false,
        }
    }
}

static SETTINGS_CACHE: Lazy<Arc<RwLock<AppSettings>>> =
    Lazy::new(|| Arc::new(RwLock::new(AppSettings::default())));

static CURRENT_SHORTCUT: Lazy<Arc<RwLock<Option<Shortcut>>>> =
    Lazy::new(|| Arc::new(RwLock::new(None)));

fn string_to_code(key: &str) -> Result<Code, String> {
    match key.to_uppercase().as_str() {
        "A" => Ok(Code::KeyA), "B" => Ok(Code::KeyB), "C" => Ok(Code::KeyC), "D" => Ok(Code::KeyD),
        "E" => Ok(Code::KeyE), "F" => Ok(Code::KeyF), "G" => Ok(Code::KeyG), "H" => Ok(Code::KeyH),
        "I" => Ok(Code::KeyI), "J" => Ok(Code::KeyJ), "K" => Ok(Code::KeyK), "L" => Ok(Code::KeyL),
        "M" => Ok(Code::KeyM), "N" => Ok(Code::KeyN), "O" => Ok(Code::KeyO), "P" => Ok(Code::KeyP),
        "Q" => Ok(Code::KeyQ), "R" => Ok(Code::KeyR), "S" => Ok(Code::KeyS), "T" => Ok(Code::KeyT),
        "U" => Ok(Code::KeyU), "V" => Ok(Code::KeyV), "W" => Ok(Code::KeyW), "X" => Ok(Code::KeyX),
        "Y" => Ok(Code::KeyY), "Z" => Ok(Code::KeyZ),
        "0" => Ok(Code::Digit0), "1" => Ok(Code::Digit1), "2" => Ok(Code::Digit2), "3" => Ok(Code::Digit3),
        "4" => Ok(Code::Digit4), "5" => Ok(Code::Digit5), "6" => Ok(Code::Digit6), "7" => Ok(Code::Digit7),
        "8" => Ok(Code::Digit8), "9" => Ok(Code::Digit9),
        "F1" => Ok(Code::F1), "F2" => Ok(Code::F2), "F3" => Ok(Code::F3), "F4" => Ok(Code::F4),
        "F5" => Ok(Code::F5), "F6" => Ok(Code::F6), "F7" => Ok(Code::F7), "F8" => Ok(Code::F8),
        "F9" => Ok(Code::F9), "F10" => Ok(Code::F10), "F11" => Ok(Code::F11), "F12" => Ok(Code::F12),
        _ => Err(format!("不支持的按键: {}", key))
    }
}

fn parse_shortcut(shortcut_str: &str) -> Result<Shortcut, String> {
    let parts: Vec<&str> = shortcut_str.split('+').map(|s| s.trim()).collect();
    if parts.is_empty() {
        return Err("快捷键不能为空".to_string());
    }

    let mut modifiers = Modifiers::empty();
    let mut key_code = None;

    for part in parts {
        match part {
            "Ctrl" | "Control" => modifiers |= Modifiers::CONTROL,
            "Shift" => modifiers |= Modifiers::SHIFT,
            "Alt" => modifiers |= Modifiers::ALT,
            "Meta" | "Win" => modifiers |= Modifiers::META,
            key => {
                if key_code.is_some() {
                    return Err("快捷键只能包含一个主键".to_string());
                }
                key_code = Some(string_to_code(key)?);
            }
        }
    }

    match key_code {
        Some(code) => Ok(Shortcut::new(if modifiers.is_empty() { None } else { Some(modifiers) }, code)),
        None => Err("快捷键必须包含一个主键".to_string())
    }
}


fn get_selected_text() -> Option<String> {
    debug!("开始获取选中文本");
    let mut clipboard = Clipboard::new().ok()?;
    let old_content = clipboard.get_text().ok();
    debug!("旧剪贴板内容: {:?}", old_content);

    let mut enigo = Enigo::new(&Settings::default()).ok()?;
    enigo.key(Key::Control, enigo::Direction::Press).ok()?;
    enigo.key(Key::Unicode('c'), enigo::Direction::Click).ok()?;
    enigo.key(Key::Control, enigo::Direction::Release).ok()?;

    thread::sleep(Duration::from_millis(50));

    let new_content = clipboard.get_text().ok()?;
    debug!("新剪贴板内容: {:?}", new_content);

    if let Some(old) = old_content {
        let _ = clipboard.set_text(&old);
    }

    if new_content.trim().is_empty() {
        warn!("选中文本为空");
        None
    } else {
        let text: String = new_content.chars().take(1000).collect();
        info!("获取到选中文本: {} 字符", text.len());
        Some(text)
    }
}

#[tauri::command]
async fn translate(text: String) -> TranslateResult {
    info!("开始翻译, 文本长度: {} 字符", text.len());
    debug!("翻译文本: {}", text);

    // Get settings from cache
    let settings = SETTINGS_CACHE.read().await.clone();

    if settings.api_key.is_empty() {
        warn!("API Key is not configured");
        return TranslateResult {
            success: false,
            text: String::new(),
            error: Some("API Key未配置，请在系统托盘菜单中打开设置".to_string()),
        };
    }

    let client = reqwest::Client::new();
    let req = TranslateRequest {
        text: text.clone(),
        source_lang: settings.source_lang.clone(),
        target_lang: settings.target_lang.clone(),
    };

    let url = format!("https://api.deeplx.org/{}/translate", settings.api_key);
    info!("请求 API: {}", url);

    match client
        .post(&url)
        .json(&req)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            info!("API 响应状态码: {}", status);

            let body = resp.text().await.unwrap_or_default();
            debug!("API 响应内容: {}", body);

            match serde_json::from_str::<TranslateResponse>(&body) {
                Ok(data) => {
                    info!("API 返回 code: {}", data.code);
                    if data.code == 200 {
                        let result_text = data.data.unwrap_or_default();
                        info!("翻译成功, 结果长度: {} 字符", result_text.len());
                        debug!("翻译结果: {}", result_text);
                        TranslateResult {
                            success: true,
                            text: result_text,
                            error: None,
                        }
                    } else {
                        warn!("API 返回非 200 code: {}", data.code);
                        TranslateResult {
                            success: false,
                            text: String::new(),
                            error: Some(format!("翻译服务返回错误码: {}", data.code)),
                        }
                    }
                }
                Err(e) => {
                    error!("解析 API 响应失败: {}", e);
                    error!("原始响应: {}", body);
                    TranslateResult {
                        success: false,
                        text: String::new(),
                        error: Some("翻译服务响应格式错误".to_string()),
                    }
                }
            }
        }
        Err(e) => {
            error!("API 请求失败: {}", e);
            TranslateResult {
                success: false,
                text: String::new(),
                error: Some(format!("网络连接失败: {}", e)),
            }
        }
    }
}

#[tauri::command]
fn get_mouse_position() -> (i32, i32, f64, f64) {
    let pos = enigo::Mouse::location(&Enigo::new(&Settings::default()).unwrap()).unwrap_or((0, 0));
    // 返回 (物理x, 物理y, 缩放因子, 0)
    // Windows 默认缩放通常是 1.0, 1.25, 1.5, 2.0 等
    // 我们在 Rust 端无法直接获取缩放因子，需要前端通过 window.devicePixelRatio 获取
    (pos.0, pos.1, 1.0, 0.0)
}

#[derive(Clone, Serialize)]
struct TranslateEventPayload {
    text: String,
    x: i32,
    y: i32,
}

fn trigger_translate(app: &AppHandle) {
    // 防抖：300ms 内不重复触发
    {
        let mut last = LAST_TRIGGER.lock().unwrap();
        if let Some(t) = *last {
            if t.elapsed() < Duration::from_millis(300) {
                debug!("快捷键防抖，跳过");
                return;
            }
        }
        *last = Some(Instant::now());
    }

    // 获取最后一次点击位置
    let (mut x, mut y) = *LAST_CLICK_POS.lock().unwrap();

    // 如果从未点击过（极端情况），或者需要兜底，使用当前鼠标位置
    if x == 0 && y == 0 {
         let pos = enigo::Mouse::location(&Enigo::new(&Settings::default()).unwrap()).unwrap_or((0, 0));
         x = pos.0;
         y = pos.1;
    }

    info!("触发翻译快捷键，使用坐标: ({}, {})", x, y);

    if let Some(text) = get_selected_text() {
        info!("发送翻译事件到前端");
        let payload = TranslateEventPayload { text, x, y };
        let _ = app.emit("translate-text", payload);
        // 不在后端强制显示窗口，交由前端控制
    } else {
        warn!("未获取到选中文本，跳过翻译");
    }
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    let store = app.store("settings.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    let api_key = store.get("api_key")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();

    let auto_close_timeout = store.get("auto_close_timeout")
        .and_then(|v| v.as_u64())
        .unwrap_or(1500);

    let source_lang = store.get("source_lang")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "EN".to_string());

    let target_lang = store.get("target_lang")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "ZH".to_string());

    let first_run = store.get("first_run")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let shortcut = store.get("shortcut")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "Ctrl+Q".to_string());

    let auto_start = store.get("auto_start")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let settings = AppSettings {
        api_key,
        auto_close_timeout,
        source_lang,
        target_lang,
        first_run,
        shortcut,
        auto_start,
    };

    // Update cache
    *SETTINGS_CACHE.write().await = settings.clone();

    Ok(settings)
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    api_key: String,
    auto_close_timeout: u64,
    source_lang: String,
    target_lang: String,
    shortcut: String,
    auto_start: bool,
) -> Result<(), String> {
    let store = app.store("settings.json")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    store.set("api_key", serde_json::json!(api_key));
    store.set("auto_close_timeout", serde_json::json!(auto_close_timeout));
    store.set("source_lang", serde_json::json!(source_lang));
    store.set("target_lang", serde_json::json!(target_lang));
    store.set("shortcut", serde_json::json!(shortcut));
    store.set("auto_start", serde_json::json!(auto_start));
    store.set("first_run", serde_json::json!(false));

    store.save()
        .map_err(|e| format!("Failed to save settings: {}", e))?;

    // Update cache
    let settings = AppSettings {
        api_key,
        auto_close_timeout,
        source_lang,
        target_lang,
        first_run: false,
        shortcut: shortcut.clone(),
        auto_start,
    };
    *SETTINGS_CACHE.write().await = settings.clone();

    // Update shortcut registration
    update_shortcut(app.clone(), shortcut).await?;

    // Update autostart
    update_autostart(app.clone(), auto_start).await?;

    // Emit event to notify other windows
    app.emit("settings-updated", settings)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    info!("Settings saved successfully");
    Ok(())
}

#[tauri::command]
async fn validate_api_key(api_key: String) -> Result<bool, String> {
    if api_key.trim().is_empty() {
        return Err("API Key cannot be empty".to_string());
    }

    // Test the API key with a simple translation
    let client = reqwest::Client::new();
    let req = TranslateRequest {
        text: "test".to_string(),
        source_lang: "EN".to_string(),
        target_lang: "ZH".to_string(),
    };

    let url = format!("https://api.deeplx.org/{}/translate", api_key);

    match client
        .post(&url)
        .json(&req)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                match serde_json::from_str::<TranslateResponse>(&body) {
                    Ok(data) if data.code == 200 => Ok(true),
                    _ => Err("API Key is invalid or API returned an error".to_string()),
                }
            } else {
                Err(format!("API returned status code: {}", status))
            }
        }
        Err(e) => Err(format!("Failed to validate API key: {}", e)),
    }
}

#[tauri::command]
async fn validate_shortcut(app: AppHandle, shortcut_str: String) -> Result<bool, String> {
    let shortcut = parse_shortcut(&shortcut_str)?;

    // 如果是当前已注册的快捷键，直接返回成功
    if let Some(current) = *CURRENT_SHORTCUT.read().await {
        if current == shortcut {
            return Ok(true);
        }
    }

    match app.global_shortcut().register(shortcut) {
        Ok(_) => {
            let _ = app.global_shortcut().unregister(shortcut);
            Ok(true)
        }
        Err(_) => Err("快捷键已被占用".to_string())
    }
}

#[tauri::command]
async fn update_shortcut(app: AppHandle, shortcut_str: String) -> Result<(), String> {
    let new_shortcut = parse_shortcut(&shortcut_str)?;

    if let Some(old) = *CURRENT_SHORTCUT.read().await {
        let _ = app.global_shortcut().unregister(old);
    }

    let handle = app.clone();
    app.global_shortcut().on_shortcut(new_shortcut, move |_app, _shortcut, _event| {
        trigger_translate(&handle);
    }).map_err(|e| e.to_string())?;

    *CURRENT_SHORTCUT.write().await = Some(new_shortcut);
    Ok(())
}

#[tauri::command]
async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    // Check if settings window already exists
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Create new settings window
    use tauri::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("settings.html".into())
    )
    .title("Settings - Simple Translate")
    .inner_size(650.0, 680.0)
    .resizable(false)
    .center()
    .build()
    .map_err(|e| format!("Failed to create settings window: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn update_autostart(app: AppHandle, enable: bool) -> Result<(), String> {
    let autostart_manager = app.autolaunch();

    if enable {
        autostart_manager.enable()
            .map_err(|e| format!("Failed to enable autostart: {}", e))?;
        info!("Autostart enabled");
    } else {
        // 只有在已启用的情况下才禁用，避免文件不存在错误
        if autostart_manager.is_enabled().unwrap_or(false) {
            autostart_manager.disable()
                .map_err(|e| format!("Failed to disable autostart: {}", e))?;
            info!("Autostart disabled");
        } else {
            info!("Autostart already disabled, skipping");
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    info!("应用启动");

    // 启动全局鼠标监听线程
    thread::spawn(|| {
        if let Err(error) = listen(move |event| {
            if let EventType::ButtonRelease(Button::Left) = event.event_type {
                  // 当左键释放时，立即捕获当前鼠标位置作为“最后一次点击/选择结束位置”
                  // 注意：这里需要每次实例化 Enigo，开销可能略大，但对于手动点击频率是可以接受的
                  if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
                      if let Ok((x, y)) = enigo::Mouse::location(&enigo) {
                          if let Ok(mut pos) = LAST_CLICK_POS.lock() {
                              *pos = (x, y);
                          }
                      }
                  }
             }
        }) {
            error!("Error: {:?}", error);
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            info!("检测到第二个实例启动，已阻止");
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            // Load settings into cache on startup
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match get_settings(app_handle.clone()).await {
                    Ok(settings) => {
                        info!("Settings loaded: {:?}", settings);

                        // Register custom shortcut
                        let shortcut_failed = if let Err(e) = update_shortcut(app_handle.clone(), settings.shortcut.clone()).await {
                            error!("Failed to register shortcut: {}", e);
                            true
                        } else {
                            false
                        };

                        // Check if first run and (API key is empty OR shortcut registration failed)
                        if settings.first_run && (settings.api_key.is_empty() || shortcut_failed) {
                            info!("First run detected, showing settings window");
                            let _ = open_settings_window(app_handle.clone()).await;
                        }
                    }
                    Err(e) => {
                        error!("Failed to load settings: {}", e);
                    }
                }
            });

            // Create menu items
            let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit])?;

            // 使用应用图标创建系统托盘
            let tray_icon = if let Some(icon) = app.default_window_icon() {
                icon.clone()
            } else {
                // 如果没有默认图标，尝试从文件加载
                warn!("No default window icon found, using fallback");
                app.default_window_icon().unwrap().clone()
            };

            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("Simple Translate")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "settings" => {
                            let app_handle = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = open_settings_window(app_handle).await;
                            });
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            translate,
            get_mouse_position,
            get_settings,
            save_settings,
            validate_api_key,
            validate_shortcut,
            update_shortcut,
            open_settings_window,
            update_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
