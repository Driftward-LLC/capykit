(()=>{
// Activepieces0.92.1 pieces-common disables TLS verification globally. Enforce
// verified TLS at Node's transport boundary in both the API and engine child.
// This guard is for trusted upstream connector code, not a malicious-code sandbox.
const tls = require('node:tls');
const connect = tls.connect;
tls.connect = function (...args) {
  const index = args.findIndex(value => value !== null && typeof value === 'object');
  if (index >= 0) args[index] = { ...args[index], rejectUnauthorized: true };
  else args.splice(typeof args[1] === 'string' ? 2 : 1, 0, { rejectUnauthorized: true });
  return connect.apply(this, args);
};

})();
