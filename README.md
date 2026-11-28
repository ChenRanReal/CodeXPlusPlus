## CodeX++

方案來自原版 [CodexHost](https://github.com/BytePioneer-AI/codex-host)，感謝原作者。此分支基於上游 `v0.26.1`，預裝上游已適配的全部 Harness：Pi、Claude Code、DeepSeek Harness、OpenCode、Grok、OMP、Qwen Code、Antigravity、Kiro CLI、CodeBuddy、WorkBuddy、Cursor、Devin、Hermes、Qoder、Qoder CN、Kimi Code、ZCode、Copilot，以及 Codex 用量。這些 Adapter 使用本機原生程式與各自的模型設定。

- 在 Codex Desktop 的輸入框選擇 Codex 或已就緒的本機 Agent。外部聊天可以使用該 Agent 提供的模型與權限設定。
- 在主聊天輸入 `#` 選擇要委派的 Agent。委派會建立同專案內的獨立聊天，可以從主聊天連結或專案側欄開啟及續聊。例如在 Codex 主聊天裡用 GPT 規劃，再輸入 `#grok` 交給 Grok 實現，輸入 `#antigravity` 交給 AGY 驗收和修錯；完成後結果回到主聊天。
- 桌面附加設定只顯示連線和委派。輸入框保留原生上下文指示和外部 Agent 的權限控制。
- 介面沿用 Codex Desktop 的語系與上游既有翻譯，缺少對應翻譯時沿用上游的英文預設。

### 從原始碼啟動

先安裝 Codex Desktop、[Node.js 24 LTS](https://nodejs.org/)、Rust，以及要使用的本機 CLI。DeepSeek Harness 需依本機安裝版本的 Node.js 要求啟動。使用 PowerShell 在本分支執行以下命令。資料目錄請固定使用同一路徑，以便恢復這個版本的外部聊天。啟動會重新開啟 Codex Desktop，請先等正在執行的任務結束。

```powershell
npm ci
$env:CODEXHOST_DATA_DIR = Join-Path $env:USERPROFILE '.codexhost-lite'
npm start
```

Windows 捷徑可用 PowerShell 7 的 `-Sta` 模式開啟 [CodeX++ 啟動視窗](scripts/windows/Show-CodeXPlusPlusLaunch.ps1)。啟動過程會持續顯示目前階段、已等待時間，以及超過 12 秒沒有新進展的步驟。Host 接通且桌面擴充載入後才顯示就緒。CodeX++ 或 Codex 已經開啟時，會先確認是否重新啟動，並說明會關閉之前的視窗。啟動失敗時，視窗會留在最前面並給出提醒。失敗時可以複製這段狀態並重試。使用 `-RuntimeDirectory` 指定包含 `node24/node.exe` 的本機執行環境目錄。
