// 临时验证脚本：对 rocketx.exe --business-mcp 做 MCP stdio 握手（initialize + tools/list）
import { spawn } from 'node:child_process';

const exe = process.argv[2];
const child = spawn(exe, ['--business-mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const responses = [];
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      console.error('非 JSON 行:', line);
    }
  }
});
child.stderr.on('data', (chunk) => console.error('[stderr]', chunk.toString('utf8').trim()));
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-check', version: '0' } } });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const deadline = setTimeout(() => {
  console.error('超时');
  child.kill();
  process.exit(2);
}, 15000);
const poll = setInterval(() => {
  if (responses.length >= 2) {
    clearInterval(poll);
    clearTimeout(deadline);
    const init = responses.find((r) => r.id === 1);
    const list = responses.find((r) => r.id === 2);
    console.log('serverInfo:', JSON.stringify(init?.result?.serverInfo));
    console.log('tools:', (list?.result?.tools ?? []).map((t) => t.name).join(', '));
    child.kill();
    process.exit(0);
  }
}, 100);
