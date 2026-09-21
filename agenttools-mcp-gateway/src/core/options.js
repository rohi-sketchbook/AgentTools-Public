function assignOption(options, key, value) {
  if (!(key in options)) {
    options[key] = value;
    return;
  }
  if (Array.isArray(options[key])) {
    options[key].push(value);
    return;
  }
  options[key] = [options[key], value];
}

function parseOptions(args) {
  const positional = [];
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--') || arg === '--') {
      positional.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    if (!withoutPrefix) {
      positional.push(arg);
      continue;
    }

    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      const key = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      assignOption(options, key, value);
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      assignOption(options, withoutPrefix, true);
      continue;
    }

    assignOption(options, withoutPrefix, next);
    i += 1;
  }

  return { positional, options };
}

module.exports = {
  parseOptions,
};
