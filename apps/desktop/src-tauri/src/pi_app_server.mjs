#!/usr/bin/env node
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const options = {
    piPackageDir: '',
    agentDir: '',
    configFile: '',
    workspaceRoot: process.cwd(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--pi-package-dir' && next) {
      options.piPackageDir = next;
      i += 1;
    } else if (arg === '--agent-dir' && next) {
      options.agentDir = next;
      i += 1;
    } else if (arg === '--config-file' && next) {
      options.configFile = next;
      i += 1;
    } else if (arg === '--workspace-root' && next) {
      options.workspaceRoot = next;
      i += 1;
    }
  }
  return options;
}

const cliOptions = parseArgs(process.argv.slice(2));

async function loadPiModules(piPackageDir) {
  const root = piPackageDir
    ? path.resolve(piPackageDir)
    : path.resolve(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent');
  const indexUrl = pathToFileURL(path.join(root, 'dist', 'index.js')).href;
  const guardUrl = pathToFileURL(path.join(root, 'dist', 'core', 'output-guard.js')).href;
  const sdk = await import(indexUrl);
  const guard = await import(guardUrl);
  return { sdk, guard, root };
}

const { sdk, guard } = await loadPiModules(cliOptions.piPackageDir);
const {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSession,
  loadSkillsFromDir,
} = sdk;
const { takeOverStdout, writeRawStdout } = guard;

// Prevent extensions or accidental console.log calls from corrupting JSON-RPC stdout.
takeOverStdout();

const PI_VERSION = typeof VERSION === 'string' && VERSION.trim() ? VERSION.trim() : '1.5.0';
const agentDir = cliOptions.agentDir
  ? path.resolve(cliOptions.agentDir)
  : path.join(os.homedir(), '.pi', 'rocketx-agent');
const sessionsRootDir = path.join(agentDir, 'sessions');
const threadIndexPath = path.join(agentDir, 'rocketx-thread-index.json');
const disabledSkillsPath = path.join(agentDir, 'rocketx-disabled-skills.json');
fs.mkdirSync(sessionsRootDir, { recursive: true });

function writeFrame(frame) {
  writeRawStdout(`${JSON.stringify(frame)}\n`);
}

function sendNotification(method, params) {
  writeFrame({ method, params });
}

let nextServerRequestId = 1;
const pendingServerRequests = new Map();

function sendServerRequest(method, params) {
  const id = `pi-req-${nextServerRequestId++}`;
  return new Promise((resolve, reject) => {
    pendingServerRequests.set(id, { resolve, reject, threadId: params?.threadId });
    writeFrame({ id, method, params });
  });
}

function normalizeFsPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return '';
  const trimmed = targetPath.trim();
  if (!trimmed) return '';
  const resolved = path.resolve(trimmed).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideRoot(targetPath, rootPath) {
  const normTarget = normalizeFsPath(targetPath);
  const normRoot = normalizeFsPath(rootPath);
  if (!normTarget || !normRoot) return false;
  return normTarget === normRoot || normTarget.startsWith(`${normRoot}/`);
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFileSafe(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
  } catch {
    // Ignore transient persistence errors.
  }
}

function loadThreadIndex() {
  const raw = readJsonFileSafe(threadIndexPath, { threads: {} });
  return raw && typeof raw === 'object' && raw.threads && typeof raw.threads === 'object'
    ? raw
    : { threads: {} };
}

function saveThreadIndex(index) {
  writeJsonFileSafe(threadIndexPath, index);
}

function loadDisabledSkills() {
  const raw = readJsonFileSafe(disabledSkillsPath, []);
  return new Set(Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : []);
}

function saveDisabledSkills(set) {
  writeJsonFileSafe(disabledSkillsPath, [...set]);
}

const PROVIDER_PRESETS = {
  deepseek: {
    providerId: 'deepseek',
    label: 'DeepSeek 官方',
    api: 'openai-completions',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    keylessAllowed: false,
    defaultModels: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: false, contextWindow: 1000000, maxTokens: 16384 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (推理)', reasoning: true, contextWindow: 1000000, maxTokens: 32768 },
      { id: 'deepseek-chat', name: 'DeepSeek V3 (兼容)', reasoning: false, contextWindow: 128000, maxTokens: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1 (兼容推理)', reasoning: true, contextWindow: 128000, maxTokens: 16384 },
    ],
  },
  anthropic: {
    providerId: 'anthropic',
    label: 'Anthropic (Claude)',
    api: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    keylessAllowed: false,
    defaultModels: [
      { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', reasoning: true, contextWindow: 1000000, maxTokens: 32768 },
      { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', reasoning: true, contextWindow: 1000000, maxTokens: 32768 },
      { id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', reasoning: false, contextWindow: 500000, maxTokens: 16384 },
      { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', reasoning: true, contextWindow: 200000, maxTokens: 16384 },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', reasoning: false, contextWindow: 200000, maxTokens: 8192 },
    ],
  },
  openai: {
    providerId: 'openai',
    label: 'OpenAI',
    api: 'openai-responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keylessAllowed: false,
    defaultModels: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol (工程/代码)', reasoning: true, contextWindow: 500000, maxTokens: 32768 },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra (多智能体)', reasoning: true, contextWindow: 500000, maxTokens: 32768 },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna (极速)', reasoning: false, contextWindow: 256000, maxTokens: 16384 },
      { id: 'o3-mini', name: 'o3-mini (推理)', reasoning: true, contextWindow: 200000, maxTokens: 32768 },
      { id: 'gpt-4.5-preview', name: 'GPT-4.5 Preview', reasoning: false, contextWindow: 128000, maxTokens: 16384 },
      { id: 'gpt-4o', name: 'GPT-4o', reasoning: false, contextWindow: 128000, maxTokens: 16384 },
    ],
  },
  google: {
    providerId: 'google',
    label: 'Google Gemini',
    api: 'openai-completions',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keylessAllowed: false,
    defaultModels: [
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', reasoning: true, contextWindow: 2000000, maxTokens: 32768 },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', reasoning: true, contextWindow: 1000000, maxTokens: 16384 },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true, contextWindow: 1000000, maxTokens: 16384 },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', reasoning: false, contextWindow: 1000000, maxTokens: 8192 },
    ],
  },
  'custom-openai': {
    providerId: 'custom-openai',
    label: '企业 / 自定义 OpenAI 网关',
    api: 'openai-completions',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    keylessAllowed: true,
    defaultModels: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (网关)', reasoning: false, contextWindow: 1000000, maxTokens: 16384 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (网关推理)', reasoning: true, contextWindow: 1000000, maxTokens: 32768 },
      { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5 (网关)', reasoning: true, contextWindow: 500000, maxTokens: 16384 },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol (网关)', reasoning: true, contextWindow: 500000, maxTokens: 16384 },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon (网关)', reasoning: true, contextWindow: 2000000, maxTokens: 32768 },
      { id: 'qwen3-coder', name: 'Qwen 3 Coder (网关)', reasoning: false, contextWindow: 65536, maxTokens: 16384 },
      { id: 'deepseek-r1', name: 'DeepSeek R1 (网关)', reasoning: true, contextWindow: 128000, maxTokens: 16384 },
      { id: 'deepseek-chat', name: 'DeepSeek Chat (网关)', reasoning: false, contextWindow: 128000, maxTokens: 8192 },
    ],
  },
  ollama: {
    providerId: 'ollama',
    label: 'Ollama 本地运行',
    api: 'openai-completions',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    keylessAllowed: true,
    defaultModels: [
      { id: 'qwen3-coder', name: 'Qwen 3 Coder (本地编码)', reasoning: false, contextWindow: 65536, maxTokens: 16384 },
      { id: 'qwen3:8b', name: 'Qwen 3 8B (本地全能)', reasoning: false, contextWindow: 65536, maxTokens: 8192 },
      { id: 'qwen3.8-27b', name: 'Qwen 3.8 27B (工作站高精)', reasoning: true, contextWindow: 65536, maxTokens: 16384 },
      { id: 'deepseek-r1:8b', name: 'DeepSeek R1 8B (本地推理)', reasoning: true, contextWindow: 32768, maxTokens: 8192 },
      { id: 'qwen2.5-coder:7b', name: 'Qwen 2.5 Coder 7B', reasoning: false, contextWindow: 32768, maxTokens: 8192 },
    ],
  },
  openrouter: {
    providerId: 'openrouter',
    label: 'OpenRouter',
    api: 'openai-completions',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keylessAllowed: false,
    defaultModels: [
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash (OpenRouter)', reasoning: false, contextWindow: 1000000, maxTokens: 16384 },
      { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5 (OpenRouter)', reasoning: true, contextWindow: 1000000, maxTokens: 32768 },
      { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol (OpenRouter)', reasoning: true, contextWindow: 500000, maxTokens: 32768 },
      { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon (OpenRouter)', reasoning: true, contextWindow: 2000000, maxTokens: 32768 },
    ],
  },
};

function readPiUserConfig() {
  const raw = readJsonFileSafe(cliOptions.configFile, {});
  const provider = typeof raw.provider === 'string' && PROVIDER_PRESETS[raw.provider]
    ? raw.provider
    : 'deepseek';
  const preset = PROVIDER_PRESETS[provider];
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim()
    ? raw.baseUrl.trim().replace(/\/+$/, '')
    : preset.defaultBaseUrl;
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  const defaultModel = typeof raw.defaultModel === 'string' && raw.defaultModel.trim()
    ? raw.defaultModel.trim()
    : preset.defaultModels[0]?.id || 'deepseek-v4-flash';
  const extraModels = Array.isArray(raw.extraModels)
    ? raw.extraModels
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
    : [];
  return {
    provider,
    preset,
    baseUrl,
    apiKey,
    defaultModel,
    extraModels,
  };
}

async function fetchOllamaModelsIfAvailable(baseUrl) {
  try {
    const rootUrl = baseUrl.replace(/\/v1\/?$/i, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    try {
      const response = await fetch(`${rootUrl}/api/tags`, { signal: controller.signal });
      if (!response.ok) return [];
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.models)) return [];
      return payload.models
        .map((entry) => (typeof entry?.name === 'string' ? entry.name.trim() : ''))
        .filter(Boolean);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}

function buildProviderModelDefs(config, discoveredModelIds = [], requestedModelId = '') {
  const seen = new Set();
  const defs = [];
  const pushModel = (id, name, reasoning = true, contextWindow = 128000, maxTokens = 8192) => {
    const cleanId = String(id || '').trim();
    if (!cleanId || seen.has(cleanId)) return;
    seen.add(cleanId);
    defs.push({
      id: cleanId,
      name: name || cleanId,
      api: config.preset.api,
      baseUrl: config.baseUrl,
      reasoning,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      ...(config.preset.api === 'openai-completions'
        ? {
          compat: {
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
          },
        }
        : {}),
    });
  };

  if (requestedModelId) {
    const cleanReq = requestedModelId.includes('/')
      ? requestedModelId.split('/').slice(1).join('/')
      : requestedModelId;
    pushModel(cleanReq, cleanReq, /reasoner|r1|thinking|pro|sol|o1|o3|o4|claude/i.test(cleanReq));
  }

  if (config.defaultModel) {
    const presetMatch = config.preset.defaultModels.find((m) => m.id === config.defaultModel);
    pushModel(
      config.defaultModel,
      presetMatch?.name || config.defaultModel,
      presetMatch?.reasoning ?? /reasoner|r1|thinking|pro|sol|o1|o3|o4|claude/i.test(config.defaultModel),
      presetMatch?.contextWindow ?? 128000,
      presetMatch?.maxTokens ?? 8192,
    );
  }
  for (const modelId of config.extraModels) {
    pushModel(modelId, modelId, /reasoner|r1|thinking|pro|sol|o1|o3|o4|claude/i.test(modelId));
  }
  for (const modelId of discoveredModelIds) {
    pushModel(modelId, `${modelId} (Ollama)`, /r1|thinking|qwq/i.test(modelId), 32768, 8192);
  }
  for (const presetModel of config.preset.defaultModels) {
    pushModel(
      presetModel.id,
      presetModel.name,
      presetModel.reasoning,
      presetModel.contextWindow,
      presetModel.maxTokens,
    );
  }
  return defs;
}

async function createConfiguredModelRuntime(requestedModelId = '') {
  const config = readPiUserConfig();
  const authPath = path.join(agentDir, 'auth.json');
  const modelsPath = path.join(agentDir, 'models.json');
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const modelRegistry = new ModelRegistry(modelRuntime);

  const discoveredOllama = config.provider === 'ollama'
    ? await fetchOllamaModelsIfAvailable(config.baseUrl)
    : [];
  const modelDefs = buildProviderModelDefs(config, discoveredOllama, requestedModelId);
  const effectiveApiKey = config.apiKey || (config.preset.keylessAllowed ? 'rocketx-local-keyless' : '');

  if (effectiveApiKey) {
    await modelRuntime.setRuntimeApiKey(config.provider, effectiveApiKey);
  }

  // Register or override the active provider so custom baseUrl, models, and intranet OpenAI gateways work seamlessly.
  const shouldRegisterCustomProvider =
    config.provider === 'deepseek'
    || config.provider === 'custom-openai'
    || config.provider === 'ollama'
    || config.baseUrl !== config.preset.defaultBaseUrl
    || config.extraModels.length > 0
    || Boolean(requestedModelId);

  if (shouldRegisterCustomProvider || effectiveApiKey) {
    modelRuntime.registerProvider(config.provider, {
      name: config.preset.label,
      baseUrl: config.baseUrl,
      apiKey: effectiveApiKey || 'UNCONFIGURED_API_KEY',
      api: config.preset.api,
      authHeader: true,
      models: modelDefs,
    });
  }

  await modelRuntime.refresh({ allowNetwork: false });
  const hasRealCredentials = Boolean(
    config.apiKey
    || config.preset.keylessAllowed
    || (config.provider === 'openai' && process.env.OPENAI_API_KEY)
    || (config.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY)
    || (config.provider === 'openrouter' && process.env.OPENROUTER_API_KEY)
    || (config.provider === 'google' && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY))
    || (config.provider === 'deepseek' && process.env.DEEPSEEK_API_KEY),
  );

  return {
    config,
    modelRegistry,
    modelRuntime,
    modelDefs,
    hasRealCredentials,
  };
}

const REASONING_EFFORT_OPTIONS = [
  { reasoningEffort: 'low', description: '轻量快速推理' },
  { reasoningEffort: 'medium', description: '均衡推理深度（默认）' },
  { reasoningEffort: 'high', description: '深度多步推理' },
];

function toRocketxModel(providerId, providerLabel, modelDef, isDefault) {
  const fullId = `${providerId}/${modelDef.id}`;
  const cleanName = modelDef.name || modelDef.id;
  return {
    id: fullId,
    model: fullId,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: cleanName,
    description: `${providerLabel} · ${modelDef.id}`,
    hidden: false,
    canReason: Boolean(modelDef.reasoning),
    supportedReasoningEfforts: REASONING_EFFORT_OPTIONS,
    defaultReasoningEffort: 'medium',
    inputModalities: Array.isArray(modelDef.input) && modelDef.input.length > 0 ? modelDef.input : ['text', 'image'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: Boolean(isDefault),
  };
}

async function listRocketxModels() {
  const { config, modelRuntime, modelDefs } = await createConfiguredModelRuntime();
  const defaultFullId = `${config.provider}/${config.defaultModel}`;
  const results = [];
  const seen = new Set();

  // 1. Primary models from the active configured provider
  for (const def of modelDefs) {
    const entry = toRocketxModel(
      config.provider,
      config.preset.label,
      def,
      `${config.provider}/${def.id}` === defaultFullId || def.id === config.defaultModel,
    );
    seen.add(entry.id);
    results.push(entry);
  }

  // 2. Models discovered or registered in Pi's runtime snapshot
  for (const model of modelRuntime.getAvailableSnapshot()) {
    const fullId = `${model.provider}/${model.id}`;
    if (seen.has(fullId)) continue;
    seen.add(fullId);
    results.push(toRocketxModel(
      model.provider,
      model.provider,
      { id: model.id, name: model.name, input: model.input },
      results.length === 0,
    ));
  }

  // 3. Preset models from other providers (Anthropic, OpenAI, DeepSeek, Google, Ollama)
  for (const [presetKey, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (presetKey === config.provider) continue;
    for (const def of preset.defaultModels) {
      const fullId = `${presetKey}/${def.id}`;
      if (seen.has(fullId)) continue;
      seen.add(fullId);
      results.push(toRocketxModel(
        presetKey,
        preset.label,
        def,
        false,
      ));
    }
  }

  if (!results.some((m) => m.isDefault) && results.length > 0) {
    results[0].isDefault = true;
  }
  return results;
}

let extraSkillRoots = [];

function listSkillsForCwds(cwds) {
  const disabled = loadDisabledSkills();
  const targetCwds = Array.isArray(cwds) && cwds.length > 0 ? cwds : [cliOptions.workspaceRoot];
  return targetCwds.map((cwd) => {
    const seenPaths = new Set();
    const skills = [];
    const scanDirs = [
      ...extraSkillRoots.map((dir) => ({ dir, scope: 'system' })),
      { dir: path.join(cwd, '.pi', 'skills'), scope: 'repo' },
      { dir: path.join(cwd, '.agents', 'skills'), scope: 'repo' },
    ];
    for (const { dir, scope } of scanDirs) {
      if (!dir || !fs.existsSync(dir)) continue;
      try {
        const loaded = loadSkillsFromDir({ dir, source: scope });
        for (const skill of loaded.skills || []) {
          const norm = normalizeFsPath(skill.filePath);
          if (!norm || seenPaths.has(norm)) continue;
          seenPaths.add(norm);
          skills.push({
            name: skill.name,
            description: skill.description || skill.name,
            shortDescription: skill.description || skill.name,
            path: skill.filePath,
            scope,
            enabled: !disabled.has(norm),
          });
        }
      } catch {
        // Ignore unreadable skill directories.
      }
    }
    return {
      cwd,
      skills,
      errors: [],
    };
  });
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractImagesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const urls = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
      urls.push(`data:${part.mimeType};base64,${part.data}`);
    }
  }
  return urls;
}

function projectSessionEntriesToTurns(sessionManager, dynamicToolNames = new Set()) {
  const entries = sessionManager.buildContextEntries();
  const turns = [];
  let currentTurn = null;
  let turnCounter = 0;

  const flushTurn = () => {
    if (currentTurn) {
      turns.push(currentTurn);
      currentTurn = null;
    }
  };

  for (const entry of entries) {
    if (!entry || entry.type !== 'message' || !entry.message) continue;
    const msg = entry.message;
    const tsSeconds = typeof msg.timestamp === 'number'
      ? Math.floor(msg.timestamp / 1000)
      : Math.floor(Date.now() / 1000);

    if (msg.role === 'user') {
      flushTurn();
      turnCounter += 1;
      const userInputs = [];
      const text = extractTextFromContent(msg.content);
      if (text) userInputs.push({ type: 'text', text, text_elements: [] });
      for (const imageUrl of extractImagesFromContent(msg.content)) {
        userInputs.push({ type: 'image', url: imageUrl });
      }
      currentTurn = {
        id: `turn-${entry.id || turnCounter}`,
        items: [
          {
            type: 'userMessage',
            id: `user-${entry.id || turnCounter}`,
            content: userInputs,
          },
        ],
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: tsSeconds,
        completedAt: tsSeconds,
        durationMs: 0,
      };
      continue;
    }

    if (!currentTurn) {
      turnCounter += 1;
      currentTurn = {
        id: `turn-${entry.id || turnCounter}`,
        items: [],
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: tsSeconds,
        completedAt: tsSeconds,
        durationMs: 0,
      };
    }

    if (msg.role === 'assistant') {
      currentTurn.completedAt = tsSeconds;
      if (msg.stopReason === 'error' || msg.errorMessage) {
        currentTurn.status = 'failed';
        currentTurn.error = {
          message: msg.errorMessage || '模型调用失败',
          codexErrorInfo: 'other',
          additionalDetails: null,
        };
      } else if (msg.stopReason === 'aborted') {
        currentTurn.status = 'interrupted';
      }
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const thinkingBlocks = blocks.filter((b) => b && (b.type === 'thinking' || typeof b.thinking === 'string'));
      for (const tb of thinkingBlocks) {
        const text = typeof tb.thinking === 'string' ? tb.thinking : typeof tb.text === 'string' ? tb.text : '';
        if (text.trim()) {
          currentTurn.items.push({
            type: 'reasoning',
            id: `reason-${entry.id || crypto.randomUUID()}`,
            summary: [],
            content: [text],
          });
        }
      }
      const assistantText = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      if (assistantText.trim()) {
        currentTurn.items.push({
          type: 'agentMessage',
          id: `msg-${entry.id || crypto.randomUUID()}`,
          text: assistantText,
          phase: 'final_answer',
          memoryCitation: null,
        });
      }
      for (const block of blocks) {
        if (!block || block.type !== 'toolCall') continue;
        const callId = block.id || `call-${crypto.randomUUID()}`;
        const toolName = block.name || 'tool';
        const args = block.arguments && typeof block.arguments === 'object' ? block.arguments : {};
        if (toolName === 'bash' || toolName === 'powershell') {
          currentTurn.items.push({
            type: 'commandExecution',
            id: callId,
            command: typeof args.command === 'string' ? args.command : JSON.stringify(args),
            cwd: sessionManager.getCwd() || cliOptions.workspaceRoot,
            processId: null,
            source: 'agent',
            status: 'completed',
            commandActions: [],
            aggregatedOutput: null,
            exitCode: 0,
            durationMs: null,
          });
        } else if (toolName === 'write' || toolName === 'edit') {
          currentTurn.items.push({
            type: 'fileChange',
            id: callId,
            changes: [
              {
                path: typeof args.path === 'string' ? args.path : 'file',
                kind: toolName === 'write' ? { type: 'add' } : { type: 'update', move_path: null },
                diff: '',
              },
            ],
            status: 'completed',
          });
        } else {
          currentTurn.items.push({
            type: 'dynamicToolCall',
            id: callId,
            tool: toolName,
            namespace: toolName.includes('_') ? toolName.split('_')[0] : null,
            arguments: args,
            status: 'completed',
            contentItems: null,
            success: true,
            durationMs: null,
          });
        }
      }
      continue;
    }

    if (msg.role === 'toolResult') {
      const existing = currentTurn.items.find((item) => item.id === msg.toolCallId);
      const outputText = extractTextFromContent(msg.content);
      if (existing) {
        existing.status = msg.isError ? 'failed' : 'completed';
        if (existing.type === 'commandExecution') {
          existing.aggregatedOutput = outputText || null;
          existing.exitCode = msg.isError ? 1 : 0;
        } else if (existing.type === 'fileChange') {
          if (existing.changes?.[0] && msg.details?.diff) {
            existing.changes[0].diff = msg.details.diff;
          }
        } else if (existing.type === 'dynamicToolCall') {
          existing.success = !msg.isError;
          existing.contentItems = outputText ? [{ type: 'inputText', text: outputText }] : [];
        }
      }
    }
  }

  flushTurn();
  return turns;
}

// Active thread states keyed by threadId
const threadRecords = new Map();

function buildRocketxThreadObject(record, includeTurns = false) {
  const turns = includeTurns && record.sessionManager
    ? projectSessionEntriesToTurns(record.sessionManager, new Set((record.dynamicTools || []).map((t) => t.name)))
    : [];
  const nowSec = Math.floor(Date.now() / 1000);
  const createdAt = record.createdAt || nowSec;
  const updatedAt = record.updatedAt || createdAt;
  return {
    id: record.id,
    extra: null,
    sessionId: record.id,
    forkedFromId: record.forkedFromId || null,
    parentThreadId: null,
    preview: record.preview || record.name || '新对话',
    ephemeral: false,
    historyMode: 'full',
    modelProvider: record.modelProvider || readPiUserConfig().provider,
    createdAt,
    updatedAt,
    recencyAt: updatedAt,
    status: record.activeTurnId ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    path: record.sessionFile || null,
    cwd: record.cwd || cliOptions.workspaceRoot,
    cliVersion: PI_VERSION,
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: record.name || null,
    turns,
  };
}

function persistThreadMetadata(record) {
  const index = loadThreadIndex();
  index.threads[record.id] = {
    id: record.id,
    cwd: record.cwd,
    name: record.name || null,
    preview: record.preview || '',
    sessionFile: record.sessionManager?.getSessionFile() || record.sessionFile || null,
    forkedFromId: record.forkedFromId || null,
    modelProvider: record.modelProvider || readPiUserConfig().provider,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archived: Boolean(record.archived),
  };
  saveThreadIndex(index);
}

async function hydrateStoredThreadsForCwds(cwds) {
  const index = loadThreadIndex();
  const targetNorms = Array.isArray(cwds) && cwds.length > 0
    ? new Set(cwds.map(normalizeFsPath).filter(Boolean))
    : null;

  try {
    const discovered = await SessionManager.listAll(sessionsRootDir);
    for (const info of discovered) {
      if (!info?.id) continue;
      const existingMeta = index.threads[info.id] || {};
      if (existingMeta.archived) continue;
      const cwd = info.cwd || existingMeta.cwd || cliOptions.workspaceRoot;
      if (!threadRecords.has(info.id)) {
        threadRecords.set(info.id, {
          id: info.id,
          cwd,
          name: info.name || existingMeta.name || null,
          preview: info.firstMessage || existingMeta.preview || info.name || 'Pi 任务',
          sessionFile: info.path,
          sessionManager: null,
          agentSession: null,
          dynamicTools: [],
          permissions: ':workspace',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'guardian_subagent',
          sessionApprovedTools: new Set(),
          model: '',
          effort: 'medium',
          modelProvider: existingMeta.modelProvider || readPiUserConfig().provider,
          forkedFromId: existingMeta.forkedFromId || null,
          createdAt: Math.floor((info.created instanceof Date ? info.created.getTime() : Date.now()) / 1000),
          updatedAt: Math.floor((info.modified instanceof Date ? info.modified.getTime() : Date.now()) / 1000),
          archived: false,
          activeTurnId: null,
        });
      }
    }
  } catch {
    // Ignore scan errors on empty session directories.
  }

  for (const [id, meta] of Object.entries(index.threads)) {
    if (!meta || meta.archived || threadRecords.has(id)) continue;
    if (meta.sessionFile && fs.existsSync(meta.sessionFile)) {
      threadRecords.set(id, {
        id,
        cwd: meta.cwd || cliOptions.workspaceRoot,
        name: meta.name || null,
        preview: meta.preview || meta.name || 'Pi 任务',
        sessionFile: meta.sessionFile,
        sessionManager: null,
        agentSession: null,
        dynamicTools: [],
        permissions: ':workspace',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'guardian_subagent',
        sessionApprovedTools: new Set(),
        model: '',
        effort: 'medium',
        modelProvider: meta.modelProvider || readPiUserConfig().provider,
        forkedFromId: meta.forkedFromId || null,
        createdAt: meta.createdAt || Math.floor(Date.now() / 1000),
        updatedAt: meta.updatedAt || Math.floor(Date.now() / 1000),
        archived: false,
        activeTurnId: null,
      });
    }
  }

  const results = [];
  for (const record of threadRecords.values()) {
    if (record.archived) continue;
    if (targetNorms && targetNorms.size > 0 && !targetNorms.has(normalizeFsPath(record.cwd))) {
      continue;
    }
    results.push(buildRocketxThreadObject(record, false));
  }
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

function ensureSessionManager(record) {
  if (record.sessionManager) return record.sessionManager;
  if (record.sessionFile && fs.existsSync(record.sessionFile)) {
    record.sessionManager = SessionManager.open(record.sessionFile, sessionsRootDir, record.cwd);
  } else {
    fs.mkdirSync(record.cwd, { recursive: true });
    record.sessionManager = SessionManager.create(record.cwd, sessionsRootDir);
  }
  return record.sessionManager;
}

function mapEffortToThinkingLevel(effort) {
  if (effort === 'low' || effort === 'minimal') return 'low';
  if (effort === 'high' || effort === 'xhigh') return 'high';
  if (effort === 'none') return 'off';
  return 'medium';
}

function buildDynamicToolDefinitions(record) {
  const specs = Array.isArray(record.dynamicTools) ? record.dynamicTools : [];
  return specs.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description || spec.name,
    promptSnippet: `${spec.name}: ${spec.description || ''}`.slice(0, 180),
    parameters: spec.inputSchema || { type: 'object', properties: {} },
    async execute(toolCallId, params) {
      const turnId = record.activeTurnId || `turn-${Date.now()}`;
      const response = await sendServerRequest('item/tool/call', {
        threadId: record.id,
        turnId,
        callId: toolCallId,
        tool: spec.name,
        arguments: params ?? {},
      });
      const items = Array.isArray(response?.contentItems) ? response.contentItems : [];
      const content = items.map((item) => {
        if (item?.type === 'inputImage' && typeof item.imageUrl === 'string') {
          const match = /^data:([^;,]+);base64,(.+)$/s.exec(item.imageUrl);
          if (match) {
            return { type: 'image', mimeType: match[1], data: match[2] };
          }
        }
        return {
          type: 'text',
          text: typeof item?.text === 'string' ? item.text : JSON.stringify(item ?? ''),
        };
      });
      if (response?.success === false) {
        const errText = content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') || `${spec.name} 调用失败`;
        throw new Error(errText);
      }
      return {
        content: content.length > 0 ? content : [{ type: 'text', text: 'OK' }],
        details: { dynamicTool: spec.name },
      };
    },
  }));
}

