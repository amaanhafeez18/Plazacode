// server.js
require('dotenv').config();
const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------
// Load SSL certs
const sslOptions = {
  key: fs.readFileSync('/etc/ssl/plaza/private.key'),
  cert: fs.readFileSync('/etc/ssl/plaza/certificate.crt'),
  ca: fs.readFileSync('/etc/ssl/plaza/intermediate.crt')
};

// ---------------
// Utility: Read/Write tokens.json
function readTokens() {
  try {
    return JSON.parse(fs.readFileSync('tokens.json'));
  } catch (e) {
    return {};
  }
}
function writeTokens(obj) {
  fs.writeFileSync('tokens.json', JSON.stringify(obj, null, 2));
}

// ---------------
// OAuth Step 1: Redirect merchant to Clover’s OAuth page
app.get('/oauth/login', (req, res) => {
  const base = 'https://api.clover.com/oauth/v2/authorize';
  const params = new URLSearchParams({
    client_id: process.env.CLOVER_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.REDIRECT_URI
  });
  // For sandbox testing, use https://apisandbox.dev.clover.com/oauth/v2/authorize
  res.redirect(`${base}?${params.toString()}`);
});

// ---------------
// OAuth Step 2: Handle Clover’s Redirect with ?code=…
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  const error = req.query.error;
  const errorDesc = req.query.error_description;
  if (error) {
    console.error('OAuth Error:', error, errorDesc);
    return res.send(`<h2>OAuth Failed</h2><p>${error}: ${errorDesc}</p>`);
  }
  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    // Exchange authorization code for tokens
    const tokenResponse = await axios.post(
      'https://api.clover.com/oauth/v2/token',
      {
        client_id: process.env.CLOVER_CLIENT_ID,
        client_secret: process.env.CLOVER_CLIENT_SECRET,
        code: code
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const data = tokenResponse.data;
    // data: {access_token, refresh_token, expires_in, merchant_id, ...}

    // Persist to tokens.json
    const tokens = readTokens();
    tokens.access_token = data.access_token;
    tokens.refresh_token = data.refresh_token;
    tokens.merchant_id = data.merchant_id;
    writeTokens(tokens);
    console.log('✅ OAuth tokens saved:', tokens);

    res.send(`
      <h2>Authorization Successful!</h2>
      <p>You can close this window and return to the control panel.</p>
    `);
  } catch (err) {
    console.error('Token Exchange Error:', err.response?.data || err.message);
    res.status(500).send('Failed to exchange code for tokens.');
  }
});
// ─── Add this somewhere after your OAuth/callback handlers ───
app.get('/api/latest-order', async (req, res) => {
  // Read tokens from tokens.json
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync('tokens.json'));
  } catch {
    return res.status(500).json({ error: 'Unable to read tokens.json' });
  }

  const accessToken = tokens.access_token;
  const merchantId = tokens.merchant_id;
  if (!accessToken || !merchantId) {
    return res.status(400).json({ error: 'No access token or merchant ID found. Please authorize first.' });
  }

  try {
    // Fetch the single most-recent order (limit=1)
    const response = await axios.get(
      `https://api.clover.com/v3/merchants/${merchantId}/orders?limit=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const elements = response.data.elements || [];
    if (elements.length === 0) {
      return res.json({ message: 'No orders found.' });
    }
    // Return that one order’s JSON
    return res.json(elements[0]);
  } catch (e) {
    if (e.response && e.response.status === 401) {
      // If unauthorized, try refreshing the token once
      console.warn('401 Unauthorized: attempting to refresh token...');
      await refreshAccessToken();
      return res.status(401).json({ error: 'Access token expired. Refreshed. Please try again.' });
    }
    console.error('Error fetching latest order:', e.response?.data || e.message);
    return res.status(500).json({ error: 'Error fetching latest order.', details: e.response?.data || e.message });
  }
});
// ────────────────────────────────────────────────────────────────────────

// ---------------
// Token Refresh (called internally when needed)
async function refreshAccessToken() {
  const tokens = readTokens();
  if (!tokens.refresh_token) return;
  try {
    const resp = await axios.post(
      'https://api.clover.com/oauth/v2/token',
      {
        client_id: process.env.CLOVER_CLIENT_ID,
        client_secret: process.env.CLOVER_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const dt = resp.data;
    tokens.access_token = dt.access_token;
    tokens.refresh_token = dt.refresh_token;
    writeTokens(tokens);
    console.log('🔄 Access token refreshed');
  } catch (e) {
    console.error('❌ Failed to refresh token:', e.response?.data || e.message);
  }
}

// ---------------
// Polling Logic
let intervalId = null;
let seenOrderIds = new Set();

async function pollOrders() {
  const tokens = readTokens();
  const accessToken = tokens.access_token;
  const merchantId = tokens.merchant_id;
  if (!accessToken || !merchantId) return;

  try {
    // Fetch the latest N orders (limit from .env)
    const limit = parseInt(process.env.FETCH_LIMIT || '2', 10);
    const res = await axios.get(
      `https://api.clover.com/v3/merchants/${merchantId}/orders?limit=${limit}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const orders = res.data.elements || [];

    for (const order of orders) {
      // Check if this is an “Online” order
      if (
        order.orderType &&
        order.orderType.id === process.env.ONLINE_ORDER_TYPE_ID &&
        !seenOrderIds.has(order.id)
      ) {
        // New online order → print
        seenOrderIds.add(order.id);
        await printOrder(order.id);
      }
    }
  } catch (e) {
    // If 401, attempt to refresh token once
    if (e.response?.status === 401) {
      console.warn('401 Unauthorized → refreshing token...');
      await refreshAccessToken();
    } else {
      console.error('Error fetching orders:', e.response?.data || e.message);
    }
  }
}

// ---------------
// Print Order via Clover Print API
async function printOrder(orderId) {
  const tokens = readTokens();
  const accessToken = tokens.access_token;
  const merchantId = tokens.merchant_id;
  if (!accessToken || !merchantId) return;

  try {
    const payload = { orderRef: { id: orderId } };
    const resp = await axios.post(
      `https://api.clover.com/v3/merchants/${merchantId}/print_event`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`🖨️ Printed order ${orderId}:`, resp.data);
  } catch (e) {
    console.error('Error printing order:', e.response?.data || e.message);
  }
}

// ---------------
// API Endpoints to Start/Stop Polling
app.post('/api/start', (req, res) => {
  if (intervalId) return res.status(400).send('Already running.');
  const intervalMs = parseInt(process.env.POLL_INTERVAL || '20000', 10);
  // Clear in-memory seen IDs only when (re)starting, if you want fresh prints
  seenOrderIds = new Set();
  intervalId = setInterval(pollOrders, intervalMs);
  console.log('▶️ Polling service started.');
  res.send('Polling started.');
});

app.post('/api/stop', (req, res) => {
  if (!intervalId) return res.status(400).send('Not running.');
  clearInterval(intervalId);
  intervalId = null;
  console.log('⏹️ Polling service stopped.');
  res.send('Polling stopped.');
});

// ---------------
// Serve over HTTPS
https.createServer(sslOptions, app).listen(443, () => {
  console.log('🔐 HTTPS Server running on https://plazasushiwestern.xyz');
});
