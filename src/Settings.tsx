import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings as SettingsIcon, Key, ArrowRightLeft, Clock, Power } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

interface AppSettings {
  api_key: string;
  auto_close_timeout: number;
  source_lang: string;
  target_lang: string;
  first_run: boolean;
  shortcut: string;
  auto_start: boolean;
}

function Settings() {
  const [apiKey, setApiKey] = useState("");
  const [timeout, setTimeoutValue] = useState(1500);
  const [sourceLang, setSourceLang] = useState("EN");
  const [targetLang, setTargetLang] = useState("ZH");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [shortcut, setShortcut] = useState("Ctrl+Q");
  const [isRecording, setIsRecording] = useState(false);
  const [autoStart, setAutoStart] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const settings = await invoke<AppSettings>("get_settings");
      setApiKey(settings.api_key);
      setTimeoutValue(settings.auto_close_timeout);
      setSourceLang(settings.source_lang);
      setTargetLang(settings.target_lang);
      setShortcut(settings.shortcut);
      setAutoStart(settings.auto_start);
      setLoading(false);
    } catch (e) {
      toast.error(`加载设置失败: ${e}`);
      setLoading(false);
    }
  };

  const handleShortcutKeyDown = (e: React.KeyboardEvent) => {
    if (!isRecording) return;

    e.preventDefault();
    e.stopPropagation();

    const keys: string[] = [];
    if (e.ctrlKey) keys.push("Ctrl");
    if (e.shiftKey) keys.push("Shift");
    if (e.altKey) keys.push("Alt");
    if (e.metaKey) keys.push("Meta");

    if (!["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
      keys.push(e.key.toUpperCase());
    }

    if (keys.length > 1) {
      const newShortcut = keys.join("+");
      setShortcut(newShortcut);
      setIsRecording(false);
    }
  };

  const handleSave = async () => {
    if (!apiKey.trim()) {
      toast.error("API Key 不能为空");
      return;
    }

    setValidating(true);
    try {
      const isValid = await invoke<boolean>("validate_api_key", { apiKey });
      if (!isValid) {
        toast.error("API Key 验证失败");
        setValidating(false);
        return;
      }
    } catch (e) {
      toast.error(`API Key 验证失败: ${e}`);
      setValidating(false);
      return;
    }
    setValidating(false);

    // Validate shortcut
    try {
      await invoke<boolean>("validate_shortcut", { shortcutStr: shortcut });
    } catch (e) {
      toast.error(`快捷键不可用: ${e}`);
      return;
    }

    setSaving(true);
    try {
      await invoke("save_settings", {
        apiKey,
        autoCloseTimeout: timeout,
        sourceLang,
        targetLang,
        shortcut,
        autoStart,
      });
      toast.success("设置保存成功！");
    } catch (e) {
      toast.error(`保存设置失败: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-muted/40">
      <Card className="flex-1 flex flex-col w-full shadow-none rounded-none border-none">
        <CardHeader>
          <div className="flex items-center gap-2">
            <SettingsIcon className="w-6 h-6 text-primary" />
            <CardTitle>配置设置</CardTitle>
          </div>
          <CardDescription>
            配置 DeepLX 接口凭证及翻译窗口行为
          </CardDescription>
        </CardHeader>

        <CardContent className="flex-1 overflow-auto space-y-2">
          <div className="space-y-3">
            <Label htmlFor="api-key" className="text-base font-medium flex items-center gap-2">
              <Key className="w-4 h-4 text-muted-foreground" />
              DeepLX API Key
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="font-mono"
            />
          </div>

          <Separator />

          <div className="space-y-3">
            <Label className="text-base font-medium flex items-center gap-2">
              <ArrowRightLeft className="w-4 h-4 text-muted-foreground" />
              语言方向
            </Label>
            <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center">
              <Select value={sourceLang} onValueChange={setSourceLang}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="bottom" avoidCollisions={false} className="bg-white">
                  <SelectItem value="EN">English (EN)</SelectItem>
                  <SelectItem value="ZH">简体中文 (ZH)</SelectItem>
                  <SelectItem value="JA">日本語 (JA)</SelectItem>
                  <SelectItem value="KO">한국어 (KO)</SelectItem>
                  <SelectItem value="FR">Français (FR)</SelectItem>
                  <SelectItem value="DE">Deutsch (DE)</SelectItem>
                  <SelectItem value="ES">Español (ES)</SelectItem>
                  <SelectItem value="RU">Русский (RU)</SelectItem>
                  <SelectItem value="IT">Italiano (IT)</SelectItem>
                  <SelectItem value="PT">Português (PT)</SelectItem>
                  <SelectItem value="AR">العربية (AR)</SelectItem>
                  <SelectItem value="NL">Nederlands (NL)</SelectItem>
                  <SelectItem value="PL">Polski (PL)</SelectItem>
                  <SelectItem value="TR">Türkçe (TR)</SelectItem>
                </SelectContent>
              </Select>

              <ArrowRightLeft className="w-4 h-4 text-muted-foreground opacity-50" />

              <Select value={targetLang} onValueChange={setTargetLang}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="bottom" avoidCollisions={false} className="bg-white">
                  <SelectItem value="ZH">简体中文 (ZH)</SelectItem>
                  <SelectItem value="EN">English (EN)</SelectItem>
                  <SelectItem value="JA">日本語 (JA)</SelectItem>
                  <SelectItem value="KO">한국어 (KO)</SelectItem>
                  <SelectItem value="FR">Français (FR)</SelectItem>
                  <SelectItem value="DE">Deutsch (DE)</SelectItem>
                  <SelectItem value="ES">Español (ES)</SelectItem>
                  <SelectItem value="RU">Русский (RU)</SelectItem>
                  <SelectItem value="IT">Italiano (IT)</SelectItem>
                  <SelectItem value="PT">Português (PT)</SelectItem>
                  <SelectItem value="AR">العربية (AR)</SelectItem>
                  <SelectItem value="NL">Nederlands (NL)</SelectItem>
                  <SelectItem value="PL">Polski (PL)</SelectItem>
                  <SelectItem value="TR">Türkçe (TR)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-base font-medium flex items-center gap-2">
              <Clock className="w-4 h-4 text-muted-foreground" />
              自动关闭
            </Label>
            <Select
              value={timeout.toString()}
              onValueChange={(value) => setTimeoutValue(Number(value))}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="bottom" avoidCollisions={false} className="bg-white">
                <SelectItem value="1000">1 秒</SelectItem>
                <SelectItem value="1500">1.5 秒 (默认)</SelectItem>
                <SelectItem value="2000">2 秒</SelectItem>
                <SelectItem value="3000">3 秒</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            <Label className="text-base font-medium flex items-center gap-2">
              <Key className="w-4 h-4 text-muted-foreground" />
              全局快捷键
            </Label>
            <div className="flex gap-2">
              <Input
                value={shortcut}
                onKeyDown={handleShortcutKeyDown}
                onFocus={() => setIsRecording(true)}
                onBlur={() => setIsRecording(false)}
                placeholder="点击后按下快捷键组合"
                readOnly
                className={`font-mono ${isRecording ? 'ring-2 ring-blue-500' : ''}`}
              />
              <Button
                variant="outline"
                onClick={() => setShortcut("Ctrl+Q")}
              >
                重置
              </Button>
            </div>
            {isRecording && (
              <p className="text-sm text-muted-foreground">
                按下快捷键组合（必须包含修饰键 Ctrl/Shift/Alt）
              </p>
            )}
          </div>

          <Separator />

          <div className="space-y-3">
            <Label className="text-base font-medium flex items-center gap-2">
              <Power className="w-4 h-4 text-muted-foreground" />
              开机自动启动
            </Label>
            <div className="flex items-center justify-between p-4 rounded-lg border bg-card">
              <span className="text-sm text-muted-foreground">
                系统启动时自动运行应用
              </span>
              <button
                onClick={() => setAutoStart(!autoStart)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  autoStart ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-lg transition-transform duration-200 ease-in-out ${
                    autoStart ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </CardContent>

        <CardFooter className="px-6 pt-8 pb-8 flex justify-end">
          <Button
            variant="default"
            onClick={handleSave}
            disabled={saving || validating}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {validating ? "验证中..." : saving ? "保存中..." : "保存更改"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export default Settings;
