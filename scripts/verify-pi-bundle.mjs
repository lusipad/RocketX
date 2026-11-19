import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export async function verifyPiBundle(archive, bridge, nodeVersion, sdkVersion, architectures) {
  const clean = await mkdtemp(path.join(os.tmpdir(), 'rocketx-installed-pi-'));
  const reply = 'RocketX packaged Pi first turn verified';
  const model = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions') || !body.includes('verify the packaged runtime')) {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finish] of [[{ role: 'assistant', content: reply }, null], [{}, 'stop']]) {
      response.write('data: ' + JSON.stringify({ id: 'release-smoke', object: 'chat.completion.chunk',
        model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    }
    response.end('data: [DONE]\n\n');
  });
  try {
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', clean]);
    const bridgeCopy = path.join(clean, 'pi_app_server.mjs');
    await copyFile(bridge, bridgeCopy);
    for (const arch of architectures) {
      const node = path.join(clean, 'bin', arch, process.platform === 'win32' ? 'node.exe' : 'node');
      const isolated = path.join(clean, 'user-' + arch);
      await mkdir(isolated);
      const config = path.join(isolated, 'test-model.json');
      const baseUrl = 'http://127.0.0.1:' + model.address().port + '/v1';
      await writeFile(config, JSON.stringify({ provider: 'deepseek', apiKey: 'release-smoke-only',
        baseUrl, defaultModel: 'deepseek-chat', extraModels: [] }));
      const env = {
        HOME: isolated, USERPROFILE: isolated, TEMP: isolated, TMP: isolated, TMPDIR: isolated,
        PATH: path.dirname(node), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      };
      const identity = execFileSync(node, ['-p', 'process.versions.node + "/" + process.arch'], { env, encoding: 'utf8' });
      assert.equal(identity.trim(), nodeVersion + '/' + arch);
      const child = spawn(node, [bridgeCopy, '--pi-package-dir', path.join(clean, 'node_modules/@earendil-works/pi-coding-agent'),
        '--workspace-root', isolated, '--agent-dir', path.join(isolated, 'agent'), '--config-file', config], {
        cwd: isolated, env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
      });
      const closed = once(child, 'close');
      const timeout = setTimeout(() => child.kill(), 45_000);
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const notifications = [];
      async function readFrame() {
        const next = await lines.next();
        assert.ok(!next.done, 'Pi closed before completing the first turn');
        const frame = JSON.parse(next.value);
        if (frame.method) notifications.push(frame);
        return frame;
      }
      async function request(id, method, params) {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        for (;;) {
          const frame = await readFrame();
          if (frame.id !== id) continue;
          assert.ok(!frame.error, JSON.stringify(frame.error));
          return frame.result;
        }
      }
      try {
        const init = await request(1, 'initialize', {});
        assert.equal(init.userAgent, 'rocketx/' + sdkVersion);
        const started = await request(2, 'thread/start', { cwd: isolated });
        assert.ok(started.thread?.id);
        const turn = await request(3, 'turn/start', { threadId: started.thread.id, model: 'deepseek/deepseek-chat',
          input: [{ type: 'text', text: 'verify the packaged runtime', text_elements: [] }] });
        assert.ok(turn.turn?.id);
        const completion = () => notifications.find(frame => frame.method === 'turn/completed' && frame.params.turn.id === turn.turn.id);
        while (!completion()) await readFrame();
        assert.equal(completion().params.turn.status, 'completed', JSON.stringify(completion().params.turn.error));
        assert.equal(notifications.filter(frame => frame.method === 'item/agentMessage/delta').map(frame => frame.params.delta).join(''), reply);
        child.stdin.end();
        const [code] = await closed;
        assert.equal(code, 0);
        console.log(`Clean Pi ${sdkVersion}: ${arch} initialize, thread/start, first streaming turn passed`);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      }
    }
  } finally {
    model.close();
    model.closeAllConnections();
    await rm(clean, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
