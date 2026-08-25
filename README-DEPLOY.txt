BIGBROVN - TRIỂN KHAI WEBSITE + UID TELEGRAM TỰ ĐỘNG

A. Triển khai đúng để chức năng UID hoạt động
1. Upload toàn bộ thư mục này lên repository GitHub.
2. Trong Netlify, chọn Add new project > Import an existing project > GitHub.
3. Chọn repository BIGBROVN và Deploy. Không chỉ kéo riêng index.html vì Netlify cần triển khai cả thư mục netlify/functions.
4. Trong Project configuration > Environment variables, thêm:
   TELEGRAM_BOT_TOKEN = token bot Telegram của bạn
   TELEGRAM_CHAT_ID = chat ID nhận yêu cầu UID
   ALLOWED_ORIGIN = https://bigbrovn.github.io
   Nếu Netlify hỏi scope, chọn Functions hoặc All scopes. Đánh dấu token là secret nếu giao diện có tùy chọn này.
5. Redeploy website sau khi thêm hoặc đổi biến môi trường.

B. Kết nối trang GitHub Pages với backend Netlify
1. Sau khi Netlify deploy xong, lấy địa chỉ dạng:
   https://TEN-SITE.netlify.app/api/uid-check
2. Mở file config.js.
3. Dán địa chỉ trên vào uidApi, ví dụ:
   uidApi: "https://TEN-SITE.netlify.app/api/uid-check"
4. Upload lại config.js lên GitHub Pages.
5. Mở trang Cách nhận. Nhãn UID phải chuyển từ "Chưa nối API" sang "Sẵn sàng gửi".

C. Chuẩn bị bot Telegram
1. Tạo bot bằng @BotFather và lưu token ở nơi riêng tư.
2. Mở cuộc trò chuyện với bot và nhấn Start hoặc gửi /start.
3. Trên Mac/VSCode Terminal, lấy chat ID mà không ghi token vào lịch sử lệnh:
   read -s TELEGRAM_BOT_TOKEN
   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
   unset TELEGRAM_BOT_TOKEN
4. Trong kết quả, tìm message > chat > id và đặt số đó vào TELEGRAM_CHAT_ID.
5. Không dán bot token trực tiếp vào index.html, config.js, GitHub hoặc tin nhắn.

D. Chạy và kiểm tra trong VSCode
1. Mở nguyên thư mục bigbrovn-netlify trong VSCode.
2. Cài Node.js nếu máy chưa có, sau đó mở Terminal của VSCode và chạy:
   npm install -g netlify-cli
3. Sao chép file .env.example thành .env rồi điền TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID thật.
4. Chạy:
   netlify dev
5. Mở địa chỉ Netlify CLI hiển thị, thường là http://localhost:8888.
6. Không dùng riêng Live Server để thử gửi UID vì Live Server không chạy Netlify Function.

Lưu ý
- index.html phải nằm ở cấp ngoài cùng của repository.
- Giữ nguyên netlify/functions/uid-check.mjs và netlify.toml.
- Upload cả privacy.html, terms.html và thư mục assets để liên kết pháp lý và ảnh chia sẻ hoạt động.
- Trợ lý nhận back phí có 4 bước: chọn đối tác, chọn loại tài khoản, xác nhận link/mã và gửi UID.
- Ở bước 1, chọn nhóm ngay phía trên ô đối tác; danh sách đối tác tự lọc theo nhóm và thông tin được giữ lại đến bước UID.
- Form UID không hỏi tên; khách có thể ẩn danh. Form chỉ yêu cầu UID, kênh và thông tin liên hệ để nhận phản hồi.
- Bản nháp UID và bước đang làm được lưu trên trình duyệt; gửi thành công sẽ lưu mã yêu cầu gần nhất.
- Không yêu cầu khách nhập mật khẩu, OTP, seed phrase hoặc private key.
- File .env đã được chặn khỏi Git để tránh làm lộ bot token.
