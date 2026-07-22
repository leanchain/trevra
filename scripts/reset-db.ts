import { openDatabase, resetDemoData } from '../src/server/db.js';

const db = openDatabase();
resetDemoData(db);
db.close();
console.log('Trevra demo database reset.');
