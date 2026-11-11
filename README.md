# NextTool - Muse AI

Tool chạy trên máy tính để tạo **video** và **ảnh** hàng loạt trên [muse.ai](https://muse.ai) bằng nhiều tài khoản cùng lúc. Kết quả tự tải về máy.

- Tạo video / ảnh từ prompt hoặc từ ảnh tham chiếu
- Nhiều tài khoản chạy song song, tự chuyển tài khoản khi hết hạn mức hoặc cookie lỗi
- Sắp xếp theo dự án, tải nhiều file thành .zip
- Chạy trên **Windows** và **macOS**, tự cập nhật bản mới từ GitHub

---

## 1. Yêu cầu

- **Node.js 18 trở lên** (khuyên dùng bản LTS) — tải tại <https://nodejs.org>
- Kết nối mạng (lần cài đầu tiên tải khoảng 150 MB trình duyệt Chromium)
- Windows 10 trở lên, hoặc macOS

Kiểm tra đã có Node.js chưa: mở Terminal (macOS) hoặc Command Prompt (Windows) và gõ

```bash
node -v
```

Hiện ra số phiên bản (ví dụ `v22.11.0`) là được.

## 2. Tải tool về

**Cách 1 — Tải file ZIP (dễ nhất):** vào trang GitHub của tool → bấm nút xanh **Code** → **Download ZIP** → giải nén ra một thư mục, ví dụ `D:\NextTool-MuseAI` hoặc `~/NextTool-MuseAI`.

**Cách 2 — Dùng git:**

```bash
git clone https://github.com/dinhduan183/NextTool-MuseAI.git
```

## 3. Cài đặt và chạy

### Windows

Bấm đúp file **`ToolMuse-Windows.bat`** trong thư mục tool.

- Lần đầu: tự cài thư viện và Chromium (vài phút), sau đó tự mở tool.
- Những lần sau: bấm đúp là chạy ngay.
- Tool mở trong trình duyệt ở địa chỉ <http://localhost:3456>.
- **Giữ cửa sổ đen (Command Prompt) mở** trong lúc dùng. Đóng cửa sổ đó = tắt tool.

> Nếu Windows hiện cảnh báo "Windows protected your PC": bấm **More info** → **Run anyway**.

### macOS

Mở Terminal, vào thư mục tool rồi chạy:

```bash
cd ~/NextTool-MuseAI
```

```bash
npm install
```

```bash
npm start
```

`npm install` chỉ cần chạy lần đầu (tự cài cả Chromium). Những lần sau chỉ cần `npm start`. Tool tự mở trình duyệt ở <http://localhost:3456>. Muốn tắt tool: bấm `Ctrl + C` trong Terminal.

## 4. Thêm tài khoản muse.ai

Vào mục **Tài khoản** → **+ Thêm tài khoản**. Có 2 cách:

**Cách 1 — Đăng nhập trên tool (khuyên dùng)**

1. Nhập tên gợi nhớ (không bắt buộc).
2. Bấm **🔑 Đăng nhập muse.ai** → một cửa sổ muse.ai hiện ra.
3. Đăng nhập bình thường bằng email / số điện thoại.
4. Khi vào được trang chat của Muse, tool tự lấy cookie, lưu tài khoản và đóng cửa sổ.

Mật khẩu chỉ gõ trên trang muse.ai, tool không đọc và không lưu mật khẩu.

**Cách 2 — Dán cookie**

1. Cài tiện ích **Cookie-Editor** cho Chrome.
2. Mở muse.ai (đã đăng nhập) → bấm biểu tượng Cookie-Editor → **Export** → **JSON**.
3. Dán vào ô cookie trong tool → **Lưu & kiểm tra**.

Sau khi thêm, tool tự kiểm tra cookie và hạn mức. Thẻ tài khoản hiện **Sẵn sàng** là dùng được.

Khi cookie hết hạn, thẻ tài khoản báo **Cookie lỗi** và mục Tài khoản ở sidebar có số đỏ — bấm **🔑 Đăng nhập lại** trên thẻ đó.

## 5. Tạo video / ảnh

1. Chọn **Tạo video** hoặc **Tạo ảnh** ở sidebar, chọn hoặc tạo **dự án**.
2. Chọn **Từ Prompt** hoặc **Từ ảnh**.
3. Viết prompt — **để 1 dòng trống giữa các prompt**, mỗi prompt tạo 1 video/ảnh.
4. Chọn tỉ lệ, thời lượng (video), số bản → bấm **Tạo**.

Video/ảnh tạo xong tự lưu vào thư mục `output/<tên dự án>/`. Bấm **📁 Thư mục output** ở sidebar để mở.

## 6. Cập nhật bản mới

Tool tự kiểm tra bản mới trên GitHub (lúc mở và 6 tiếng một lần). Khi có bản mới, sidebar hiện ô **Có bản mới** → bấm **Cập nhật ngay**. Tool tự tải, cài và khởi động lại.

Có thể kiểm tra thủ công ở **Cài đặt → Phiên bản → Kiểm tra bản mới**.

Tài khoản, cookie, dự án và video/ảnh đã tạo được giữ nguyên khi cập nhật.

## 7. Dữ liệu và bảo mật

| Thư mục | Chứa gì |
|---|---|
| `data/` | Cookie tài khoản, danh sách việc, dự án, lịch sử prompt, ảnh đã upload |
| `output/` | Video và ảnh đã tạo |

- Tất cả chỉ lưu trên máy bạn, không gửi đi đâu ngoài muse.ai.
- **Không chia sẻ thư mục `data/`** — trong đó có cookie đăng nhập tài khoản.
- Chuyển sang máy khác: chép cả thư mục tool (có thể bỏ `node_modules/`), giữ `data/` nếu muốn giữ tài khoản.

## 8. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `node` không được nhận diện | Chưa cài Node.js, hoặc cần tắt mở lại Command Prompt / Terminal sau khi cài |
| Cài đặt bị lỗi giữa chừng | Kiểm tra mạng rồi chạy lại `npm install` (hoặc bấm lại file `.bat`) |
| Báo cổng 3456 đang bận | Tool đang chạy ở cửa sổ khác — đóng cửa sổ đó, hoặc mở thẳng <http://localhost:3456> |
| Thẻ tài khoản báo **Cookie lỗi** | Bấm **🔑 Đăng nhập lại** trên thẻ |
| Video chờ mãi không chạy | Xem dải cảnh báo đỏ — có thể không còn tài khoản khả dụng |
| Không thấy thông báo khi xong | Bật quyền thông báo trong cài đặt hệ thống, và bật **Cài đặt → Thông báo khi xong** |

---

## Dành cho người phát triển: phát hành bản mới

1. Sửa code.
2. Tăng `"version"` trong `package.json` (ví dụ `1.0.0` → `1.1.0`). Có thể thêm `"changelog": "Mô tả ngắn"` để hiện trong ô thông báo bản mới.
3. Đẩy lên nhánh `main`.

Các máy đang dùng tool sẽ thấy thông báo cập nhật.
