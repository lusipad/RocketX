import assert from 'node:assert/strict';
import test from 'node:test';
import {
  businessMcpThreadConfig,
  mergeBusinessMcpConfig,
  setBusinessMcpCommandInvoker,
  setBusinessMcpLaunchConfigProvider,
  syncBusinessMcpAzureDevOps,
  syncBusinessMcpRocketChat,
} from '../../apps/web/src/agent/businessMcp';

const launch = {
  command: 'C:\\Program Files\\RocketX\\rocketx.exe',
  args: ['--business-mcp'],
};

test('business MCP config merges without replacing existing MCP servers', () => {
  const merged = mergeBusinessMcpConfig({
    model_reasoning_effort: 'high',
    mcp_servers: {
      existing: {
        command: 'existing.exe',
        args: [],
      },
    },
  }, launch);

  assert.deepEqual(merged, {
    model_reasoning_effort: 'high',
    mcp_servers: {
      existing: {
        command: 'existing.exe',
        args: [],
      },
      rocketx_business: launch,
    },
  });
});

test('business MCP config does not overwrite malformed caller-owned mcp_servers', () => {
  const current = { mcp_servers: 'caller-owned-value' };
  assert.deepEqual(mergeBusinessMcpConfig(current, launch), current);
});

test('business MCP launch config is resolved once and reused for Butler threads', async () => {
  let calls = 0;
  const restore = setBusinessMcpLaunchConfigProvider(async () => {
    calls += 1;
    return launch;
  });
  try {
    const first = await businessMcpThreadConfig();
    const second = await businessMcpThreadConfig({ model_reasoning_effort: 'medium' });
    assert.equal(calls, 1);
    assert.deepEqual(first?.mcp_servers, { rocketx_business: launch });
    assert.deepEqual(second, {
      model_reasoning_effort: 'medium',
      mcp_servers: { rocketx_business: launch },
    });
  } finally {
    restore();
  }
});

test('business MCP failure leaves ordinary Codex config usable', async () => {
  const restore = setBusinessMcpLaunchConfigProvider(async () => {
    throw new Error('desktop unavailable');
  });
  try {
    const current = { model_reasoning_effort: 'high' };
    assert.deepEqual(await businessMcpThreadConfig(current), current);
  } finally {
    restore();
  }
});

test('Rocket.Chat account switch fails closed when credential sync fails', async () => {
  const calls: string[] = [];
  let failRocketChatSync = false;
  const restoreLaunch = setBusinessMcpLaunchConfigProvider(async () => launch);
  const restoreInvoker = setBusinessMcpCommandInvoker(async (command) => {
    calls.push(command);
    if (failRocketChatSync && command === 'business_mcp_sync_rocket_chat') {
      throw new Error('keychain unavailable');
    }
    return true;
  });
  try {
    assert.equal(await syncBusinessMcpRocketChat({
      serverUrl: 'https://chat.example.test',
      userId: 'account-a',
      authToken: 'token-a',
    }), true);
    assert.equal(await syncBusinessMcpAzureDevOps({}), true);
    assert.deepEqual(
      (await businessMcpThreadConfig())?.mcp_servers,
      { rocketx_business: launch },
    );

    failRocketChatSync = true;
    assert.equal(await syncBusinessMcpRocketChat({
      serverUrl: 'https://chat.example.test',
      userId: 'account-b',
      authToken: 'token-b',
    }), false);
    assert.equal(await businessMcpThreadConfig(), undefined);
    assert.deepEqual(calls.slice(-2), [
      'business_mcp_sync_rocket_chat',
      'business_mcp_clear_rocket_chat',
    ]);
  } finally {
    restoreInvoker();
    restoreLaunch();
  }
});

test('Azure DevOps connection switch fails closed when credential sync fails', async () => {
  const calls: string[] = [];
  let failAzureSync = false;
  const restoreLaunch = setBusinessMcpLaunchConfigProvider(async () => launch);
  const restoreInvoker = setBusinessMcpCommandInvoker(async (command) => {
    calls.push(command);
    if (failAzureSync && command === 'business_mcp_sync_azure_devops') {
      throw new Error('keychain unavailable');
    }
    return true;
  });
  try {
    assert.equal(await syncBusinessMcpRocketChat({
      serverUrl: 'https://chat.example.test',
      userId: 'account-a',
      authToken: 'token-a',
    }), true);
    assert.equal(await syncBusinessMcpAzureDevOps({
      collectionUrl: 'https://ado-a.example.test/tfs/DefaultCollection',
      authMode: 'pat',
      pat: 'pat-a',
    }), true);
    assert.ok((await businessMcpThreadConfig())?.mcp_servers);

    failAzureSync = true;
    assert.equal(await syncBusinessMcpAzureDevOps({
      collectionUrl: 'https://ado-b.example.test/tfs/DefaultCollection',
      authMode: 'pat',
      pat: 'pat-b',
    }), false);
    assert.equal(await businessMcpThreadConfig(), undefined);
    assert.deepEqual(calls.slice(-2), [
      'business_mcp_sync_azure_devops',
      'business_mcp_clear_azure_devops',
    ]);
  } finally {
    restoreInvoker();
    restoreLaunch();
  }
});

test('HTTP ADO consent is forwarded explicitly to the desktop credential gate', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const restoreInvoker = setBusinessMcpCommandInvoker(async (command, args) => {
    calls.push({ command, args });
    return true;
  });
  try {
    assert.equal(await syncBusinessMcpAzureDevOps({
      collectionUrl: 'http://ado.local/DefaultCollection',
      authMode: 'ntlm',
      allowInsecureAdoHttp: true,
    }), true);
    assert.deepEqual(calls[0], {
      command: 'business_mcp_sync_azure_devops',
      args: {
        collectionUrl: 'http://ado.local/DefaultCollection',
        authMode: 'ntlm',
        pat: undefined,
        allowInsecureAdoHttp: true,
      },
    });
  } finally {
    restoreInvoker();
  }
});
