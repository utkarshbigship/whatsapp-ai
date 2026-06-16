const config = require('../config');

function ts() {
  return new Date().toLocaleString('en-IN', { timeZone: config.analysis.timezone });
}

const logger = {
  info:  (...args) => console.log(`[${ts()}] [INFO]`,  ...args),
  warn:  (...args) => console.warn(`[${ts()}] [WARN]`,  ...args),
  error: (...args) => console.error(`[${ts()}] [ERROR]`, ...args),
  debug: (...args) => {
    if (config.logLevel === 'debug') console.log(`[${ts()}] [DEBUG]`, ...args);
  },
};

module.exports = logger;
