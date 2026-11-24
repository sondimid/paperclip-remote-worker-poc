# Prompt bàn giao PC Windows — Paperclip Chat V2

**Trước khi gửi:** Thay `<PUBLISHED_SHA>` bằng commit public đã xác minh có `interactive/setup-worker.ps1`. Gửi `.worker.cli.env` riêng qua kênh bảo mật. Không gửi token vào prompt. Nếu chưa có commit đó, chưa chạy prompt này.

## Copy từ đây

Thiết lập **Paperclip Chat V2 Worker** trên PC Windows này. Paperclip gửi chat từ task qua WSS; không mở cửa sổ CMD khác để nhập prompt. Tôi sẽ cấp file `.worker.cli.env` riêng. Không đọc/in nội dung file ra chat/log, không yêu cầu token trong chat. Không mở SSH, port inbound, ngrok, service hay Scheduled Task; không cần đăng nhập Paperclip trên PC.

1. Kiểm tra có Git, Node.js 22 trở lên, npm và PowerShell 5.1 trở lên. Không tự cài thêm công cụ hoặc nâng quyền. Nếu `<PUBLISHED_SHA>` chưa được thay hoặc không phải 40 ký tự hex, dừng và báo thiếu revision.
2. Tải script tương ứng với revision vào một thư mục tải mới dưới tài khoản hiện tại. Kiểm tra đúng URL/nội dung trước khi chạy; không pipe tải xuống vào PowerShell và không thay đổi execution policy để chạy. Chọn thư mục cài tuyệt đối chưa tồn tại và khác thư mục tải.

```powershell
$revision = '<PUBLISHED_SHA>'
if ($revision -cnotmatch '\A[0-9a-f]{40}\z') { throw 'Missing published revision.' }
$download = Join-Path $env:LOCALAPPDATA ('PaperclipWorkerDownload-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $download -ErrorAction Stop | Out-Null
$script = Join-Path $download 'setup-worker.ps1'
Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/sondimid/paperclip-remote-worker-poc/$revision/interactive/setup-worker.ps1" -OutFile $script -ErrorAction Stop
```

Sau khi đã kiểm tra script, dùng cùng phiên PowerShell:

```powershell
$destination = Join-Path $env:LOCALAPPDATA "PaperclipWorker-$($revision.Substring(0, 12))"
& $script -Revision $revision -Destination $destination
```

3. Chỉ sau `Setup complete`, đặt file env do tôi cấp vào `interactive/.worker.cli.env` trong thư mục cài; nếu thiếu file, dừng và báo `Thiếu .worker.cli.env`. Không đổi URL WSS, token hoặc binding task. Với backend mặc định, chỉ điền đường dẫn tuyệt đối trên PC cho `INTERACTIVE_CLI_CWD`, `INTERACTIVE_CLAUDE_EXECUTABLE` / `INTERACTIVE_CLAUDE_PROFILE_DIR` hoặc `INTERACTIVE_CODEX_EXECUTABLE` / `INTERACTIVE_CODEX_PROFILE_DIR`, và `INTERACTIVE_CLI_POLICY_EXECUTABLE` theo cấu hình đã được cấp. Dùng binary `.exe`, thư mục thử nghiệm và profile được phép; không sao chép credential hoặc ghi đè profile. Chưa có verifier hợp lệ thì báo thiếu verifier; nếu được yêu cầu, chỉ kiểm handshake với các trường CLI để trống. Không dùng verifier giả, không nới sandbox, không tắt TLS.
4. Từ `interactive/` trong thư mục cài, chạy foreground:

```powershell
node --env-file=.worker.cli.env worker.mjs --cli-wss
```

5. Báo `worker_ready` nếu có (chỉ là WSS đã kết nối). Trạng thái provider `ready` và task có thể nhận lượt được kiểm riêng phía server; không tự gửi chat Paperclip. Nếu lỗi, báo đúng giai đoạn và dòng lỗi đã che thông tin nhạy cảm. Không tự lặp setup trên thư mục cũ. Dừng worker bằng Ctrl+C khi được yêu cầu.
