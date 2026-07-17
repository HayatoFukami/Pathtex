import { describe, expect, it, vi } from 'vitest';
import {
  createLifecycle,
  type LifecycleDependencies,
  type LifecycleStep,
} from '../src/lifecycle.js';
import { createLogger } from '../src/logging/logger.js';

const context = {
  event: 'test',
  correlationId: 'c',
  interactionId: null,
  guildId: null,
  channelId: null,
  userId: null,
  caseId: null,
  durationMs: null,
  errorName: null,
  discordCode: null,
} as const;
function dependencies(calls: string[]): LifecycleDependencies {
  const step = (name: string): LifecycleStep => ({
    name,
    start: () => {
      calls.push(`start:${name}`);
      return Promise.resolve();
    },
    stop: () => {
      calls.push(`stop:${name}`);
      return Promise.resolve();
    },
  });
  return {
    database: step('database'),
    migrations: step('migrations'),
    resources: step('resources'),
    recoverStaleJobs: step('recovery'),
    scheduler: step('scheduler'),
    voice: step('voice'),
    prisma: step('prisma'),
    intake: {
      start: () => {
        calls.push('start:intake');
        return Promise.resolve();
      },
      stopAccepting: () => {
        calls.push('stopAccepting');
        return Promise.resolve();
      },
      drain: () => {
        calls.push('drain');
        return Promise.resolve();
      },
    },
    createDiscordClient: () =>
      Promise.resolve({
        login: () => {
          calls.push('login');
          return Promise.resolve();
        },
        destroy: () => {
          calls.push('destroy');
          return Promise.resolve();
        },
      }),
  };
}
const make = (calls: string[], deps = dependencies(calls)) =>
  createLifecycle(createLogger({ LOG_LEVEL: 'silent' }, context), deps);

describe('bootstrap lifecycle coordinator', () => {
  it('creates/login client, recovers before ready, then starts scheduler/intake and cleans up in order', async () => {
    const calls: string[] = [];
    const lifecycle = make(calls);
    await lifecycle.start();
    const firstStop = lifecycle.stop();
    expect(lifecycle.stop()).toBe(firstStop);
    await firstStop;
    expect(calls).toEqual([
      'start:database',
      'start:migrations',
      'start:resources',
      'login',
      'start:recovery',
      'start:scheduler',
      'start:intake',
      'stopAccepting',
      'drain',
      'stop:scheduler',
      'stop:voice',
      'destroy',
      'stop:resources',
      'stop:migrations',
      'stop:database',
      'stop:prisma',
    ]);
  });

  it('continues cleanup after the bounded drain timeout', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const deps = dependencies(calls);
      deps.intake.drain = () => {
        calls.push('drain');
        return new Promise<void>(() => undefined);
      };
      const lifecycle = make(calls, deps);
      await lifecycle.start();
      const stopping = lifecycle.stop();
      await vi.advanceTimersByTimeAsync(15_000);
      await stopping;
      expect(calls.slice(-9)).toEqual([
        'stopAccepting',
        'drain',
        'stop:scheduler',
        'stop:voice',
        'destroy',
        'stop:resources',
        'stop:migrations',
        'stop:database',
        'stop:prisma',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start scheduler until recovery and the deferred Ready/login promise resolve', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    let ready!: () => void;
    deps.createDiscordClient = () =>
      Promise.resolve({
        login: () =>
          new Promise<void>((resolve) => {
            ready = resolve;
          }),
        destroy: () => Promise.resolve(),
      });
    const lifecycle = make(calls, deps);
    const starting = lifecycle.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toContain('start:recovery');
    expect(calls).not.toContain('start:scheduler');
    ready();
    await starting;
    expect(calls).toContain('start:scheduler');
  });

  it('awaits pending startup before cleanup and prevents later startup steps', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.createDiscordClient = () =>
      Promise.resolve({
        login: (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          }),
        destroy: () => {
          calls.push('destroy');
          return Promise.resolve();
        },
      });
    const lifecycle = make(calls, deps);
    const starting = lifecycle.start();
    void starting.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = lifecycle.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toContain('stopAccepting');
    await expect(starting).rejects.toThrow('bootstrap startup aborted');
    await stopping;
    expect(calls).not.toContain('start:scheduler');
    expect(calls).not.toContain('start:intake');
    expect(calls).toContain('destroy');
  });

  it('observes a rejected login when stale-job recovery fails', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.createDiscordClient = () =>
      Promise.resolve({
        login: (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          }),
        destroy: () => {
          calls.push('destroy');
          return Promise.resolve();
        },
      });
    deps.recoverStaleJobs.start = () =>
      Promise.reject(new Error('recovery failed'));
    await expect(make(calls, deps).start()).rejects.toThrow('recovery failed');
    expect(calls).toContain('destroy');
    expect(calls.at(-1)).toBe('stop:prisma');
  });

  it('stops safely with a permanently pending login that settles only on abort', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.createDiscordClient = () =>
      Promise.resolve({
        login: (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          }),
        destroy: () => {
          calls.push('destroy');
          return Promise.resolve();
        },
      });
    const lifecycle = make(calls, deps);
    const starting = lifecycle.start();
    void starting.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await lifecycle.stop();
    await expect(starting).rejects.toThrow('bootstrap startup aborted');
    expect(calls).toContain('destroy');
    expect(calls.at(-1)).toBe('stop:prisma');
  });
});