function createPermissionExtension(record) {
  return {
    name: 'rocketx-permission-gate',
    hidden: true,
    factory(pi) {
      pi.on('tool_call', async (event) => {
        const toolName = event.toolName;
        const allowedRoots = record.runtimeWorkspaceRoots?.length
          ? record.runtimeWorkspaceRoots
          : [record.cwd];

        const requiresUserApproval = (() => {
          if (record.permissions === ':danger-full-access' || record.approvalPolicy === 'never') {
            return false;
          }
          if (record.sessionApprovedTools.has(toolName)) {
            return false;
          }
          if (record.approvalsReviewer === 'user') {
            return toolName === 'bash' || toolName === 'powershell' || toolName === 'write' || toolName === 'edit';
          }
          // In 'auto' ('guardian_subagent') mode, allow workspace-local operations automatically,
          // and request user approval only for outside-workspace writes or destructive shell commands.
          if (toolName === 'write' || toolName === 'edit') {
            const target = typeof event.input?.path === 'string'
              ? path.resolve(record.cwd, event.input.path)
              : '';
            return Boolean(target && !allowedRoots.some((root) => isPathInsideRoot(target, root)));
          }
          if (toolName === 'bash' || toolName === 'powershell') {
            const cmd = String(event.input?.command || '');
            return /\b(rm\s+-rf\s+\/|Remove-Item\s+.*-Recurse\s+.*-Force|git\s+push\s+--force|git\s+reset\s+--hard|format\s+[a-z]:)\b/i.test(cmd);
          }
          return false;
        })();

        if (!requiresUserApproval) return undefined;

        const turnId = record.activeTurnId || `turn-${Date.now()}`;
        if (toolName === 'write' || toolName === 'edit') {
          const targetPath = typeof event.input?.path === 'string'
            ? path.resolve(record.cwd, event.input.path)
            : record.cwd;
          const res = await sendServerRequest('item/fileChange/requestApproval', {
            threadId: record.id,
            turnId,
            itemId: event.toolCallId,
            reason: `Pi 请求修改文件：${targetPath}`,
            grantRoot: path.dirname(targetPath),
          });
          const decision = res?.decision;
          if (decision === 'acceptForSession') {
            record.sessionApprovedTools.add(toolName);
            return undefined;
          }
          if (decision === 'accept') return undefined;
          return { block: true, reason: '用户拒绝了文件修改审批' };
        }

        const commandText = typeof event.input?.command === 'string'
          ? event.input.command
          : JSON.stringify(event.input ?? {});
        const res = await sendServerRequest('item/commandExecution/requestApproval', {
          threadId: record.id,
          turnId,
          itemId: event.toolCallId,
          command: commandText,
          cwd: record.cwd,
          reason: `Pi 请求执行命令`,
        });
        const decision = res?.decision;
        if (decision === 'acceptForSession') {
          record.sessionApprovedTools.add(toolName);
          return undefined;
        }
        if (decision === 'accept') return undefined;
        return { block: true, reason: '用户拒绝了命令执行审批' };
      });
    },
  };
}

