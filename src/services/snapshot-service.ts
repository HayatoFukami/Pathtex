import type {
  MemberSnapshotInput,
  MemberSnapshotDto,
  MessageSnapshotInput,
  SnapshotDto,
  SnapshotRepository,
} from '../repositories/contracts.js';
import {
  MemberSnapshotInputSchema,
  MessageSnapshotInputSchema,
  SnowflakeSchema,
} from '../repositories/contracts.js';
import { err, ok, type Result } from '../domain/result.js';
export class SnapshotService {
  public constructor(private readonly repository: SnapshotRepository) {}
  public async saveMessage(
    input: MessageSnapshotInput,
  ): Promise<Result<SnapshotDto>> {
    if (!MessageSnapshotInputSchema.safeParse(input).success)
      return err('INVALID_INPUT', 'Invalid message snapshot');
    return ok(await this.repository.upsertMessage(input));
  }
  public async saveMember(
    input: MemberSnapshotInput,
  ): Promise<Result<MemberSnapshotDto>> {
    if (!MemberSnapshotInputSchema.safeParse(input).success)
      return err('INVALID_INPUT', 'Invalid member snapshot');
    return ok(await this.repository.upsertMember(input));
  }
  public async getMessage(id: string): Promise<Result<SnapshotDto | null>> {
    if (!SnowflakeSchema.safeParse(id).success)
      return err('INVALID_INPUT', 'Invalid message ID');
    return ok(await this.repository.getMessage(id));
  }
  public async getMessages(ids: string[]): Promise<Result<SnapshotDto[]>> {
    if (
      !Array.isArray(ids) ||
      ids.some((id) => !SnowflakeSchema.safeParse(id).success)
    )
      return err('INVALID_INPUT', 'Invalid message IDs');
    return ok(await this.repository.getMessages(ids));
  }
  public async getMember(
    guildId: string,
    userId: string,
  ): Promise<Result<MemberSnapshotDto | null>> {
    if (
      !SnowflakeSchema.safeParse(guildId).success ||
      !SnowflakeSchema.safeParse(userId).success
    )
      return err('INVALID_INPUT', 'Invalid member identity');
    return ok(await this.repository.getMember(guildId, userId));
  }
  public async getMembersForUser(
    userId: string,
  ): Promise<Result<MemberSnapshotDto[]>> {
    if (!SnowflakeSchema.safeParse(userId).success)
      return err('INVALID_INPUT', 'Invalid user ID');
    return ok(await this.repository.listMembersForUser(userId));
  }
  public async deleteMessage(id: string): Promise<Result<void>> {
    if (!SnowflakeSchema.safeParse(id).success)
      return err('INVALID_INPUT', 'Invalid message ID');
    await this.repository.deleteMessage(id);
    return ok(undefined);
  }
  public async deleteMessages(ids: string[]): Promise<Result<number>> {
    if (
      !Array.isArray(ids) ||
      ids.some((id) => !SnowflakeSchema.safeParse(id).success)
    )
      return err('INVALID_INPUT', 'Invalid message IDs');
    return ok(await this.repository.deleteMessages(ids));
  }
  public async deleteMember(
    guildId: string,
    userId: string,
  ): Promise<Result<void>> {
    if (
      !SnowflakeSchema.safeParse(guildId).success ||
      !SnowflakeSchema.safeParse(userId).success
    )
      return err('INVALID_INPUT', 'Invalid member identity');
    await this.repository.deleteMember(guildId, userId);
    return ok(undefined);
  }
  public async deleteExpired(now?: Date): Promise<Result<number>> {
    if (
      now !== undefined &&
      !(now instanceof Date && !Number.isNaN(now.valueOf()))
    )
      return err('INVALID_INPUT', 'Invalid expiration time');
    return ok(await this.repository.deleteExpired(now));
  }
}
