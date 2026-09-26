# filedrop-shop

Web bán file số có backend thật: mọi khách xem chung một danh sách sản phẩm,
chỉ admin (đăng nhập bằng mật khẩu) mới thêm/sửa/xoá được. Đơn hàng thẻ cào /
thẻ ngân hàng được ghi lại để admin duyệt thủ công rồi gửi link tải qua email.

## Cấu trúc
```
filedrop-shop/
  server.js         <- server Express (API + phục vụ trang web)
  package.json
  .env.example       <- copy thành .env rồi đổi mật khẩu
  data/
    products.json    <- "cơ sở dữ liệu" sản phẩm (file JSON)
    orders.json       <- sẽ tự tạo khi có đơn hàng đầu tiên
  public/
    index.html        <- trang bán hàng công khai
    admin.html         <- trang quản trị (cần mật khẩu)
```

## Chạy thử trên máy của bạn
Cần cài Node.js (>=18) trước: https://nodejs.org

```bash
cd filedrop-shop
npm install
cp .env.example .env
# mở file .env, đổi ADMIN_PASSWORD và JWT_SECRET thành giá trị của riêng bạn
npm start
```
Mở trình duyệt: `http://localhost:3000` (trang bán hàng) và
`http://localhost:3000/admin.html` (trang quản trị, đăng nhập bằng
ADMIN_PASSWORD bạn vừa đặt trong `.env`).

## Deploy miễn phí lên Render.com (khuyên dùng vì có ổ đĩa lưu file JSON)
1. Đưa thư mục này lên một repo GitHub (tạo repo mới, push code lên).
2. Vào https://render.com → tạo tài khoản → **New +** → **Web Service**.
3. Kết nối repo GitHub vừa tạo.
4. Cấu hình:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Vào tab **Environment**, thêm 2 biến:
   - `ADMIN_PASSWORD` = mật khẩu bạn muốn dùng
   - `JWT_SECRET` = một chuỗi ngẫu nhiên dài (ví dụ tự gõ lung tung 40 ký tự)
6. Vào tab **Disks**, thêm 1 ổ đĩa (Disk), mount vào đường dẫn `/opt/render/project/src/data`
   — bước này **bắt buộc**, nếu không dữ liệu sản phẩm/đơn hàng sẽ mất mỗi khi
   Render khởi động lại server.
7. Bấm **Deploy**. Sau khi xong, Render cho bạn 1 link dạng
   `https://ten-cua-ban.onrender.com` — đây là link công khai, ai bấm vào cũng
   thấy đúng dữ liệu mới nhất bạn cập nhật qua trang `/admin.html`.

> Lưu ý: gói miễn phí của Render sẽ "ngủ" sau một thời gian không có khách
> truy cập, lần mở lại đầu tiên có thể chậm khoảng 30-50 giây. Muốn nhanh và
> ổn định hơn thì nâng cấp gói trả phí, hoặc dùng Railway.app (cách làm tương tự).

## Về thanh toán
Trang này **ghi nhận** đơn hàng (email, sản phẩm, thông tin thẻ cào/thẻ đã
nhập) chứ **chưa tự động xác nhận thanh toán thật**. Quy trình thực tế:
khách đặt đơn → admin vào `/admin.html` xem thông tin thẻ cào khách gửi →
tự kiểm tra thẻ đó hợp lệ (qua tài khoản nhà mạng của bạn hoặc dịch vụ đối
soát bạn đăng ký chính chủ) → đổi trạng thái đơn thành `completed` → tự gửi
link tải cho khách qua email.

Nếu sau này bạn muốn tự động hoá bước xác nhận thẻ cào hoặc chuyển sang cổng
thanh toán thật (VNPay, Momo, PayPal...), mỗi cổng đều cần bạn đăng ký tài
khoản doanh nghiệp/merchant riêng và có tài liệu tích hợp riêng — lúc đó
mình có thể giúp viết phần code gọi API của cổng đó.

## Nâng cấp gợi ý cho sau này
- Đổi từ file JSON sang cơ sở dữ liệu thật (PostgreSQL/MongoDB) khi có nhiều
  đơn hàng, để tránh việc ghi file đồng thời gây lỗi.
- Thêm gửi email tự động (ví dụ qua Resend hoặc Nodemailer) khi đơn được duyệt.
- Thêm HTTPS + tên miền riêng (Render/Railway đều hỗ trợ gắn domain miễn phí).
