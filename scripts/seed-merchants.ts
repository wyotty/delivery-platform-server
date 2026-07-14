// scripts/seed-merchants.ts
// Run: npx tsx scripts/seed-merchants.ts
import { db } from '../src/db/repo.js';
import { merchants, platformAccounts } from '../src/db/schema.js';

// Seed Đong Đầy merchant
db.insert(merchants)
  .values({ id: 'dong-day', name: 'Coffee & Bánh Mì Đong Đầy' })
  .onConflictDoNothing()
  .run();

// Seed Grab platform account
// Credentials are NOT stored here — they come from .env via credentialKey
db.insert(platformAccounts)
  .values({
    id: 'grab-dong-day',
    merchantId: 'dong-day',
    platform: 'grab',
    label: 'Grab Đong Đầy (main)',
    credentialKey: 'grab-dong-day', // maps to GRAB_USERNAME/GRAB_PASSWORD in .env
    config: JSON.stringify({ mgid: '0f02fe82-734e-481a-b574-dca5c46a4999' }),
    timezone: 'Asia/Ho_Chi_Minh',
  })
  .onConflictDoNothing()
  .run();

console.log('✅ Merchants seeded.');
console.log('   Account ID: grab-dong-day');
console.log('   Then: GRAB_USERNAME=x GRAB_PASSWORD=x pnpm fetch grab grab-dong-day 2026-07-14');
