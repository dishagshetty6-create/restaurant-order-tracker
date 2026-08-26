// Minimal structured logger. Keeps stdout parseable without pulling in a dependency.
function emit(level, message, meta = {}) {
  const line = { level, message, ts: new Date().toISOString(), ...meta };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
};
