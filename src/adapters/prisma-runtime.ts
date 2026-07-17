import { PrismaClient } from '@prisma/client';
import type { DatabaseHealthPort } from '../commands/ping.js';

export class PrismaRuntimeAdapter implements DatabaseHealthPort {
  public constructor(public readonly prisma: PrismaClient) {}
  public async connect(): Promise<void> {
    await this.prisma.$connect();
  }
  public async health(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
  public async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
