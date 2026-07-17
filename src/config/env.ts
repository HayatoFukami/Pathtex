import os from 'node:os';
import process from 'node:process';
import { z } from 'zod';

const snowflake = z
  .string()
  .regex(/^\d{17,20}$/, 'must be a Discord Snowflake');
const nonBlank = z.string().trim().min(1);
const optionalText = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);
const optionalInteger = (min: number, max: number) =>
  optionalText.pipe(
    z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(min).max(max))
      .optional(),
  );

const environmentSchema = z
  .object({
    DISCORD_TOKEN: z
      .string()
      .min(1)
      .refine(
        (value) => value === value.trim(),
        'must not have surrounding whitespace',
      ),
    DISCORD_CLIENT_ID: snowflake,
    DATABASE_URL: z
      .url()
      .refine(
        (value) =>
          value.startsWith('postgresql://') || value.startsWith('postgres://'),
        'must be a PostgreSQL URL',
      ),
    COMMAND_SCOPE: z.enum(['global', 'guild']),
    DEV_GUILD_ID: z.preprocess(
      (value) =>
        typeof value === 'string' && value.trim() === '' ? undefined : value,
      snowflake.optional(),
    ),
    BOT_VERSION: z
      .string()
      .trim()
      .regex(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
        'must be SemVer',
      ),
    INVITE_PERMISSIONS: optionalText.pipe(z.string().regex(/^\d+$/).optional()),
    LOG_LEVEL: optionalText
      .pipe(
        z
          .string()
          .toLowerCase()
          .pipe(
            z.enum([
              'fatal',
              'error',
              'warn',
              'info',
              'debug',
              'trace',
              'silent',
            ]),
          )
          .optional(),
      )
      .default('info'),
    SENTRY_DSN: optionalText.pipe(z.url().optional()),
    MESSAGE_RETENTION_DAYS: optionalInteger(1, 30).default(7),
    MAX_BULK_TARGETS: optionalInteger(1, 20).default(20),
    OWNER_USER_IDS: optionalText.transform((value) =>
      value?.split(',').map((id) => id.trim()),
    ),
    INSTANCE_ID: z
      .preprocess(
        (value) =>
          typeof value === 'string' && value.trim() === '' ? undefined : value,
        nonBlank.max(64).optional(),
      )
      .default(`${os.hostname()}-${String(process.pid)}`),
  })
  .superRefine((value, context) => {
    if (value.COMMAND_SCOPE === 'guild' && value.DEV_GUILD_ID === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['DEV_GUILD_ID'],
        message: 'is required when COMMAND_SCOPE is guild',
      });
    }
    if (
      value.OWNER_USER_IDS !== undefined &&
      (value.OWNER_USER_IDS.length === 0 ||
        value.OWNER_USER_IDS.some((id) => !snowflake.safeParse(id).success))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['OWNER_USER_IDS'],
        message: 'must be comma-separated Discord Snowflakes',
      });
    }
  });

export type AppConfig = z.infer<typeof environmentSchema>;

export class ConfigValidationError extends Error {
  public constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'ConfigValidationError';
  }
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
