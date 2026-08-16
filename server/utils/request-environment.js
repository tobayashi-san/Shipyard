const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithEnvironment(environmentId, callback) {
  return storage.run({ environmentId }, callback);
}

function currentEnvironment() {
  return storage.getStore()?.environmentId || null;
}

module.exports = { runWithEnvironment, currentEnvironment };
