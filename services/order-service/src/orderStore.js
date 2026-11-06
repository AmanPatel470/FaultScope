'use strict';

const MAX_ORDERS = 1000;

function createOrderStore() {
  const orders = new Map();

  return {
    save(order) {
      orders.set(order.orderId, order);
      if (orders.size > MAX_ORDERS) {
        orders.delete(orders.keys().next().value);
      }
    },
    get: (orderId) => orders.get(orderId) || null,
  };
}

module.exports = { createOrderStore };