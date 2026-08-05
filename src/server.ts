import cors from 'cors';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { authRouter } from './routes/auth.routes.js';
import { queueRouter } from './routes/queue.routes.js';
import { KnexSessionStore } from './session-store.js';
import { ttsRouter } from './routes/tts.routes.js';
import { wsHub } from './wsHub.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsPath = path.resolve(__dirname, '../../uploads');
const assetsPath = path.resolve(__dirname, '../../assets');
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true }));
app.use(cookieParser());
app.use(session({
  store: new KnexSessionStore(),
  name: process.env.SESSION_COOKIE_NAME || 'cpaqueue.sid',
  secret: process.env.SESSION_SECRET || 'change-this-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.SESSION_SECURE === 'true',
    maxAge: Number(process.env.SESSION_MAX_AGE_MS || 12 * 60 * 60 * 1000),
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsPath));
app.use('/assets', express.static(assetsPath));
app.use('/auth', authRouter);
app.use('/api', queueRouter);
app.use('/tts', ttsRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status((err as any).status || 500).json({ status: 'error', message: err.message });
});

const server = createServer(app);
wsHub.attach(server);

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Queue API listening on http://localhost:${port}`));
