import { parseDuration } from '../domain/parsers.js';
import type { Result } from '../domain/result.js';
export class DurationParser {
  public parse(value: unknown, maxSeconds?: number): Result<number> {
    return parseDuration(value, maxSeconds);
  }
}
