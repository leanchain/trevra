import { openDatabase, resetDemoData } from '../src/server/db.js';

const db = await openDatabase();
await resetDemoData(db);
await db.close();
console.log('Trevra demo database reset.');
