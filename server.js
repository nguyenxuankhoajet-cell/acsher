require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'doi-chuoi-bi-mat-nay';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

// ---------- Kết nối database Supabase (Postgres) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
async function q(text, params) {
  return pool.query(text, params);
}

// ---------- Gửi email OTP qua Brevo (HTTP API - không bị chặn như SMTP) ----------
async function sendOtpEmail(toEmail, code) {
  if (!process.env.BREVO_API_KEY || !process.env.GMAIL_USER) {
    console.warn('Chưa cấu hình BREVO_API_KEY/GMAIL_USER trong .env — không gửi được email thật. Mã OTP (chỉ hiện ở log server):', code);
    return;
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'filedrop', email: process.env.GMAIL_USER },
      to: [{ email: toEmail }],
      subject: 'Mã xác thực đăng ký filedrop',
      htmlContent: `<p>Mã xác thực của bạn là:</p><h2 style="letter-spacing:4px;">${code}</h2><p>Mã có hiệu lực trong 10 phút. Nếu không phải bạn yêu cầu, hãy bỏ qua email này.</p>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API lỗi (${res.status}): ${text}`);
  }
}

const pendingRegistrations = new Map();
function genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Sai mật khẩu' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

function rowToProduct(r) {
  return { id: r.id, ext: r.ext, name: r.name, desc: r.description, size: r.size, price: r.price, fileUrl: r.file_url };
}

