import {
  clampBulkTargetLimit,
  DEFAULT_BULK_TARGET_LIMIT,
  parseTargets,
  type Snowflake,
} from '../domain/parsers.js';
import type { Result } from '../domain/result.js';
export class TargetResolver {
  private readonly maxBulkTargets: number;
  public constructor(maxBulkTargets: number = DEFAULT_BULK_TARGET_LIMIT) {
    this.maxBulkTargets = clampBulkTargetLimit(maxBulkTargets);
  }
  public resolve(
    target: unknown,
    additional: unknown,
    max: number = this.maxBulkTargets,
  ): Result<Snowflake[]> {
    return parseTargets(target, additional, max);
  }
}
