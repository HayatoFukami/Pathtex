import type {
  CaseDto,
  CaseInput,
  CaseRepository,
  JsonValue,
} from '../repositories/contracts.js';
import {
  CaseInputSchema,
  CaseDtoSchema,
  SnowflakeSchema,
  JsonValueSchema,
} from '../repositories/contracts.js';
import { err, ok, type Result } from '../domain/result.js';
import { z } from 'zod';

export class CaseService {
  public constructor(private readonly repository: CaseRepository) {}
  public async create(input: CaseInput): Promise<Result<CaseDto>> {
    const parsed = CaseInputSchema.safeParse(input);
    if (!parsed.success) return err('INVALID_INPUT', 'Invalid case input');
    return ok(
      CaseDtoSchema.parse(await this.repository.createWithNumber(parsed.data)),
    );
  }
  public async get(
    guildId: string,
    id: string,
  ): Promise<Result<CaseDto | null>> {
    if (
      !SnowflakeSchema.safeParse(guildId).success ||
      !z.uuid().safeParse(id).success
    )
      return err('INVALID_INPUT', 'Invalid case identity');
    const value = await this.repository.get(id);
    if (value && value.guildId !== guildId)
      return err('INVALID_INPUT', 'Case does not belong to guild');
    return ok(value);
  }
  public async updateReason(
    guildId: string,
    id: string,
    reason: string,
  ): Promise<Result<CaseDto>> {
    const current = await this.get(guildId, id);
    if (!current.ok) return current;
    if (!current.value) return err('NOT_FOUND', 'Case not found');
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (trimmed.length === 0 || Array.from(trimmed).length > 1000)
      return err('INVALID_INPUT', 'Invalid reason');
    return ok(await this.repository.updateReason(id, trimmed));
  }
  public async updateStatus(
    guildId: string,
    id: string,
    status: CaseInput['status'],
    errorCode?: string,
  ): Promise<Result<CaseDto>> {
    const current = await this.get(guildId, id);
    if (!current.ok) return current;
    if (!current.value) return err('NOT_FOUND', 'Case not found');
    if (!['PENDING', 'COMPLETED', 'FAILED', 'PARTIAL'].includes(status))
      return err('INVALID_INPUT', 'Invalid case status');
    if (
      errorCode !== undefined &&
      (errorCode.length === 0 || errorCode.length > 64)
    )
      return err('INVALID_INPUT', 'Invalid case error code');
    return ok(await this.repository.updateStatus(id, status, errorCode));
  }
  public async updateMetadata(
    guildId: string,
    id: string,
    metadata: JsonValue,
  ): Promise<Result<CaseDto>> {
    const current = await this.get(guildId, id);
    if (!current.ok) return current;
    if (!current.value) return err('NOT_FOUND', 'Case not found');
    if (!JsonValueSchema.safeParse(metadata).success)
      return err('INVALID_INPUT', 'Invalid case metadata');
    const merged =
      current.value.metadata &&
      typeof current.value.metadata === 'object' &&
      !Array.isArray(current.value.metadata) &&
      typeof metadata === 'object' &&
      metadata !== null &&
      !Array.isArray(metadata)
        ? { ...current.value.metadata, ...metadata }
        : metadata;
    return ok(await this.repository.updateMetadata(id, merged));
  }
  public async forTarget(
    guildId: string,
    userId: string,
  ): Promise<Result<CaseDto[]>> {
    if (
      !SnowflakeSchema.safeParse(guildId).success ||
      !SnowflakeSchema.safeParse(userId).success
    )
      return err('INVALID_INPUT', 'Invalid target identity');
    return ok(await this.repository.listForTarget(guildId, userId));
  }
  public async byNumber(
    guildId: string,
    number: number,
  ): Promise<Result<CaseDto | null>> {
    if (
      !SnowflakeSchema.safeParse(guildId).success ||
      !Number.isInteger(number) ||
      number < 1
    )
      return err('INVALID_INPUT', 'Invalid case number');
    return ok(await this.repository.findByGuildAndNumber(guildId, number));
  }

  public async latest(guildId: string): Promise<Result<CaseDto | null>> {
    if (!SnowflakeSchema.safeParse(guildId).success)
      return err('INVALID_INPUT', 'Invalid guild identity');
    return ok(await this.repository.latest(guildId));
  }
}
