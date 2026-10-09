import * as path from 'path';
import * as winston from 'winston';
import { env, paths } from '../config/config';

const fmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level.toUpperCase()} ${message}`),
);

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: fmt,
  transports: [
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), fmt) }),
    new winston.transports.File({ filename: path.join(paths.logs, 'app.log') }),
  ],
});
