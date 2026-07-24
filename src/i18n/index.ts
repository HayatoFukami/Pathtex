import i18next from 'i18next';
import commands from './locales/ja/commands.json' with { type: 'json' };
import general from './locales/ja/general.json' with { type: 'json' };
import moderation from './locales/ja/moderation.json' with { type: 'json' };
import automod from './locales/ja/automod.json' with { type: 'json' };
import raid from './locales/ja/raid.json' with { type: 'json' };
import strikes from './locales/ja/strikes.json' with { type: 'json' };
import tools from './locales/ja/tools.json' with { type: 'json' };
import voice from './locales/ja/voice.json' with { type: 'json' };
import configuration from './locales/ja/configuration.json' with { type: 'json' };
import logging from './locales/ja/logging.json' with { type: 'json' };
import system from './locales/ja/system.json' with { type: 'json' };

export const jaResources = {
  commands,
  general,
  moderation,
  automod,
  raid,
  strikes,
  tools,
  voice,
  configuration,
  logging,
  system,
} as const;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'system';
    resources: typeof jaResources;
  }
}

void i18next.init({
  lng: 'ja',
  fallbackLng: 'ja',
  defaultNS: 'system',
  resources: {
    ja: jaResources,
  },
  interpolation: {
    escapeValue: false,
  },
});

export const t = i18next.t;

export default i18next;
