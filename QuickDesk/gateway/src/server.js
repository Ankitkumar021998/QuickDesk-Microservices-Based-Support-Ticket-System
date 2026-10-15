const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = parseInt(process.env.PORT || '8080', 10);
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4001';
const TICKET_SERVICE_URL = process.env.TICKET_SERVICE_URL || 'http://localhost:4002';

const app = express();
app.use(morgan('combined'));
app.use(cors());
app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (req, res) => res.json({ service: 'gateway', status: 'ok' }));

// NOTE: no express.json() here. The gateway streams the raw request body to the service.
function proxyTo(prefix, target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathFilter: (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    on: {
      error: (err, req, res) => {
        console.error(`Proxy error for ${prefix}:`, err.message);
        if (typeof res.writeHead === 'function' && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream service unavailable' }));
        }
      },
    },
  });
}

// Only these two prefixes are exposed. Anything else (e.g. /internal/*) never reaches a service.
app.use(proxyTo('/auth', AUTH_SERVICE_URL));
app.use(proxyTo('/tickets', TICKET_SERVICE_URL));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(PORT, () => console.log(`gateway listening on :${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