function selectModelFromRuntime(modelRuntime, requestedModelId, fallbackProvider, fallbackModelId) {
  const snapshot = modelRuntime.getAvailableSnapshot();
  const requested = String(requestedModelId || '').trim();
  if (requested) {
    if (requested.includes('/')) {
      const [prov, ...rest] = requested.split('/');
      const modId = rest.join('/');
      const exact = snapshot.find((m) => m.provider === prov && m.id === modId)
        || modelRuntime.getModel(prov, modId);
      if (exact) return exact;
      const fallbackExact = modelRuntime.getModel(fallbackProvider, modId);
      if (fallbackExact) return fallbackExact;
    } else {
      const byId = snapshot.find((m) => m.id === requested)
        || modelRuntime.getModel(fallbackProvider, requested);
      if (byId) return byId;
    }
  }
  return snapshot.find((m) => m.provider === fallbackProvider && m.id === fallbackModelId)
    || modelRuntime.getModel(fallbackProvider, fallbackModelId)
    || snapshot[0];
}

async function ensureAgentSession(record) {
  const runtimeBundle = await createConfiguredModelRuntime(record.model);
  if (!runtimeBundle.hasRealCredentials) {
    throw new Error(
      `尚未配置 ${runtimeBundle.config.preset.label} 的 API Key。请前往 RocketX「设置 → AI → Pi」填写 API Key，或切换为 Ollama / 免密内网兼容网关。`,
    );
  }

  const sessionManager = ensureSessionManager(record);
  const selectedModel = selectModelFromRuntime(
    runtimeBundle.modelRuntime,
    record.model,
    runtimeBundle.config.provider,
    runtimeBundle.config.defaultModel,
  );
  if (!selectedModel) {
    throw new Error('未找到可用的 Pi 模型，请在「设置 → AI → Pi」中检查模型名称与网关地址。');
  }
  record.modelProvider = selectedModel.provider;

  if (record.agentSession) {
    try {
      await record.agentSession.setModel(selectedModel);
      record.agentSession.setThinkingLevel(mapEffortToThinkingLevel(record.effort));
      return record.agentSession;
    } catch {
      record.unsubscribeEvents?.();
      record.agentSession.dispose?.();
      record.agentSession = null;
    }
  }

  const disabledSkills = loadDisabledSkills();
  const activeSkillRoots = extraSkillRoots.filter((dir) => dir && fs.existsSync(dir));
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: selectedModel.provider,
    defaultModel: selectedModel.id,
    defaultThinkingLevel: mapEffortToThinkingLevel(record.effort),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: record.cwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: activeSkillRoots,
    extensionFactories: [createPermissionExtension(record)],
    noThemes: true,
    skillsOverride: (base) => ({
      skills: base.skills.filter((s) => !disabledSkills.has(normalizeFsPath(s.filePath))),
      diagnostics: base.diagnostics,
    }),
    appendSystemPrompt: [
      '你是运行在 RocketX 桌面工作台中的内建 Super Agent（由 Pi 驱动）。需要访问统一工作看板（WorkCard）、隔离 Git Worktree 子会话、Rocket.Chat 消息或 Azure DevOps 时，优先调用已注入的宿主工具与 Skills。',
    ],
  });
  await resourceLoader.reload();

  const toolModifiers = process.platform === 'win32'
    ? ['+powershell', '+grep', '+find', '+ls']
    : ['+grep', '+find', '+ls'];

  const { session } = await createAgentSession({
    cwd: record.cwd,
    agentDir,
    modelRuntime: runtimeBundle.modelRuntime,
    model: selectedModel,
    thinkingLevel: mapEffortToThinkingLevel(record.effort),
    tools: toolModifiers,
    customTools: buildDynamicToolDefinitions(record),
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  record.agentSession = session;
  return session;
}

function parseUserInputs(inputs) {
  const textParts = [];
  const images = [];
  for (const item of Array.isArray(inputs) ? inputs : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text);
    } else if (item.type === 'skill' && typeof item.path === 'string') {
      textParts.push(`请参考并使用技能文件：${item.path}`);
    } else if (item.type === 'mention' && typeof item.path === 'string') {
      textParts.push(`@${item.path}`);
    } else if (item.type === 'image' && typeof item.url === 'string') {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(item.url);
      if (match) {
        images.push({ type: 'image', mimeType: match[1], data: match[2] });
      }
    } else if (item.type === 'localImage' && typeof item.path === 'string') {
      try {
        const bytes = fs.readFileSync(item.path);
        const ext = path.extname(item.path).toLowerCase();
        const mimeType = ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'image/jpeg';
        images.push({ type: 'image', mimeType, data: bytes.toString('base64') });
      } catch {
        textParts.push(`[图片文件读取失败: ${item.path}]`);
      }
    }
  }
  return {
    promptText: textParts.join('\n\n').trim() || (images.length > 0 ? '请分析附带的图片。' : ''),
    images,
  };
}

