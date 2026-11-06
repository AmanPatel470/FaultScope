'use strict';

const { randomUUID } = require('node:crypto');

const MAX_NOTIFICATIONS = 5000;

function createNotificationStore() {
  const byId = new Map();
  const byKey = new Map(); // "orderId:type" -> notification

  return {
    findById: (id) => byId.get(id) || null,
    findByKey: (orderId, type) => byKey.get(`${orderId}:${type}`) || null,

    create({ orderId, userId, type, message }) {
      const notification = {
        notificationId: `ntf-${randomUUID().slice(0, 8)}`,
        orderId,
        userId,
        type,
        message,
        channel: 'simulated-email',
        status: 'SENT',
        sentAt: new Date().toISOString(),
      };
      byId.set(notification.notificationId, notification);
      byKey.set(`${orderId}:${type}`, notification);

      if (byId.size > MAX_NOTIFICATIONS) {
        const oldestId = byId.keys().next().value;
        const oldest = byId.get(oldestId);
        byKey.delete(`${oldest.orderId}:${oldest.type}`);
        byId.delete(oldestId);
      }
      return notification;
    },

    list(orderId) {
      const all = [...byId.values()];
      const filtered = orderId ? all.filter((n) => n.orderId === orderId) : all;
      return filtered.slice(-100);
    },
  };
}

module.exports = { createNotificationStore };