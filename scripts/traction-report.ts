import 'dotenv/config';
import { openDatabase } from '../src/server/db.js';
import { getTractionReport } from '../src/server/public-site.js';

const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
const days = daysArg ? Number(daysArg.split('=')[1]) : 90;
if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error('--days must be an integer from 1 to 730');

const db = await openDatabase({ seedDemo: false });
try {
  const report = await getTractionReport(db, days);
  console.log(`\nTrevra traction — last ${report.periodDays} days`);
  console.log(`Generated: ${report.generatedAt}\n`);
  console.table(report.funnel);
  console.log('\nConversion rates');
  console.table(report.conversionRates);
  console.log('\nEvents');
  console.table(report.totals);
  console.log('\nSources');
  console.table(report.sources);
} finally {
  await db.close();
}
