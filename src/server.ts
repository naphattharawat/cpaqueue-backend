import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureQueueSchema } from './db.js';
import { queueRouter } from './routes/queue.routes.js';
import { ttsRouter } from './routes/tts.routes.js';
import { wsHub } from './wsHub.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsPath = path.resolve(__dirname, '../../uploads');
const assetsPath = path.resolve(__dirname, '../../assets');
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsPath));
app.use('/assets', express.static(assetsPath));
app.use('/api', queueRouter);
app.use('/tts', ttsRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ status: 'error', message: err.message });
});

const server = createServer(app);
wsHub.attach(server);

await ensureQueueSchema();
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Queue API listening on http://localhost:${port}`));
