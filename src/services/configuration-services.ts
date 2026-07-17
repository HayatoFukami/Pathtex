import type {
  AutomodRepository,
  IgnoreRepository,
  PunishmentRepository,
} from '../repositories/contracts.js';

/** Public service façades used by configuration; repositories never cross the feature boundary. */
export class AutomodConfigurationService {
  public constructor(private readonly repository: AutomodRepository) {}
  public getOrCreate = (guildId: string) =>
    this.repository.getOrCreate(guildId);
  public update = (...args: Parameters<AutomodRepository['update']>) =>
    this.repository.update(...args);
}

export class PunishmentConfigurationService {
  public constructor(private readonly repository: PunishmentRepository) {}
  public list = (guildId: string) => this.repository.list(guildId);
  public set = (...args: Parameters<PunishmentRepository['replace']>) =>
    this.repository.replace(...args);
  public remove = (...args: Parameters<PunishmentRepository['remove']>) =>
    this.repository.remove(...args);
}

export class IgnoreConfigurationService {
  public constructor(private readonly repository: IgnoreRepository) {}
  public listRoles = (guildId: string) => this.repository.listRoles(guildId);
  public listChannels = (guildId: string) =>
    this.repository.listChannels(guildId);
  public clearChannel = (guildId: string, channelId: string) =>
    this.repository.clearChannel(guildId, channelId);
}
