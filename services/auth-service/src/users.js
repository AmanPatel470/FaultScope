'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

// Demo data only. A real service would store salted password hashes in a database.
const USERS = [
  { id: 'u-1001', username: 'alice', password: 'alice-pass', role: 'customer' },
  { id: 'u-1002', username: 'bob', password: 'bob-pass', role: 'admin' },
];

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function authenticate(username, password) {
  const user = USERS.find((u) => u.username === username);
  // Compare against a dummy value when the user doesn't exist, so timing is similar.
  const expected = digest(user ? user.password : 'no-such-user');
  const actual = digest(password);
  const passwordMatches = timingSafeEqual(expected, actual);

  if (!user || !passwordMatches) return null;
  return { id: user.id, username: user.username, role: user.role };
}

module.exports = { authenticate };