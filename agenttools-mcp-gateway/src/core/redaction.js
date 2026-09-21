const SECRET_PATTERNS = [
  /(--?accessToken\s+)([^\s"]+)/gi,
  /(--?accessToken=)([^\s"]+)/gi,
  /(--?refreshToken\s+)([^\s"]+)/gi,
  /(--?refreshToken=)([^\s"]+)/gi,
  /(--?hubSessionId\s+)([^\s"]+)/gi,
  /(--?hubSessionId=)([^\s"]+)/gi,
  /(--?token\s+)([^\s"]+)/gi,
  /(--?token=)([^\s"]+)/gi,
  /(--?password\s+)([^\s"]+)/gi,
  /(--?password=)([^\s"]+)/gi,
  /(--?api[-_]?key\s+)([^\s"]+)/gi,
  /(--?api[-_]?key=)([^\s"]+)/gi,
  /((?:access|refresh|id|session)?token["']?\s*[:=]\s*["']?)([^\s,"'}]{4,})/gi,
  /((?:api|secret)[-_]?(?:key|token)["']?\s*[:=]\s*["']?)([^\s,"'}]{4,})/gi,
  /((?:password|passwd|pwd|cookie|sessionid|session_id|clientsecret|client_secret)["']?\s*[:=]\s*["']?)([^\s,"'}]{4,})/gi,
  /((?:Authorization|Bearer)\s+)([^\s"]+)/gi,
  /(DISCORD_TOKEN=)([^\s"]+)/gi,
];

const SECRET_KEY_PATTERN = /(token|password|passwd|pwd|secret|cookie|authorization|session.?id|api.?key)/i;

function redactSecrets(value) {
  if (value == null) return value;
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '$1[REDACTED]');
  }
  return text;
}

function truncateText(value, maxLength = 1200) {
  if (value == null) return value;
  const text = String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [TRUNCATED ${text.length - maxLength} chars]`;
}

function sanitizeLogText(value, maxLength = 1200) {
  return truncateText(redactSecrets(value), maxLength);
}

function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactSecrets(value) : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (SECRET_KEY_PATTERN.test(key)) return [key, '[REDACTED]'];
    return [key, redactObject(entry)];
  }));
}

module.exports = {
  redactSecrets,
  truncateText,
  sanitizeLogText,
  redactObject,
};
