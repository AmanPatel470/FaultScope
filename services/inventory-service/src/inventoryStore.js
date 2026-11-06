'use strict';

const INITIAL_PRODUCTS = [
  { productId: 'p-100', name: 'Mechanical Keyboard', unitPriceCents: 4999, stock: 50 },
  { productId: 'p-200', name: 'Wireless Mouse', unitPriceCents: 1999, stock: 100 },
  { productId: 'p-300', name: '4K Monitor', unitPriceCents: 120000, stock: 5 },
];

function createInventoryStore({ stockMultiplier = 1 } = {}) {
  const products = new Map(
    INITIAL_PRODUCTS.map((p) => [p.productId, { ...p, stock: p.stock * stockMultiplier }])
  );
  const reservations = new Map(); // orderId -> reservation

  // Merge duplicate productIds so [{p-100 x1}, {p-100 x2}] becomes p-100 x3.
  function mergeItems(items) {
    const merged = new Map();
    for (const { productId, quantity } of items) {
      merged.set(productId, (merged.get(productId) || 0) + quantity);
    }
    return merged;
  }

  return {
    list: () => [...products.values()].map((p) => ({ ...p })),

    get: (productId) => (products.has(productId) ? { ...products.get(productId) } : null),

    reserve(orderId, items) {
      const existing = reservations.get(orderId);
      if (existing) {
        if (existing.status === 'RESERVED') {
          return { ok: true, replay: true, reservation: existing };
        }
        return {
          ok: false,
          status: 409,
          code: 'RESERVATION_RELEASED',
          message: `Reservation for ${orderId} was already released`,
        };
      }

      const wanted = mergeItems(items);

      // Validate everything first, then mutate. This makes the reservation all-or-nothing.
      for (const [productId] of wanted) {
        if (!products.has(productId)) {
          return { ok: false, status: 404, code: 'UNKNOWN_PRODUCT', message: `Unknown product ${productId}` };
        }
      }
      for (const [productId, quantity] of wanted) {
        const product = products.get(productId);
        if (product.stock < quantity) {
          return {
            ok: false,
            status: 409,
            code: 'INSUFFICIENT_STOCK',
            message: `Not enough stock for ${productId}`,
            details: { productId, requested: quantity, available: product.stock },
          };
        }
      }

      const lines = [];
      let totalCents = 0;
      for (const [productId, quantity] of wanted) {
        const product = products.get(productId);
        product.stock -= quantity;
        lines.push({ productId, name: product.name, quantity, unitPriceCents: product.unitPriceCents });
        totalCents += quantity * product.unitPriceCents;
      }

      const reservation = {
        orderId,
        status: 'RESERVED',
        items: lines,
        totalCents,
        reservedAt: new Date().toISOString(),
      };
      reservations.set(orderId, reservation);
      return { ok: true, replay: false, reservation };
    },

    release(orderId) {
      const reservation = reservations.get(orderId);
      if (!reservation) {
        return {
          ok: false,
          status: 404,
          code: 'RESERVATION_NOT_FOUND',
          message: `No reservation for ${orderId}`,
        };
      }
      if (reservation.status === 'RELEASED') {
        return { ok: true, replay: true, reservation };
      }
      for (const line of reservation.items) {
        products.get(line.productId).stock += line.quantity;
      }
      reservation.status = 'RELEASED';
      reservation.releasedAt = new Date().toISOString();
      return { ok: true, replay: false, reservation };
    },
  };
}

module.exports = { createInventoryStore };