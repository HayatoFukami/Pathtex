import { parseTargets, type Snowflake } from '../domain/parsers.js';
import type { Result } from '../domain/result.js';
export class TargetResolver {
  public resolve(
    target: unknown,
    additional: unknown,
    max = 20,
  ): Result<Snowflake[]> {
    return parseTargets(target, additional, max);
  }
}
