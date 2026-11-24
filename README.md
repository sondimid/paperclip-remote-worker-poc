# Paperclip Remote Worker PoC

Paperclip gửi tin từ **Chat của một task thường** tới Codex CLI hoặc Claude Code chạy trên một máy khác. Worker chủ động kết nối WSS; không cần SSH hoặc cổng inbound trên máy worker. Đây là PoC độc lập, không phải tích hợp chính thức của Paperclip, OpenAI hay Anthropic.

```text
Paperclip task Chat → Process Bridge → Broker ← WSS outbound từ worker → CLI local
```

## Thử local, không gọi model

Dùng Node.js 22+ và OpenSSL cho fixture TLS. Từ gốc repo:

```powershell
npm --prefix interactive ci --ignore-scripts --no-audit --no-fund
```

```powershell
npm --prefix interactive test
```

Fixture kiểm hai adapter, resume, đổi provider, reconnect/mất ACK, phản hồi Unicode dài và việc lưu một reply kèm attachment vào Paperclip mock. Đường V1 App Server được giữ để chạy hồi quy. **Không cần token, tài khoản hay Paperclip đang chạy để chạy bộ test.**

## Chỉ mở terminal Codex / Claude Code từ server

Chế độ này **độc lập với Paperclip Chat**: server chọn CLI và alias thư mục → Broker gửi yêu cầu qua WSS → PC Windows mở CLI tương tác trong phiên desktop đang đăng nhập. Bạn gõ trực tiếp trên PC. Không chuyển màn hình, prompt, phím gõ hay output về server. Kết nối hoặc reconnect không tự mở terminal.

**Server:** Dùng Node.js 22+ và cài dependency như trên. Từ `interactive/`, sao chép [mẫu Broker](interactive/.terminal-broker.env.example) và [mẫu operator](interactive/.terminal-operator.env.example) thành `.terminal-broker.env` và `.terminal-operator.env`. Tạo hai token **riêng**, ngẫu nhiên (ít nhất 32 byte mỗi token); chỉ chuyển worker token sang PC qua kênh riêng. Nếu đổi port `3116`, cập nhật URL operator và upstream Caddy tương ứng. Khởi động Broker:

```powershell
node --env-file=.terminal-broker.env terminal/broker.mjs
```

Dùng [mẫu Caddy](interactive/Caddyfile.wss.example) với **hostname riêng**, chứng chỉ TLS hợp lệ và upstream `127.0.0.1:3116`. Mẫu chỉ proxy `GET /worker/connect` có WebSocket Upgrade; giữ các route `/terminal/*` ở loopback, không publish chúng. Không cần mở cổng inbound trên PC. Chỉ cấp WSS cho PC được phép và dừng worker khi không còn cần mở CLI từ xa.

**PC Windows:** Từ `interactive/`, sao chép [mẫu worker](interactive/.terminal-worker.env.example) thành `.terminal-worker.env`. Đặt WSS URL, worker ID và worker token khớp Broker. Điền đường dẫn tuyệt đối tới ít nhất một native `.exe` (không dùng `.cmd`) và các thư mục local tồn tại, đáng tin cậy. `TERMINAL_WORKSPACES` là JSON `alias → đường dẫn`, ví dụ `{"scratch":"C:/work/scratch"}`; server chỉ thấy alias. Worker không thay profile, quyền hay sandbox của CLI. Nếu dùng CA riêng, cấu hình file CA đã xác minh; không tắt TLS verification. Chạy trong terminal của **tài khoản đang đăng nhập desktop**, không phải Windows Service:

```powershell
node --env-file=.terminal-worker.env terminal/worker.mjs
```

**Chọn trên server:** `list` hiện CLI và alias đã cấu hình, không xác nhận login hay GUI. `open` in UUID để tra lại; chỉ chạy khi bạn muốn mở thêm một cửa sổ:

```powershell
node --env-file=.terminal-operator.env terminal/operator.mjs list
```

```powershell
node --env-file=.terminal-operator.env terminal/operator.mjs open codex scratch
```

Dùng `claude` thay `codex` nếu đã cấu hình. Thay `REQUEST-UUID` bằng ID lệnh `open` đã in:

```powershell
node --env-file=.terminal-operator.env terminal/operator.mjs status 'REQUEST-UUID'
```

