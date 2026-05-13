const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const isTest = process.env.NODE_ENV === 'test';

function userOrIpKey(req) {
  return req.user?.id ? `u:${req.user.id}` : ipKeyGenerator(req.ip);
}

function ipKey(req) {
  return ipKeyGenerator(req.ip);
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  skip: () => isTest,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: 'Too many API requests. Please slow down.' },
});

const authenticatedApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  skip: () => isTest,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many authenticated API requests. Please slow down.' },
});

const authSensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  skip: () => isTest,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many account security requests. Please slow down.' },
});

const fileReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  skip: () => isTest,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many file read requests. Please slow down.' },
});

const pluginApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  skip: () => isTest,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many plugin API requests. Please slow down.' },
});

const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100000,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: ipKey,
});

module.exports = {
  apiLimiter,
  authenticatedApiLimiter,
  authSensitiveLimiter,
  fileReadLimiter,
  pluginApiLimiter,
  testLimiter,
};
