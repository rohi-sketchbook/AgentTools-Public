const { checkPathAllowed } = require('../core/paths');

async function check(options = {}) {
  const targetPath = options.path || options.p;
  return checkPathAllowed(targetPath);
}

module.exports = {
  check,
};
