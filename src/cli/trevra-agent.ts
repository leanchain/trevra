import { readFile } from 'node:fs/promises';
import { TrevraAgentClient } from '../agent/client.js';

const client = new TrevraAgentClient();
const [command = 'help', ...args] = process.argv.slice(2);

try {
  if (command === 'skills') {
    print(await client.listSkills());
  } else if (command === 'playbooks') {
    print(await client.listPlaybooks());
  } else if (command === 'playbook:start') {
    if (!args[0])
      throw new Error(
        'Usage: npm run agent -- playbook:start <playbook-id> <json-or-@file> [version]'
      );
    print(await client.startPlaybook(args[0], await parseInput(args[1] ?? '{}'), args[2]));
  } else if (command === 'playbook:runs') {
    print(
      await client.listPlaybookRuns({
        status: args[0] as never,
        limit: args[1] ? Number(args[1]) : undefined
      })
    );
  } else if (command === 'playbook:get') {
    if (!args[0]) throw new Error('Usage: npm run agent -- playbook:get <run-id>');
    print(await client.getPlaybookRun(args[0]));
  } else if (command === 'events') {
    print(
      await client.listEvents({
        streamType: args[0],
        streamId: args[1],
        limit: args[2] ? Number(args[2]) : undefined
      })
    );
  } else if (command === 'run') {
    const skillId = args[0];
    if (!skillId) throw new Error('Usage: npm run agent -- run <skill-id> <json-or-@file>');
    const input = await parseInput(args[1] ?? '{}');
    print(await client.runSkill(skillId, input));
  } else if (command === 'runs') {
    print(
      await client.listRuns({ skillId: args[0], limit: args[1] ? Number(args[1]) : undefined })
    );
  } else if (command === 'run:get') {
    if (!args[0]) throw new Error('Usage: npm run agent -- run:get <run-id>');
    print(await client.getRun(args[0]));
  } else {
    process.stderr.write(
      [
        'Trevra agent CLI',
        '',
        'Environment:',
        '  TREVRA_API_URL       API origin, default http://localhost:43887',
        '  TREVRA_AGENT_TOKEN   scoped workspace agent token',
        '',
        'Commands:',
        '  skills',
        '  playbooks',
        '  playbook:start <playbook-id> <json-or-@file> [version]',
        '  playbook:runs [status] [limit]',
        '  playbook:get <run-id>',
        '  events [stream-type] [stream-id] [limit]',
        '  run <skill-id> <json-or-@file>',
        '  runs [skill-id] [limit]',
        '  run:get <run-id>',
        ''
      ].join('\n')
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function parseInput(value: string): Promise<unknown> {
  const raw = value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Skill input must be valid JSON or @path/to/input.json');
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
