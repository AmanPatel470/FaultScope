'use strict';

const express = require('express');
const logger = require('../logger');

const MESSAGES = {
  ORDER_CONFIRMED: (orderId) => `Your order ${orderId} has been confirmed.`,
  ORDER_FAILED: (orderId) => `Your order ${orderId} could not be completed.`,
};

function errorBody(code, message) {
  return { error: { code, message } };
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function createNotificationsRouter({ store }) {
  const router = express.Router();

  router.post('/', (req, res) => {
    const { orderId, userId, type } = req.body || {};

    if (!isId(orderId) || !isId(userId) || typeof type !== 'string' || !Object.hasOwn(MESSAGES, type)) {
      return res.status(400).json(
        errorBody('VALIDATION_ERROR', 'orderId, userId and type (ORDER_CONFIRMED or ORDER_FAILED) are required')
      );
    }

    const existing = store.findByKey(orderId, type);
    if (existing) {
      return res.status(200).json({ ...existing, idempotentReplay: true });
    }

    const notification = store.create({ orderId, userId, type, message: MESSAGES[type](orderId) });
    logger.info('notification_sent', {
      requestId: req.requestId,
      notificationId: notification.notificationId,
      orderId,
      userId,
      type,
    });
    return res.status(201).json(notification);
  });

  router.get('/', (req, res) => {
    const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : undefined;
    res.status(200).json({ notifications: store.list(orderId) });
  });

  router.get('/:notificationId', (req, res) => {
    const notification = store.findById(req.params.notificationId);
    if (!notification) {
      return res.status(404).json(errorBody('NOTIFICATION_NOT_FOUND', 'Notification not found'));
    }
    return res.status(200).json(notification);
  });

  return router;
}

module.exports = { createNotificationsRouter };