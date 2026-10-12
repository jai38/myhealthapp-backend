import { createApp } from './app.js';
import { env } from './config/env.js';

const app = createApp();

app.listen(env.PORT, () => {
  // Safe logging: port and mode only, no tokens or PII
  console.log(`My Health App backend listening on port ${env.PORT} in ${env.NODE_ENV} mode`);
});