- `pending`: đang chờ PC trả kết quả. `spawned`: Windows báo tạo tiến trình, **không** xác nhận cửa sổ hiển thị, TUI hay đăng nhập. `failed`: worker từ chối hoặc launcher báo lỗi (ví dụ thư mục đã mất hay đổi đích); không tự chọn CWD khác.
- `unknown`: không xác nhận được kết quả. Kiểm PC trước khi gửi `open` mới. Không queue offline hoặc tự gửi lại sau reconnect; lưu ID tối đa 128 yêu cầu trong RAM, 5 phút từ kết quả, không giữ qua restart.
- PoC hỗ trợ một worker Windows và một lần mở đang chờ. Không hỗ trợ điều khiển CLI từ xa hay launcher macOS trong chế độ này.
- **Smoke Windows 11 (23/11/2026):** Broker và worker chạy thành hai tiến trình, kết nối WSS qua TLS loopback. `open codex lab` mở Codex native; terminal hiển thị đúng thư mục lab riêng và Codex trả lời đúng một prompt tính nhẩm (`922143`). Prompt được nhập tại console local, không gửi qua Broker. Chưa nghiệm thu Claude Code thật, Caddy hoặc máy thứ hai cho chế độ này.

## Kết nối thử giữa hai máy — Paperclip Chat V2

### Server

1. Dùng một **instance test**. Tạo project, task thường (`backlog`) và agent `Process (legacy)` dành riêng. Tắt timer/routine; giữ wake qua comment. Chỉ cấp quyền vào task cho người thử. Tích hợp Process, run JWT và API attachment được đối chiếu theo Paperclip `v2026.1106.0`; kiểm lại nếu dùng bản khác.
2. Trong [`interactive/`](interactive/), tạo `.compose.wss.env`, `.broker.wss.env` và `.bridge.wss.env` từ [mẫu Compose](interactive/.compose.wss.env.example), [mẫu Broker](interactive/.broker.env.example) và [mẫu Bridge](interactive/.bridge.wss.env.example). Đặt `INTERACTIVE_WIRE_VERSION=2` ở Broker và Bridge. Đặt `INTERACTIVE_CHAT_USER_ID` về đúng ID người dùng test. Chọn mạng Docker riêng mà Paperclip runtime tham gia; không cấp quyền cấu hình Process cho người không tin cậy.
3. Đặt `INTERACTIVE_BINDING` là JSON một dòng với `companyId`, `projectId`, `agentId`, `issueId` (UUID), `workspaceId` bằng `interactive-sample` và `workerId` là alias. Tạo ba token riêng, ngẫu nhiên, mỗi token ít nhất 32 byte. Chỉ Bridge và Broker cùng biết Bridge token; chỉ gửi worker token sang PC qua kênh riêng.
4. Từ `interactive/`, kiểm cấu hình rồi build và chạy Broker. Mẫu publish port `3113` chỉ trên loopback; nếu cổng đã có service, chọn cổng khác và chỉnh upstream Caddy cho khớp. Không thay cấu hình hay tag image của stack đang chạy.

```powershell
docker compose -p paperclip-remote-worker-poc --env-file .compose.wss.env -f compose.wss.yaml config --quiet
```

```powershell
docker compose -p paperclip-remote-worker-poc --env-file .compose.wss.env -f compose.wss.yaml build broker
```

```powershell
docker compose -p paperclip-remote-worker-poc --env-file .compose.wss.env -f compose.wss.yaml up -d --wait broker
```

5. Dùng [mẫu Caddy](interactive/Caddyfile.wss.example) với hostname/chứng chỉ hợp lệ. Chỉ đưa route `GET /worker/connect` có WebSocket Upgrade ra ngoài. Không expose `/arm`, `/worker/status`, `/readiness`, `/runs`, Paperclip UI hay API qua endpoint đó.
6. Trong runtime của Paperclip, mount read-only [`protocol.mjs`](protocol.mjs), [`interactive/protocol.mjs`](interactive/protocol.mjs), [`interactive/bridge.mjs`](interactive/bridge.mjs) và `.bridge.wss.env` theo đúng cấu trúc thư mục. Ví dụ nếu mount vào `/opt/remote-worker-poc`, cấu hình Process `command: node`, `cwd` là thư mục có thật trong runtime, timeout 165 giây, và `args`:

```json
[
  "--env-file=/opt/remote-worker-poc/interactive/.bridge.wss.env",
  "/opt/remote-worker-poc/interactive/bridge.mjs",
  "<project UUID>",
  "<task UUID>"
]
```

Paperclip tự cấp run JWT cho Bridge; không đưa JWT tĩnh, operator token hoặc worker token vào Process config.

### PC worker

**Windows:** Copy [prompt setup worker](interactive/WORKER-SETUP-PROMPT.md) sau khi điền SHA public chứa [`setup-worker.ps1`](interactive/setup-worker.ps1). Script tải đúng commit, cài `ws` từ lockfile vào `interactive/`, không chạm thư mục có sẵn và không tự chạy worker. PC nhận `.worker.cli.env` qua kênh riêng và dùng CLI/profile/verifier được cấp; không cần tài khoản Paperclip/Board. Process Bridge và token Bridge/operator chỉ ở phía server.

