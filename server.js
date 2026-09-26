require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'doi-chuoi-bi-mat-nay';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

const PRODUCTS_FILE = path.join(__dirname, 'data', 'products.json');
const ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

const DEFAULT_SETTINGS = {
  siteName: 'filedrop',
  heroTitle: 'Tải file, không phải chờ đợi.',
  heroSubtitle: 'Template, tài liệu và asset chất lượng — mua một lần, tải về ngay.',
  footerText: 'filedrop — kho file số',
  colors: { bg: '#120a26', pink: '#ff3fa4', cyan: '#22e0ff', lime: '#9dff5c' },
};

// ---------- Gửi email OTP qua Gmail ----------
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});
async function sendOtpEmail(toEmail, code) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn('Chưa cấu hình GMAIL_USER/GMAIL_APP_PASSWORD trong .env — không gửi được email thật. Mã OTP (chỉ hiện ở log server):', code);
    return;
  }
  await mailTransporter.sendMail({
    from: `"filedrop" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Mã xác thực đăng ký filedrop',
    html: `<p>Mã xác thực của bạn là:</p><h2 style="letter-spacing:4px;">${code}</h2><p>Mã có hiệu lực trong 10 phút. Nếu không phải bạn yêu cầu, hãy bỏ qua email này.</p>`,
  });
}

// Lưu tạm các yêu cầu đăng ký đang chờ xác thực OTP (trong bộ nhớ, mất khi restart server)
const pendingRegistrations = new Map(); // email -> { code, expiresAt, data }
function genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers: đọc/ghi file JSON làm "cơ sở dữ liệu" ----------
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error('Lỗi đọc file', file, e);
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------- Middleware xác thực admin ----------
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Thiếu token đăng nhập' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
  }
}

// ---------- Đăng nhập admin ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Sai mật khẩu' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// ---------- Sản phẩm (công khai: xem | admin: thêm/sửa/xoá) ----------
app.get('/api/products', (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  // Không trả fileUrl công khai - chỉ lộ ra sau khi đơn hàng được duyệt (xem /api/my-orders)
  res.json(products.map(({ fileUrl, ...rest }) => rest));
});

// Admin xem đầy đủ sản phẩm (bao gồm cả link tải) để chỉnh sửa
app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(readJSON(PRODUCTS_FILE, []));
});

app.post('/api/products', requireAdmin, (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const { ext, name, desc, size, price, fileUrl } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Thiếu tên file' });
  const nextId = products.length ? Math.max(...products.map(p => p.id)) + 1 : 1;
  const product = { id: nextId, ext: ext || '.zip', name, desc: desc || '', size: size || '—', price: Number(price) || 0, fileUrl: fileUrl || '' };
  products.push(product);
  writeJSON(PRODUCTS_FILE, products);
  res.status(201).json(product);
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const id = Number(req.params.id);
  const idx = products.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
  products[idx] = { ...products[idx], ...req.body, id };
  writeJSON(PRODUCTS_FILE, products);
  res.json(products[idx]);
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  let products = readJSON(PRODUCTS_FILE, []);
  const id = Number(req.params.id);
  products = products.filter(p => p.id !== id);
  writeJSON(PRODUCTS_FILE, products);
  res.json({ ok: true });
});

// ---------- Cài đặt giao diện & nội dung web (công khai: xem | admin: sửa) ----------
app.get('/api/settings', (req, res) => {
  res.json(readJSON(SETTINGS_FILE, DEFAULT_SETTINGS));
});
app.put('/api/settings', requireAdmin, (req, res) => {
  const current = readJSON(SETTINGS_FILE, DEFAULT_SETTINGS);
  const updated = { ...current, ...req.body, colors: { ...current.colors, ...(req.body.colors || {}) } };
  writeJSON(SETTINGS_FILE, updated);
  res.json(updated);
});

// ---------- Quản lý tài khoản khách & số dư ví (chỉ admin) ----------
app.get('/api/users', requireAdmin, (req, res) => {
  const users = readJSON(USERS_FILE, []);
  res.json(users.map(u => ({ id: u.id, name: u.name, username: u.username, email: u.email, balance: u.balance || 0 })));
});
app.put('/api/users/:id/balance', requireAdmin, (req, res) => {
  const users = readJSON(USERS_FILE, []);
  const id = Number(req.params.id);
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  const delta = Number(req.body.delta) || 0;
  users[idx].balance = (users[idx].balance || 0) + delta;
  writeJSON(USERS_FILE, users);
  res.json({ id: users[idx].id, name: users[idx].name, balance: users[idx].balance });
});

// ---------- Middleware xác thực khách hàng (user thường) ----------
function requireUser(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'user') throw new Error('sai role');
    req.userId = payload.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
  }
}
// Xác thực "mềm": nếu có token hợp lệ thì gắn userId, không có/lỗi thì vẫn cho qua (khách vãng lai)
function attachUserIfAny(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.role === 'user') req.userId = payload.userId;
    } catch (e) { /* bỏ qua, coi như khách vãng lai */ }
  }
  next();
}

// ---------- Đăng ký / đăng nhập khách hàng ----------
// ---------- Đăng ký khách hàng (2 bước: gửi OTP -> xác nhận OTP) ----------
app.post('/api/register/request-otp', async (req, res) => {
  const { name, username, email, phone, password } = req.body || {};
  if (!name || !username || !email || !password) {
    return res.status(400).json({ error: 'Vui lòng điền đủ thông tin bắt buộc' });
  }
  const users = readJSON(USERS_FILE, []);
  if (users.some(u => u.username === username)) {
    return res.status(400).json({ error: 'Tên đăng nhập đã được dùng' });
  }
  if (users.some(u => u.email === email)) {
    return res.status(400).json({ error: 'Email đã được đăng ký' });
  }
  const code = genOtp();
  const passwordHash = await bcrypt.hash(password, 10);
  pendingRegistrations.set(email, {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 phút
    data: { name, username, email, phone: phone || '', passwordHash },
  });
  try {
    await sendOtpEmail(email, code);
  } catch (e) {
    console.error('Lỗi gửi email OTP:', e.message);
    return res.status(500).json({ error: 'Không gửi được email OTP. Kiểm tra lại cấu hình GMAIL trong .env.' });
  }
  res.json({ ok: true });
});

app.post('/api/register/verify-otp', (req, res) => {
  const { email, code } = req.body || {};
  const pending = pendingRegistrations.get(email);
  if (!pending) return res.status(400).json({ error: 'Không tìm thấy yêu cầu đăng ký. Vui lòng đăng ký lại.' });
  if (Date.now() > pending.expiresAt) {
    pendingRegistrations.delete(email);
    return res.status(400).json({ error: 'Mã OTP đã hết hạn. Vui lòng đăng ký lại.' });
  }
  if (pending.code !== code) return res.status(400).json({ error: 'Mã OTP không đúng' });

  const users = readJSON(USERS_FILE, []);
  const nextId = users.length ? Math.max(...users.map(u => u.id)) + 1 : 1;
  const user = { id: nextId, ...pending.data };
  users.push(user);
  writeJSON(USERS_FILE, users);
  pendingRegistrations.delete(email);

  const token = jwt.sign({ role: 'user', userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const users = readJSON(USERS_FILE, []);
  const user = users.find(u => u.username === username || u.email === username);
  if (!user) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  const token = jwt.sign({ role: 'user', userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.get('/api/me', requireUser, (req, res) => {
  const users = readJSON(USERS_FILE, []);
  const user = users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  res.json({ id: user.id, name: user.name, username: user.username, email: user.email, phone: user.phone || '', balance: user.balance || 0 });
});

app.put('/api/me/password', requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Thiếu mật khẩu hiện tại hoặc mật khẩu mới' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Mật khẩu mới cần ít nhất 6 ký tự' });
  const users = readJSON(USERS_FILE, []);
  const idx = users.findIndex(u => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  const ok = await bcrypt.compare(currentPassword, users[idx].passwordHash);
  if (!ok) return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
  users[idx].passwordHash = await bcrypt.hash(newPassword, 10);
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

app.get('/api/my-orders', requireUser, (req, res) => {
  const orders = readJSON(ORDERS_FILE, []).filter(o => o.userId === req.userId);
  const products = readJSON(PRODUCTS_FILE, []);
  const withLinks = orders.map(o => ({
    ...o,
    items: o.itemIds.map(id => {
      const p = products.find(p => p.id === id);
      return {
        id,
        name: p ? p.name : '(sản phẩm đã bị xoá)',
        fileUrl: (o.status === 'completed' && p) ? p.fileUrl || '' : '',
      };
    }),
  }));
  res.json(withLinks);
});


// ---------- Đơn hàng (khách tạo | admin xem & duyệt) ----------
app.post('/api/orders', attachUserIfAny, (req, res) => {
  const orders = readJSON(ORDERS_FILE, []);
  const { email, itemIds, paymentMethod, paymentDetail, total } = req.body || {};
  if (!email || !Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: 'Thiếu email hoặc danh sách sản phẩm' });
  }

  let status = 'pending';
  if (paymentMethod === 'balance') {
    if (!req.userId) return res.status(401).json({ error: 'Cần đăng nhập để dùng số dư ví' });
    const users = readJSON(USERS_FILE, []);
    const idx = users.findIndex(u => u.id === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    const balance = users[idx].balance || 0;
    if (balance < Number(total)) return res.status(400).json({ error: 'Số dư ví không đủ' });
    users[idx].balance = balance - Number(total);
    writeJSON(USERS_FILE, users);
    status = 'completed'; // trừ ví thành công -> coi như đã thanh toán ngay
  }

  const order = {
    id: crypto.randomUUID(),
    userId: req.userId || null,
    email,
    itemIds,
    paymentMethod: paymentMethod || 'unknown',
    paymentDetail: paymentDetail || {},
    total: Number(total) || 0,
    status, // pending | completed | rejected
    createdAt: new Date().toISOString(),
  };
  orders.push(order);
  writeJSON(ORDERS_FILE, orders);
  res.status(201).json({ orderId: order.id, status });
});

app.get('/api/orders', requireAdmin, (req, res) => {
  res.json(readJSON(ORDERS_FILE, []));
});

app.put('/api/orders/:id', requireAdmin, (req, res) => {
  const orders = readJSON(ORDERS_FILE, []);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  orders[idx].status = req.body.status || orders[idx].status;
  writeJSON(ORDERS_FILE, orders);
  res.json(orders[idx]);
});

app.listen(PORT, () => {
  console.log(`filedrop-shop đang chạy tại http://localhost:${PORT}`);
});
