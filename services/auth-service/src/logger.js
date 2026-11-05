'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function currentThreshold() {
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[level] ?? LEVELS.info;
}

function write(level, message, fields) {
  if (LEVELS[level] < currentThreshold()) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    service: 'auth-service',
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};