1. Dùng script setup Windows hoặc clone repo và cài dependency như trên, rồi vào `interactive/`. Nhận `.worker.cli.env` qua kênh riêng. Nếu tự vận hành cả server, tạo file từ [mẫu worker](interactive/.worker.cli.env.example) với WSS URL, worker token và JSON `INTERACTIVE_WORKSPACE_PROFILE` gồm đúng `issueId` và `workspaceId: "interactive-sample"`. Chỉ cấu hình CA nếu server dùng CA riêng đã được xác minh. Không tắt xác minh TLS.
2. Chạy:

```powershell
node --env-file=.worker.cli.env worker.mjs --cli-wss
```

3. **`worker_ready` = WSS đã kết nối, chưa có nghĩa CLI nhận việc.** Có thể bỏ trống cấu hình CLI để chỉ thử handshake. `unsupported`, `policy_unverified` và `auth_unverified` không được giao lượt. Với backend CLI mặc định, dùng binary tuyệt đối (native `.exe` trên Windows), workspace test và verifier confinement độc lập do operator cung cấp. Không dùng stub để bật dispatch. Lab Codex App Server bên dưới có phép kiểm riêng.
4. **Codex có thể dùng profile đã đăng nhập.** Đặt `INTERACTIVE_CODEX_PROFILE_DIR` thành đường dẫn tuyệt đối tới `CODEX_HOME` của phiên Codex đang dùng (thường là thư mục `.codex` dưới thư mục người dùng). Không để trống hoặc chép credential. Verifier vẫn phải kiểm đúng profile được chọn cùng với sandbox, hooks/MCP và quyền truy cập. Worker nạp `CODEX_HOME` từ đường dẫn này nhưng không kế thừa toàn bộ môi trường terminal; chỉ coi auth đã qua khi probe của worker xác nhận. Codex có thể ghi session mới vào profile này. Cấu hình Claude Code không thay đổi.

**Lab Windows 11 với Codex App Server:** Đặt `INTERACTIVE_CODEX_BACKEND=app-server` trong `.worker.cli.env` và nạp thêm `.codex-chat.env` của lab. File thứ hai chứa `INTERACTIVE_CODEX_EXE`, `INTERACTIVE_CODEX_ROOT`, `INTERACTIVE_CODEX_WORKSPACE` của profile `paperclip-fixture` đã được chuẩn bị và đăng nhập riêng. Không trỏ tới profile mặc định. Backend này kiểm quyền đọc/ghi/mạng qua chính App Server trước mỗi lượt; nó không dùng verifier của `exec`. Không đổi cách chạy Claude, wire version, Bridge hay Broker.

```powershell
node --env-file=.worker.cli.env --env-file=.codex-chat.env worker.mjs --cli-wss
```

### Khi có CLI `ready`

Trên server, arm task từ trong container Broker, không in token:

```powershell
docker compose -p paperclip-remote-worker-poc --env-file .compose.wss.env -f compose.wss.yaml exec -T broker node -e "const {INTERACTIVE_BINDING,INTERACTIVE_OPERATOR_TOKEN}=process.env;fetch('http://127.0.0.1:3113/arm',{method:'POST',headers:{Authorization:'Bearer '+INTERACTIVE_OPERATOR_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({issueId:JSON.parse(INTERACTIVE_BINDING).issueId}),signal:AbortSignal.timeout(4000)}).then(r=>{console.log('arm HTTP '+r.status);process.exitCode=r.ok?0:1},()=>{console.error('arm request failed');process.exitCode=1})"
```

Gán agent vào task test và giữ `backlog`. Trong Chat, gửi `/codex …` hoặc `/claude …`. Đợi reply rồi gửi tin không prefix để kiểm resume. Đổi prefix bắt đầu hội thoại mới trong cùng task, không chuyển lịch sử giữa hai CLI. Tiến độ đi vào run log; chưa xác nhận live delta trong bubble. Kết quả dài hơn 8 KiB được gắn dưới dạng `.txt` nếu nằm trong trần 256 KiB.

## Giới hạn

- Một worker, một task, một workspace, một lượt đồng thời; Broker giữ dữ liệu trong RAM. Restart giữa lượt có thể thành `unknown`, không tự chạy lại.
- **Lab V2 Windows 11 (23/11/2026):** qua WSS loopback, Codex App Server `0.166.0` nhận một tin từ task Chat và trả đáp án đúng theo lịch sử native. Khi chạy lại, UI xác nhận gửi thành công nhưng Codex trả `usage_limit_exceeded` ở lượt đầu; không tự gửi lại hay gửi lượt hai. Preflight `ready` kiểm đăng nhập và sandbox, không kiểm quota model. Chưa xác nhận reply lưu về Paperclip, resume hai lượt V2, Codex trên Win10/macOS, Claude Code thật, attachment bằng JWT thật hoặc live delta trong Chat. Cờ read-only/no-tools không thay sandbox hệ điều hành.
- Không bật Internet ingress, cho chạy model hoặc dùng workspace thật chỉ để thử fixture. Broker và operator là các bên được tin cậy; không dùng PoC này như nền tảng multi-tenant.
