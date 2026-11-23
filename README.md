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

## Kết nối thử giữa hai máy

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

1. Clone repo, cài dependency như trên, rồi vào `interactive/`. Tạo `.worker.cli.env` từ [mẫu worker](interactive/.worker.cli.env.example). Điền WSS URL, worker token và JSON `INTERACTIVE_WORKSPACE_PROFILE` gồm đúng `issueId` và `workspaceId: "interactive-sample"`. Chỉ cấu hình CA nếu server dùng CA riêng đã được xác minh. Không tắt xác minh TLS.
2. Chạy:

```powershell
node --env-file=.worker.cli.env worker.mjs --cli-wss
```

3. **`worker_ready` = WSS đã kết nối, chưa có nghĩa CLI nhận việc.** Có thể bỏ trống cấu hình CLI để chỉ thử handshake. `unsupported`, `policy_unverified` và `auth_unverified` không được giao lượt. Để nhận việc, dùng binary tuyệt đối (native `.exe` trên Windows), workspace test, profile riêng đã đăng nhập và verifier confinement độc lập do operator cung cấp. Không có verifier thật đi kèm repo; không dùng stub để bật dispatch.

### Khi có CLI `ready`

Trên server, arm task từ trong container Broker, không in token:

```powershell
docker compose -p paperclip-remote-worker-poc --env-file .compose.wss.env -f compose.wss.yaml exec -T broker node -e "const {INTERACTIVE_BINDING,INTERACTIVE_OPERATOR_TOKEN}=process.env;fetch('http://127.0.0.1:3113/arm',{method:'POST',headers:{Authorization:'Bearer '+INTERACTIVE_OPERATOR_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({issueId:JSON.parse(INTERACTIVE_BINDING).issueId}),signal:AbortSignal.timeout(4000)}).then(r=>{console.log('arm HTTP '+r.status);process.exitCode=r.ok?0:1},()=>{console.error('arm request failed');process.exitCode=1})"
```

Gán agent vào task test và giữ `backlog`. Trong Chat, gửi `/codex …` hoặc `/claude …`. Đợi reply rồi gửi tin không prefix để kiểm resume. Đổi prefix bắt đầu hội thoại mới trong cùng task, không chuyển lịch sử giữa hai CLI. Tiến độ đi vào run log; chưa xác nhận live delta trong bubble. Kết quả dài hơn 8 KiB được gắn dưới dạng `.txt` nếu nằm trong trần 256 KiB.

## Giới hạn

- Một worker, một task, một workspace, một lượt đồng thời; Broker giữ dữ liệu trong RAM. Restart giữa lượt có thể thành `unknown`, không tự chạy lại.
- PoC chỉ được kiểm bằng fixture V2 và TLS loopback. Chưa nghiệm thu model thật trên Win10/macOS, quyền attachment bằng JWT thật hoặc UI khi run đang hoạt động. Cờ read-only/no-tools không thay sandbox hệ điều hành.
- Không bật Internet ingress, cho chạy model hoặc dùng workspace thật chỉ để thử fixture. Broker và operator là các bên được tin cậy; không dùng PoC này như nền tảng multi-tenant.
