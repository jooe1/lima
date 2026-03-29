import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  localePrefix: 'never',
  localeCookie: { name: 'NEXT_LOCALE' },
})
