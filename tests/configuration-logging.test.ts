import { describe, expect, it } from 'vitest';
import { formatGuildTime } from '../src/features/configuration/service.js';
import {
  classifyVoice,
  messageEditEmbed,
} from '../src/features/logging/index.js';

describe('configuration and logging slice', () => {
  it('renders configured timezone while preserving the instant', () => {
    expect(
      formatGuildTime(new Date('2026-01-01T00:00:00.000Z'), 'Asia/Tokyo'),
    ).toContain('2026-01-01 09:00:00');
  });
  it('classifies only channel transitions as voice events', () => {
    expect(classifyVoice(null, '1')).toBe('Join');
    expect(classifyVoice('1', null)).toBe('Leave');
    expect(classifyVoice('1', '2')).toBe('Move');
    expect(classifyVoice('1', '1')).toBeNull();
  });
  it('does not log embed-only equivalent updates', () => {
    const base = {
      guildId: '12345678901234567',
      channelId: '12345678901234568',
      messageId: '12345678901234569',
      author: 'a',
      authorId: '12345678901234570',
      content: 'same',
      createdAt: new Date(),
    };
    expect(messageEditEmbed(base, { ...base }, 'UTC')).toBeNull();
  });
});
