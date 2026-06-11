export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export class ConsoleLogger implements Logger {
  constructor(private readonly prefix?: string) {}

  private format(message: string): string {
    return this.prefix ? `[${this.prefix}] ${message}` : message;
  }

  error(message: string, ...args: unknown[]): void {
    console.error(this.format(message), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(this.format(message), ...args);
  }

  info(message: string, ...args: unknown[]): void {
    console.log(this.format(message), ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    if (process.env.DEBUG) {
      console.debug(this.format(message), ...args);
    }
  }
}
