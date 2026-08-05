import { Router } from 'express';
import { logLogin } from '../models/audit.model.js';
import { authenticateLdap } from '../services/ldap.service.js';

export const authRouter = Router();

authRouter.get('/me', (req, res) => {
  res.json({ status: 'success', data: req.session.user || null });
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const user = await authenticateLdap(String(req.body.username || ''), String(req.body.password || ''));
    req.session.user = user;
    logLogin({ username: user.username, displayName: user.displayName, role: user.roles?.join(',') || '', success: true, ip: req.ip, userAgent: req.get('user-agent') }).catch(logErr => console.warn('Login log failed:', logErr));
    res.json({ status: 'success', data: user });
  } catch (err) {
    console.warn('Login failed:', err instanceof Error ? err.message : err);
    logLogin({ username: String(req.body.username || ''), success: false, failureReason: err instanceof Error ? err.message : String(err), ip: req.ip, userAgent: req.get('user-agent') }).catch(logErr => console.warn('Login log failed:', logErr));
    res.status(401).json({ status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
});

authRouter.post('/logout', (req, res) => {
  if (req.session.user) {
    logLogin({ username: req.session.user.username, displayName: req.session.user.displayName, role: req.session.user.roles?.join(',') || '', success: true, failureReason: 'logout', ip: req.ip, userAgent: req.get('user-agent') }).catch(logErr => console.warn('Logout log failed:', logErr));
  }
  req.session.destroy(() => {
    res.clearCookie(process.env.SESSION_COOKIE_NAME || 'cpaqueue.sid');
    res.json({ status: 'success' });
  });
});