app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await q('select id, ext, name, description, size, price from products order by id');
    res.json(rows.map(r => ({ id: r.id, ext: r.ext, name: r.name, desc: r.description, size: r.size, price: r.price })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const { rows } = await q('select * from products order by id');
    res.json(rows.map(rowToProduct));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.post('/api/products', requireAdmin, async (req, res) => {
  const { ext, name, desc, size, price, fileUrl } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Thiếu tên file' });
  try {
    const { rows } = await q(
      `insert into products (ext, name, description, size, price, file_url) values ($1,$2,$3,$4,$5,$6) returning *`,
      [ext || '.zip', name, desc || '', size || '—', Number(price) || 0, fileUrl || '']
    );
    res.status(201).json(rowToProduct(rows[0]));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const fields = { ext: 'ext', name: 'name', desc: 'description', size: 'size', price: 'price', fileUrl: 'file_url' };
  const sets = []; const vals = []; let i = 1;
  for (const [bodyKey, col] of Object.entries(fields)) {
    if (req.body[bodyKey] !== undefined) { sets.push(`${col} = $${i++}`); vals.push(req.body[bodyKey]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  vals.push(id);
  try {
    const { rows } = await q(`update products set ${sets.join(', ')} where id = $${i} returning *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    res.json(rowToProduct(rows[0]));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    await q('delete from products where id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await q('select * from settings where id = 1');
    const s = rows[0] || {};
    res.json({
      siteName: s.site_name, heroTitle: s.hero_title, heroSubtitle: s.hero_subtitle,
      footerText: s.footer_text, colors: s.colors,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});
app.put('/api/settings', requireAdmin, async (req, res) => {
  try {
    const current = await q('select * from settings where id = 1');
    const cur = current.rows[0] || {};
    const colors = { ...(cur.colors || {}), ...(req.body.colors || {}) };
    const { rows } = await q(
      `insert into settings (id, site_name, hero_title, hero_subtitle, footer_text, colors)
       values (1, $1,$2,$3,$4,$5)
       on conflict (id) do update set site_name=$1, hero_title=$2, hero_subtitle=$3, footer_text=$4, colors=$5
       returning *`,
      [
        req.body.siteName ?? cur.site_name,
        req.body.heroTitle ?? cur.hero_title,
        req.body.heroSubtitle ?? cur.hero_subtitle,
        req.body.footerText ?? cur.footer_text,
        colors,
      ]
    );
    const s = rows[0];
    res.json({ siteName: s.site_name, heroTitle: s.hero_title, heroSubtitle: s.hero_subtitle, footerText: s.footer_text, colors: s.colors });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await q('select id, name, username, email, balance from users order by id');
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});
app.put('/api/users/:id/balance', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const delta = Number(req.body.delta) || 0;
  try {
    const { rows } = await q('update users set balance = balance + $1 where id = $2 returning id, name, balance', [delta, id]);
    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

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

app.post('/api/register/request-otp', async (req, res) => {
  const { name, username, email, phone, password } = req.body || {};
  if (!name || !username || !email || !password) {
    return res.status(400).json({ error: 'Vui lòng điền đủ thông tin bắt buộc' });
  }
  try {
    const dup = await q('select id from users where username = $1 or email = $2', [username, email]);
    if (dup.rows.length) return res.status(400).json({ error: 'Tên đăng nhập hoặc email đã được dùng' });

    const code = genOtp();
    const passwordHash = await bcrypt.hash(password, 10);
    pendingRegistrations.set(email, {
      code,
      expiresAt: Date.now() + 10 * 60 * 1000,
      data: { name, username, email, phone: phone || '', passwordHash },
    });
    try {
      await sendOtpEmail(email, code);
    } catch (e) {
      console.error('Lỗi gửi email OTP:', e.message);
      return res.status(500).json({ error: 'Không gửi được email OTP. Kiểm tra lại cấu hình GMAIL trong .env.' });
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.post('/api/register/verify-otp', async (req, res) => {
  const { email, code } = req.body || {};
  const pending = pendingRegistrations.get(email);
  if (!pending) return res.status(400).json({ error: 'Không tìm thấy yêu cầu đăng ký. Vui lòng đăng ký lại.' });
  if (Date.now() > pending.expiresAt) {
    pendingRegistrations.delete(email);
    return res.status(400).json({ error: 'Mã OTP đã hết hạn. Vui lòng đăng ký lại.' });
  }
  if (pending.code !== code) return res.status(400).json({ error: 'Mã OTP không đúng' });

  try {
    const { name, username, phone, passwordHash } = pending.data;
    const { rows } = await q(
      `insert into users (name, username, email, phone, password_hash) values ($1,$2,$3,$4,$5) returning id, name, email`,
      [name, username, email, phone, passwordHash]
    );
    pendingRegistrations.delete(email);
    const user = rows[0];
    const token = jwt.sign({ role: 'user', userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const { rows } = await q('select * from users where username = $1 or email = $1', [username]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    const token = jwt.sign({ role: 'user', userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.get('/api/me', requireUser, async (req, res) => {
  try {
    const { rows } = await q('select id, name, username, email, phone, balance from users where id = $1', [req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.put('/api/me/password', requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Thiếu mật khẩu hiện tại hoặc mật khẩu mới' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Mật khẩu mới cần ít nhất 6 ký tự' });
  try {
    const { rows } = await q('select password_hash from users where id = $1', [req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await q('update users set password_hash = $1 where id = $2', [newHash, req.userId]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.get('/api/my-orders', requireUser, async (req, res) => {
  try {
    const { rows } = await q('select * from orders where user_id = $1 order by created_at', [req.userId]);
    const prodRes = await q('select id, name, file_url from products');
    const products = prodRes.rows;
    const withLinks = rows.map(o => ({
      id: o.id, total: o.total, status: o.status, createdAt: o.created_at, paymentMethod: o.payment_method,
      items: o.item_ids.map(id => {
        const p = products.find(p => p.id === id);
        return { id, name: p ? p.name : '(sản phẩm đã bị xoá)', fileUrl: (o.status === 'completed' && p) ? p.file_url || '' : '' };
      }),
    }));
    res.json(withLinks);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.post('/api/orders', attachUserIfAny, async (req, res) => {
  const { email, itemIds, paymentMethod, paymentDetail, total } = req.body || {};
  if (!email || !Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: 'Thiếu email hoặc danh sách sản phẩm' });
  }
  try {
    let status = 'pending';
    if (paymentMethod === 'balance') {
      if (!req.userId) return res.status(401).json({ error: 'Cần đăng nhập để dùng số dư ví' });
      const { rows } = await q('select balance from users where id = $1', [req.userId]);
      if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
      if (rows[0].balance < Number(total)) return res.status(400).json({ error: 'Số dư ví không đủ' });
      await q('update users set balance = balance - $1 where id = $2', [Number(total), req.userId]);
      status = 'completed';
    }
    const id = crypto.randomUUID();
    await q(
      `insert into orders (id, user_id, email, item_ids, payment_method, payment_detail, total, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.userId || null, email, itemIds, paymentMethod || 'unknown', paymentDetail || {}, Number(total) || 0, status]
    );
    res.status(201).json({ orderId: id, status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const { rows } = await q('select * from orders order by created_at desc');
    res.json(rows.map(o => ({
      id: o.id, userId: o.user_id, email: o.email, itemIds: o.item_ids, paymentMethod: o.payment_method,
      paymentDetail: o.payment_detail, total: o.total, status: o.status, createdAt: o.created_at,
    })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.put('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await q('update orders set status = $1 where id = $2 returning *', [req.body.status, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Lỗi cơ sở dữ liệu' }); }
});

app.listen(PORT, () => {
  console.log(`filedrop-shop đang chạy tại http://localhost:${PORT}`);
});
