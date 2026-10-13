// ==================================================================
// Pino logger + request serializer for pino-http.
// ==================================================================
import pino from 'pino';
import pinoHttp from 'pino-http';
import { env } from '../config/env.js';

const level = env.isProd ? 'info' : 'debug';
const PRETTY_OPTIONS = { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' };

// node:test sets NODE_TEST_CONTEXT in every test process - keeps `npm test` noise out of the file.
const logFile = env.LOG_FILE.trim() && !process.env.NODE_TEST_CONTEXT ? env.LOG_FILE.trim() : null;

// Terminal output is unchanged; LOG_FILE adds a second target with the same lines. Plain text in
// development (no colour codes, so it reads cleanly in an editor); JSON in production, where
// pino-pretty (a devDependency) may not be installed.
function buildTransport() {
  if (!logFile) {
    return env.isProd ? undefined : { target: 'pino-pretty', options: { colorize: true, ...PRETTY_OPTIONS } };
  }
  const terminal = env.isProd
    ? { target: 'pino/file', level, options: { destination: 1 } }
    : { target: 'pino-pretty', level, options: { colorize: true, ...PRETTY_OPTIONS } };
  const file = env.isProd
    ? { target: 'pino/file', level, options: { destination: logFile, mkdir: true } }
    : { target: 'pino-pretty', level, options: { destination: logFile, mkdir: true, colorize: false, ...PRETTY_OPTIONS } };
  return { targets: [terminal, file] };
}

export const logger = pino({
  level,
  base: { service: 'iprs-backend' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.otp'],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: buildTransport(),
});

export function requestLogger() {
  return pinoHttp({ logger });
}
