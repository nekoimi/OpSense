export interface LogOptions {
  quiet?: boolean;
  verbose?: boolean;
}

export interface Logger {
  debug(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

export type LoggerFactory = (options: LogOptions) => Logger;

export const createLogger: LoggerFactory = ({ quiet = false, verbose = false }) => ({
  debug(message) {
    if (verbose && !quiet) {
      process.stderr.write(`[debug] ${message}\n`);
    }
  },
  error(message) {
    process.stderr.write(`${message}\n`);
  },
  info(message) {
    if (!quiet) {
      process.stdout.write(`${message}\n`);
    }
  },
});
