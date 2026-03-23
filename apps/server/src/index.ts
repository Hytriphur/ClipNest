import express from 'express';
import cors from 'cors';

import { getDefaultConfig } from './config.js';
import { ensureFsLayout, getFsLayout } from './fs-layout.js';
import { openDb, migrate } from './db.js';
import { createRouter } from './routes.js';
import { logger } from './logger.js';

const cfg = getDefaultConfig();
const layout = getFsLayout(cfg);
ensureFsLayout(layout);

const db = openDb(layout);
migrate(db);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: true,
    credentials: false,
  }),
);

app.use('/api', createRouter({ db, layout, cfg }));

app.listen(cfg.port, () => {
  logger.info(`listening on http://localhost:${cfg.port}`);
  logger.info(`data dir: ${layout.rootDir}`);
});