async function runPiTurn(record, turnId, promptText, images, startedAt) {
  const session = await ensureAgentSession(record);
  const msgItemId = `msg-${crypto.randomUUID()}`;
  const reasoningItemId = `reason-${crypto.randomUUID()}`;
  let streamedAssistantText = '';
  let streamedThinkingText = '';
  let reasoningStarted = false;
  let reasoningCompleted = false;
  let turnErrorMessage = null;
  const toolOutputs = new Map();
  const activeToolCalls = new Map();

  const completeReasoningBlock = () => {
    if (reasoningStarted && !reasoningCompleted) {
      reasoningCompleted = true;
      sendNotification('item/completed', {
        threadId: record.id,
        turnId,
        item: {
          type: 'reasoning',
          id: reasoningItemId,
          summary: [],
          content: [streamedThinkingText],
        },
      });
    }
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update') {
      const sub = event.assistantMessageEvent;
      if (!sub) return;
      if (sub.type === 'thinking_delta' && typeof sub.delta === 'string' && sub.delta) {
        if (!reasoningStarted) {
          reasoningStarted = true;
          sendNotification('item/started', {
            threadId: record.id,
            turnId,
            item: {
              type: 'reasoning',
              id: reasoningItemId,
              summary: [],
              content: [],
            },
          });
        }
        streamedThinkingText += sub.delta;
        sendNotification('item/reasoning/textDelta', {
          threadId: record.id,
          turnId,
          itemId: reasoningItemId,
          contentIndex: 0,
          delta: sub.delta,
        });
      } else if (sub.type === 'text_delta' && typeof sub.delta === 'string' && sub.delta) {
        completeReasoningBlock();
        streamedAssistantText += sub.delta;
        sendNotification('item/agentMessage/delta', {
          threadId: record.id,
          turnId,
          itemId: msgItemId,
          delta: sub.delta,
        });
      } else if (sub.type === 'error') {
        completeReasoningBlock();
        turnErrorMessage = sub.error?.errorMessage || '模型流式响应出错';
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      completeReasoningBlock();
      const { toolCallId, toolName, args } = event;
      activeToolCalls.set(toolCallId, { toolName, args: args ?? {}, startTime: Date.now() });
      if (toolName === 'bash' || toolName === 'powershell') {
        toolOutputs.set(toolCallId, '');
        sendNotification('item/started', {
          threadId: record.id,
          turnId,
          item: {
            type: 'commandExecution',
            id: toolCallId,
            command: typeof args?.command === 'string' ? args.command : JSON.stringify(args ?? {}),
            cwd: record.cwd,
            processId: null,
            source: 'agent',
            status: 'inProgress',
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        });
      } else if (toolName === 'write' || toolName === 'edit') {
        sendNotification('item/started', {
          threadId: record.id,
          turnId,
          item: {
            type: 'fileChange',
            id: toolCallId,
            changes: [
              {
                path: typeof args?.path === 'string' ? args.path : 'file',
                kind: toolName === 'write' ? { type: 'add' } : { type: 'update', move_path: null },
                diff: '',
              },
            ],
            status: 'inProgress',
          },
        });
      } else {
        sendNotification('item/started', {
          threadId: record.id,
          turnId,
          item: {
            type: 'dynamicToolCall',
            id: toolCallId,
            tool: toolName,
            namespace: toolName.includes('_') ? toolName.split('_')[0] : null,
            arguments: args ?? {},
            status: 'inProgress',
            contentItems: null,
            success: null,
            durationMs: null,
          },
        });
      }
      return;
    }

    if (event.type === 'tool_execution_update') {
      const { toolCallId, toolName, partialResult } = event;
      if (toolName === 'bash' || toolName === 'powershell') {
        const fullText = extractTextFromContent(partialResult?.content);
        const prev = toolOutputs.get(toolCallId) || '';
        const delta = fullText.startsWith(prev) ? fullText.slice(prev.length) : fullText;
        toolOutputs.set(toolCallId, fullText);
        if (delta) {
          sendNotification('item/commandExecution/outputDelta', {
            threadId: record.id,
            turnId,
            itemId: toolCallId,
            delta,
          });
        }
      }
      return;
    }

    if (event.type === 'tool_execution_end') {
      const { toolCallId, toolName, result, isError, durationMs } = event;
      const stored = activeToolCalls.get(toolCallId);
      const elapsed = typeof durationMs === 'number'
        ? Math.round(durationMs)
        : stored?.startTime ? Math.max(0, Date.now() - stored.startTime) : null;
      const outputText = extractTextFromContent(result?.content);

      if (toolName === 'bash' || toolName === 'powershell') {
        const commandText = typeof stored?.args?.command === 'string' ? stored.args.command : toolName;
        const completedItem = {
          type: 'commandExecution',
          id: toolCallId,
          command: commandText,
          cwd: record.cwd,
          processId: null,
          source: 'agent',
          status: isError ? 'failed' : 'completed',
          commandActions: [],
          aggregatedOutput: outputText || toolOutputs.get(toolCallId) || null,
          exitCode: isError ? 1 : 0,
          durationMs: elapsed,
        };
        if (stored) stored.completedItem = completedItem;
        sendNotification('item/completed', {
          threadId: record.id,
          turnId,
          item: completedItem,
        });
      } else if (toolName === 'write' || toolName === 'edit') {
        const filePath = typeof stored?.args?.path === 'string' ? stored.args.path : 'file';
        const fileDiff = typeof result?.details?.diff === 'string' ? result.details.diff : '';
        const changes = [
          {
            path: filePath,
            kind: toolName === 'write' ? { type: 'add' } : { type: 'update', move_path: null },
            diff: fileDiff,
          },
        ];
        if (fileDiff) {
          sendNotification('item/fileChange/patchUpdated', {
            threadId: record.id,
            turnId,
            itemId: toolCallId,
            changes,
          });
        }
        const completedItem = {
          type: 'fileChange',
          id: toolCallId,
          changes,
          status: isError ? 'failed' : 'completed',
        };
        if (stored) stored.completedItem = completedItem;
        sendNotification('item/completed', {
          threadId: record.id,
          turnId,
          item: completedItem,
        });
      } else {
        const completedItem = {
          type: 'dynamicToolCall',
          id: toolCallId,
          tool: toolName,
          namespace: toolName.includes('_') ? toolName.split('_')[0] : null,
          arguments: stored?.args ?? {},
          status: isError ? 'failed' : 'completed',
          contentItems: outputText ? [{ type: 'inputText', text: outputText }] : [],
          success: !isError,
          durationMs: elapsed,
        };
        if (stored) stored.completedItem = completedItem;
        sendNotification('item/completed', {
          threadId: record.id,
          turnId,
          item: completedItem,
        });
      }
    }
  });

  let finalStatus = 'completed';
  try {
    await session.prompt(promptText, {
      ...(images.length > 0 ? { images } : {}),
      source: 'rpc',
    });
    const lastAssistant = [...(session.messages || [])].reverse().find((m) => m?.role === 'assistant');
    if (record.abortRequested || lastAssistant?.stopReason === 'aborted') {
      finalStatus = 'interrupted';
    } else if (lastAssistant?.stopReason === 'error' || lastAssistant?.errorMessage) {
      finalStatus = 'failed';
      turnErrorMessage = lastAssistant.errorMessage || turnErrorMessage || '模型请求失败';
    }
  } catch (err) {
    if (record.abortRequested) {
      finalStatus = 'interrupted';
    } else {
      finalStatus = 'failed';
      const rawMessage = err instanceof Error ? err.message : String(err);
      if (/ECONNREFUSED.*11434|fetch failed.*11434/i.test(rawMessage)) {
        turnErrorMessage = `无法连接本地 Ollama 服务（${readPiUserConfig().baseUrl}）。请确认 Ollama 已启动（运行 ollama serve）且模型可用。`;
      } else if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(rawMessage) && readPiUserConfig().provider === 'custom-openai') {
        turnErrorMessage = `无法连接企业自定义 OpenAI 网关（${readPiUserConfig().baseUrl}）。请检查内网网关服务与网络连通性。`;
      } else {
        turnErrorMessage = rawMessage;
      }
    }
  } finally {
    unsubscribe();
    completeReasoningBlock();
    record.activeTurnId = null;
    record.abortRequested = false;
    record.sessionFile = record.sessionManager?.getSessionFile() || record.sessionFile;
    record.updatedAt = Math.floor(Date.now() / 1000);
    persistThreadMetadata(record);

    const completedAt = Math.floor(Date.now() / 1000);
    const turnItems = [];

    if (streamedThinkingText.trim()) {
      turnItems.push({
        type: 'reasoning',
        id: reasoningItemId,
        summary: [],
        content: [streamedThinkingText],
      });
    }

    for (const stored of activeToolCalls.values()) {
      if (stored.completedItem) {
        turnItems.push(stored.completedItem);
      }
    }

    if (streamedAssistantText.trim()) {
      const agentMsgItem = {
        type: 'agentMessage',
        id: msgItemId,
        text: streamedAssistantText,
        phase: 'final_answer',
        memoryCitation: null,
      };
      turnItems.push(agentMsgItem);
      sendNotification('item/completed', {
        threadId: record.id,
        turnId,
        item: agentMsgItem,
      });
    }

    sendNotification('turn/completed', {
      threadId: record.id,
      turn: {
        id: turnId,
        items: turnItems,
        itemsView: 'full',
        status: finalStatus,
        error: finalStatus === 'failed'
          ? {
            message: turnErrorMessage || 'Pi 执行失败',
            codexErrorInfo: 'other',
            additionalDetails: null,
          }
          : null,
        startedAt,
        completedAt,
        durationMs: Math.max(0, (completedAt - startedAt) * 1000),
      },
    });
  }
}

