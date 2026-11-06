'use strict';

const express = require('express');
const config = require('../config');

const router = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({
    service: config.serviceName,
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;