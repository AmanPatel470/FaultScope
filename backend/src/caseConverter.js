'use strict';

function toCamelKey(key) {
  return key.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

// Recursively converts snake_case object keys to camelCase. Values (service names, paths) are untouched.
function toCamel(value) {
  if (Array.isArray(value)) return value.map(toCamel);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [toCamelKey(key), toCamel(inner)]));
  }
  return value;
}

module.exports = { toCamel, toCamelKey };