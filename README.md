# VieNeu Read Aloud — Extension Đọc PDF Tiếng Việt (EN → VI)

Extension Chrome/Edge (Manifest V3) giúp đọc các tài liệu PDF tiếng Anh (bài báo khoa học 2 cột, arXiv, giáo trình, PDF trên máy tính) bằng **giọng tiếng Việt 48kHz từ [pnnbao97/VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS)** chạy local, kèm:

- **Highlight 3 tầng đồng bộ**: Đoạn văn (Paragraph) + Câu văn (Sentence) + Từ đang đọc (Word) trực tiếp trên PDF, cộng thêm thanh phụ đề tiếng Việt đồng bộ từng từ (karaoke) và chế độ **Tập trung (Focus Dim)** làm mờ vùng xung quanh.
- **Tự động bỏ qua nội dung nhiễu**: Tự động nhận diện và bỏ qua Running Header, Footer, Số trang, Footnote cuối trang, nhãn văn bản bên trong Hình vẽ/Biểu đồ (Figures) và chú thích `Figure N:` / `Table N:`. Hỗ trợ bật lớp xem trước các vùng đã bỏ qua để kiểm chứng trực quan.
- **Nhận diện bố cục 2 cột**: Đọc chuẩn thứ tự cột trái → cột phải cho các bài báo khoa học (ICML, NeurIPS, CVPR, arXiv).
- **Tận dụng sẵn VieNeu-TTS trong OpenMAIC**: Backend tự động dùng lại `.venv` đã cài tại `D:\Vscode-luyện code\OpenMAIC\vieneu-server\.venv` và tự động proxy nếu server OpenMAIC (`:8000`) đang bật để tiết kiệm RAM, hoặc tự nạp mô hình `VieNeu-TTS v3 Turbo (int8)` ngay trong tiến trình.
- **Instant Voice Cloning**: Hỗ trợ dùng các giọng mẫu tiếng Việt (Hải Đăng, Trúc Ly, Mai Anh, Thiện Minh...) hoặc tải lên file `.wav` (3–10 giây) để clone giọng ngay trong bảng tùy chọn.
- **Prefetch & Cache LRU**: Tự động dịch và tổng hợp trước 2 câu tiếp theo trong khi đang phát, đồng thời lưu cache trên ổ đĩa để tua lại không có độ trễ.

---

## 1. Khởi động máy chủ VieNeu-TTS local

Chạy trực tiếp file khởi động nhanh (tự dùng lại môi trường Python của `OpenMAIC`):

```bat
start-vieneu-readaloud.bat
```

Hoặc bằng PowerShell:

```powershell
.\start-vieneu-readaloud.ps1
```

Máy chủ sẽ lắng nghe tại `http://127.0.0.1:8765` (kiểm tra trạng thái: `GET http://127.0.0.1:8765/health`).

## 2. Cài đặt Extension vào Chrome / Edge

1. Mở `chrome://extensions/` (hoặc `edge://extensions/`).
2. Bật chế độ **Developer mode** (Chế độ dành cho nhà phát triển) ở góc phải trên.
3. Chọn **Load unpacked** (Tải tiện ích đã giải nén) → trỏ tới thư mục:
   ```
   d:\Vscode-luyện code\Read_Aloud\extension\dist
   ```
4. *(Khuyên dùng cho PDF lưu trên máy)*: Nhấn **Details** (Chi tiết) của extension → bật **Allow access to file URLs** (Cho phép truy cập vào các URL tệp).

## 3. Cách sử dụng

- **Đọc PDF online (arXiv, web)**: Mở tab PDF → bấm icon **VieNeu Read Aloud** trên thanh trình duyệt → chọn **Đọc PDF ở tab hiện tại** (hoặc bật *Tự động mở link PDF* trong popup, hoặc chuột phải vào link PDF → *Đọc PDF này bằng VieNeu Read Aloud VI*).
- **Đọc PDF trên máy tính**: Mở **VieNeu PDF Reader** từ popup rồi kéo thả file `.pdf` vào cửa sổ, hoặc chọn từ máy tính.
- **Phím tắt**:
  - `Space`: Phát / Tạm dừng
  - `←` / `→`: Câu trước / Câu tiếp theo
  - `F`: Bật/tắt chế độ Tập trung (Focus Dim)
  - `C`: Bật/tắt thanh phụ đề tiếng Việt
  - `S`: Bật/tắt lớp hiển thị các vùng đã tự động bỏ qua
  - `Click` vào bất kỳ câu nào trên PDF để đọc ngay từ câu đó.

## 4. Phát triển & Kiểm thử

```powershell
# Chạy unit test backend (15 tests)
$env:VIENEU_WARMUP='0'
& 'D:\Vscode-luyện code\OpenMAIC\vieneu-server\.venv\Scripts\python.exe' -m unittest discover -s backend/tests -p 'test_*.py' -v

# Chạy unit test & build extension (8 tests + esbuild bundle)
cd extension
npm test
npm run build
```