async function handleRpcRequest(method, params = {}) {
  switch (method) {
    case 'initialize':
      return { userAgent: `rocketx/${PI_VERSION}` };

    case 'skills/extraRoots/set': {
      extraSkillRoots = Array.isArray(params.extraRoots)
        ? params.extraRoots.filter((item) => typeof item === 'string' && item.trim())
        : [];
      return {};
    }

    case 'skills/list':
      return { data: listSkillsForCwds(params.cwds) };

    case 'skills/config/write': {
      const disabled = loadDisabledSkills();
      const norm = normalizeFsPath(params.path);
      const enabled = Boolean(params.enabled);
      if (norm) {
        if (enabled) disabled.delete(norm);
        else disabled.add(norm);
        saveDisabledSkills(disabled);
      }
      return { effectiveEnabled: enabled };
    }

    case 'permissionProfile/list':
      return {
        data: [
          {
            id: ':workspace',
            name: '工作区沙箱',
            description: '默认允许当前工作区内读写，敏感操作按策略审批',
            allowed: true,
          },
          {
            id: ':danger-full-access',
            name: '完全访问权限',
            description: '允许访问工作区外路径与系统命令',
            allowed: true,
          },
        ],
      };

    case 'model/list':
      return {
        data: await listRocketxModels(),
        nextCursor: null,
      };

    case 'app/list':
      return { data: [], nextCursor: null };

    case 'plugin/list':
      return {
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      };

    case 'thread/list': {
      const cwds = Array.isArray(params.cwd)
        ? params.cwd
        : typeof params.cwd === 'string' && params.cwd.trim()
          ? [params.cwd]
          : [];
      const data = await hydrateStoredThreadsForCwds(cwds);
      return { data, nextCursor: null };
    }

    case 'thread/start': {
      const cwd = typeof params.cwd === 'string' && params.cwd.trim()
        ? path.resolve(params.cwd)
        : cliOptions.workspaceRoot;
      fs.mkdirSync(cwd, { recursive: true });
      const sessionManager = SessionManager.create(cwd, sessionsRootDir);
      const id = sessionManager.getSessionId();
      const nowSec = Math.floor(Date.now() / 1000);
      const record = {
        id,
        cwd,
        runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
          ? params.runtimeWorkspaceRoots
          : [cwd],
        name: null,
        preview: '新对话',
        sessionFile: sessionManager.getSessionFile() || null,
        sessionManager,
        agentSession: null,
        dynamicTools: Array.isArray(params.dynamicTools) ? params.dynamicTools : [],
        permissions: params.permissions || ':workspace',
        approvalPolicy: params.approvalPolicy || 'on-request',
        approvalsReviewer: params.approvalsReviewer || 'guardian_subagent',
        sessionApprovedTools: new Set(),
        model: params.model || '',
        effort: 'medium',
        modelProvider: readPiUserConfig().provider,
        forkedFromId: null,
        createdAt: nowSec,
        updatedAt: nowSec,
        archived: false,
        activeTurnId: null,
      };
      threadRecords.set(id, record);
      persistThreadMetadata(record);
      const thread = buildRocketxThreadObject(record, false);
      sendNotification('thread/started', { thread });
      return { thread };
    }

    case 'thread/resume': {
      const threadId = String(params.threadId || '');
      if (!threadRecords.has(threadId)) {
        await hydrateStoredThreadsForCwds([]);
      }
      const record = threadRecords.get(threadId);
      if (!record) throw new Error(`找不到 Pi 会话：${threadId}`);
      if (typeof params.cwd === 'string' && params.cwd.trim()) {
        record.cwd = path.resolve(params.cwd);
      }
      if (params.model) record.model = params.model;
      if (params.permissions) record.permissions = params.permissions;
      if (params.approvalPolicy) record.approvalPolicy = params.approvalPolicy;
      if (params.approvalsReviewer) record.approvalsReviewer = params.approvalsReviewer;
      ensureSessionManager(record);
      return { thread: buildRocketxThreadObject(record, !params.excludeTurns) };
    }

    case 'thread/fork': {
      const sourceId = String(params.threadId || '');
      if (!threadRecords.has(sourceId)) {
        await hydrateStoredThreadsForCwds([]);
      }
      const source = threadRecords.get(sourceId);
      if (!source) throw new Error(`找不到要分支的 Pi 会话：${sourceId}`);
      const targetCwd = typeof params.cwd === 'string' && params.cwd.trim()
        ? path.resolve(params.cwd)
        : source.cwd;
      fs.mkdirSync(targetCwd, { recursive: true });
      const sourceFile = source.sessionManager?.getSessionFile() || source.sessionFile;
      const forkedManager = sourceFile && fs.existsSync(sourceFile)
        ? SessionManager.forkFrom(sourceFile, targetCwd, sessionsRootDir)
        : SessionManager.create(targetCwd, sessionsRootDir);
      const id = forkedManager.getSessionId();
      const nowSec = Math.floor(Date.now() / 1000);
      const record = {
        ...source,
        id,
        cwd: targetCwd,
        sessionFile: forkedManager.getSessionFile() || null,
        sessionManager: forkedManager,
        agentSession: null,
        sessionApprovedTools: new Set(),
        forkedFromId: sourceId,
        createdAt: nowSec,
        updatedAt: nowSec,
        activeTurnId: null,
      };
      threadRecords.set(id, record);
      persistThreadMetadata(record);
      return { thread: buildRocketxThreadObject(record, !params.excludeTurns) };
    }

    case 'thread/read': {
      const threadId = String(params.threadId || '');
      if (!threadRecords.has(threadId)) {
        await hydrateStoredThreadsForCwds([]);
      }
      const record = threadRecords.get(threadId);
      if (!record) throw new Error(`找不到 Pi 会话：${threadId}`);
      ensureSessionManager(record);
      return { thread: buildRocketxThreadObject(record, Boolean(params.includeTurns)) };
    }

    case 'thread/turns/list': {
      const threadId = String(params.threadId || '');
      const record = threadRecords.get(threadId);
      if (!record) return { data: [], nextCursor: null };
      const sm = ensureSessionManager(record);
      const data = projectSessionEntriesToTurns(
        sm,
        new Set((record.dynamicTools || []).map((t) => t.name)),
      );
      return { data, nextCursor: null };
    }

    case 'thread/name/set': {
      const threadId = String(params.threadId || '');
      const name = String(params.name || '').trim();
      const record = threadRecords.get(threadId);
      if (record && name) {
        record.name = name;
        record.updatedAt = Math.floor(Date.now() / 1000);
        try {
          ensureSessionManager(record).appendSessionInfo(name);
        } catch {
          // Ignore if session file not flushed yet.
        }
        persistThreadMetadata(record);
      }
      return {};
    }

    case 'thread/archive': {
      const threadId = String(params.threadId || '');
      const record = threadRecords.get(threadId);
      if (record) {
        record.archived = true;
        record.agentSession?.dispose?.();
        record.agentSession = null;
        persistThreadMetadata(record);
      } else {
        const index = loadThreadIndex();
        if (index.threads[threadId]) {
          index.threads[threadId].archived = true;
          saveThreadIndex(index);
        }
      }
      return {};
    }

    case 'thread/memoryMode/set':
    case 'thread/unsubscribe':
      return {};

    case 'thread/settings/update': {
      const record = threadRecords.get(String(params.threadId || ''));
      if (record) {
        if (params.model) record.model = params.model;
        if (params.effort !== undefined) record.effort = params.effort;
        if (params.permissions) record.permissions = params.permissions;
        if (params.approvalPolicy) record.approvalPolicy = params.approvalPolicy;
        if (params.approvalsReviewer) record.approvalsReviewer = params.approvalsReviewer;
      }
      return {};
    }

    case 'turn/start': {
      const threadId = String(params.threadId || '');
      const record = threadRecords.get(threadId);
      if (!record) throw new Error(`找不到 Pi 会话：${threadId}`);
      if (params.model) record.model = params.model;
      if (params.effort !== undefined) record.effort = params.effort;
      if (params.permissions) record.permissions = params.permissions;
      if (params.approvalPolicy) record.approvalPolicy = params.approvalPolicy;
      if (params.approvalsReviewer) record.approvalsReviewer = params.approvalsReviewer;
      if (Array.isArray(params.runtimeWorkspaceRoots) && params.runtimeWorkspaceRoots.length > 0) {
        record.runtimeWorkspaceRoots = params.runtimeWorkspaceRoots;
      }

      const { promptText, images } = parseUserInputs(params.input);
      if (!promptText && images.length === 0) {
        throw new Error('输入内容不能为空');
      }
      if (!record.preview || record.preview === '新对话') {
        record.preview = promptText.slice(0, 120);
      }

      const turnId = `turn-${crypto.randomUUID()}`;
      const startedAt = Math.floor(Date.now() / 1000);
      record.activeTurnId = turnId;
      record.abortRequested = false;
      record.updatedAt = startedAt;
      persistThreadMetadata(record);

      const turn = {
        id: turnId,
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt,
        completedAt: null,
        durationMs: null,
      };
      sendNotification('turn/started', { threadId, turn });

      void runPiTurn(record, turnId, promptText, images, startedAt);
      return { turn };
    }

    case 'turn/steer': {
      const threadId = String(params.threadId || '');
      const record = threadRecords.get(threadId);
      if (!record || !record.agentSession) {
        throw new Error('当前没有运行中的 Pi 任务可引导');
      }
      const { promptText, images } = parseUserInputs(params.input);
      await record.agentSession.steer(promptText, images.length > 0 ? images : undefined, { source: 'rpc' });
      return { turnId: record.activeTurnId || params.expectedTurnId || '' };
    }

    case 'turn/interrupt': {
      const threadId = String(params.threadId || '');
      const record = threadRecords.get(threadId);
      if (record) {
        record.abortRequested = true;
        for (const [id, waiter] of pendingServerRequests.entries()) {
          if (waiter.threadId === threadId) {
            pendingServerRequests.delete(id);
            waiter.reject(new Error('用户中断了当前 Pi 任务'));
          }
        }
        if (record.agentSession) {
          try {
            await record.agentSession.abort();
          } catch {
            // Ignore abort error if already stopped
          }
        }
      }
      return {};
    }

    default:
      throw new Error(`Pi App-Server 暂不支持方法：${method}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (rawLine) => {
  const line = rawLine.trim();
  if (!line) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (!frame || typeof frame !== 'object') return;

  // Client response to a server-initiated request (e.g. dynamic tool call or approval)
  if ('id' in frame && !('method' in frame)) {
    const waiter = pendingServerRequests.get(String(frame.id));
    if (!waiter) return;
    pendingServerRequests.delete(String(frame.id));
    if (frame.error) {
      waiter.reject(new Error(frame.error.message || 'Client RPC error'));
    } else {
      waiter.resolve(frame.result);
    }
    return;
  }

  // Client-initiated notification (no id)
  if (!('id' in frame)) return;

  const requestId = frame.id;
  void handleRpcRequest(frame.method, frame.params || {}).then(
    (result) => {
      writeFrame({ id: requestId, result });
    },
    (err) => {
      writeFrame({
        id: requestId,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    },
  );
});

rl.on('close', () => {
  for (const [, waiter] of pendingServerRequests) {
    waiter.reject(new Error('Pi App-Server stdin closed'));
  }
  pendingServerRequests.clear();
  process.exit(0);
});
