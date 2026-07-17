import type { Client } from 'discord.js';
import type { DiscordClientPort } from '../runtime/ports.js';

export class DiscordClientAdapter implements DiscordClientPort {
  public constructor(
    public readonly client: Client,
    private readonly fatal: (error: Error) => void = () => undefined,
  ) {}

  public async login(token: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Discord login aborted');
    const login = this.client.login(token);
    if (signal === undefined) {
      await login;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        void this.destroy();
        reject(new Error('Discord login aborted'));
      };
      signal.addEventListener('abort', abort, { once: true });
      login.then(
        () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(
            error instanceof Error ? error : new Error('Discord login failed'),
          );
        },
      );
    });
  }

  public async destroy(): Promise<void> {
    await Promise.resolve(this.client.destroy());
  }

  public reportFatal(error: Error): void {
    this.fatal(error);
  }
}
