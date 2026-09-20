import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://ci:ci_dev_password@localhost:5432/chatbot_integration',
  },
  // Keep drizzle-kit from trying to manage extension-owned objects.
  extensionsFilters: ['postgis'],
  verbose: true,
  strict: true,
})
