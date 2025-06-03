// index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

app.get('/oauth/login', (req, res) => {
    const base = 'https://apisandbox.dev.clover.com/oauth/v2/authorize';
    const params = new URLSearchParams({
      client_id: process.env.CLOVER_APP_ID,
      response_type: 'code',
      redirect_uri: process.env.CLOVER_REDIRECT_URI
    });
    res.redirect(`${base}?${params.toString()}`);
  });

  
// Serve static files (for web UI)
app.use(express.static('public'));

// Port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
