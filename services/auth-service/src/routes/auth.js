'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { authenticate } = require('../users');

const router = express.Router();

function errorBody(code, message) {
  return { error: { code, message } };
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  const valid =
    typeof username === 'string' && username.length > 0 && username.length <= 64 &&
    typeof password === 'string' && password.length > 0 && password.length <= 128;

  if (!valid) {
    return res
      .status(400)
      .json(errorBody('VALIDATION_ERROR', 'username and password are required non-empty strings'));
  }

  const user = authenticate(username, password);
  if (!user) {
    return res.status(401).json(errorBody('INVALID_CREDENTIALS', 'Invalid username or password'));
  }

  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: config.tokenTtlSeconds }
  );

  return res.status(200).json({
    token,
    tokenType: 'Bearer',
    expiresInSeconds: config.tokenTtlSeconds,
  });
});

router.get('/verify', (req, res) => {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res
      .status(401)
      .json(errorBody('MISSING_TOKEN', 'Authorization header must be "Bearer <token>"'));
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return res.status(200).json({
      valid: true,
      user: { id: payload.sub, username: payload.username, role: payload.role },
    });
  } catch (err) {
    return res.status(401).json(errorBody('INVALID_TOKEN', 'Token is invalid or expired'));
  }
});

module.exports = router;