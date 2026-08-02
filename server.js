require('dotenv').config();
const express = require('express');
const path = require('path');
const monitor = require('./monitor');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Serve Static Frontend ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Endpoints ───────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    streams: monitor.getStatus(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/history', (req, res) => {
  res.json({
    history: monitor.getHistory(),
    incidents: monitor.getIncidents(),
  });
});

app.get('/api/config', (req, res) => {
  res.json(monitor.getConfig());
});

// ── Test Email Alert ────────────────────────────────────────────────────────
app.get('/api/test-alert', async (req, res) => {
  const to = (req.query.to || '').trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!to || !emailRegex.test(to)) {
    return res.status(400).json({ error: 'Provide a valid email address via ?to=user@example.com' });
  }
  try {
    await monitor.sendTestAlert(to);
    res.json({ success: true, message: `Test alert sent to ${to}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health Check (for Docker / Coolify) ─────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Dashboard running at http://0.0.0.0:${PORT}`);
  monitor.start();
});
