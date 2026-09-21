const { loadConfig } = require('../config');

function endpointUrl(pathname) {
  const config = loadConfig();
  return new URL(pathname, config.comfyUiEndpoint.endsWith('/') ? config.comfyUiEndpoint : `${config.comfyUiEndpoint}/`);
}

async function request(pathname, options = {}) {
  const config = loadConfig();
  const timeoutMs = Number(options.timeoutMs || config.requestTimeoutMs || 1500);
  const startedAt = Date.now();
  try {
    const response = await fetch(endpointUrl(pathname), {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      data,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      data: null,
      error: error.message,
      errorName: error.name,
    };
  }
}

function summarizeQueue(data) {
  const running = Array.isArray(data?.queue_running) ? data.queue_running : [];
  const pending = Array.isArray(data?.queue_pending) ? data.queue_pending : [];
  return {
    running: running.length,
    pending: pending.length,
    runningPromptIds: running.map((entry) => Array.isArray(entry) ? entry[1] : null).filter(Boolean),
    pendingPromptIds: pending.map((entry) => Array.isArray(entry) ? entry[1] : null).filter(Boolean),
  };
}

function summarizeSystem(data) {
  const system = data?.system || {};
  const devices = Array.isArray(data?.devices) ? data.devices : [];
  return {
    comfyUiVersion: system.comfyui_version || null,
    pythonVersion: system.python_version || null,
    pytorchVersion: system.pytorch_version || null,
    os: system.os || null,
    ramTotal: system.ram_total ?? null,
    ramFree: system.ram_free ?? null,
    devices: devices.map((device) => ({
      name: device?.name || null,
      type: device?.type || null,
      index: device?.index ?? null,
      vramTotal: device?.vram_total ?? null,
      vramFree: device?.vram_free ?? null,
      torchVramTotal: device?.torch_vram_total ?? null,
      torchVramFree: device?.torch_vram_free ?? null,
    })),
  };
}

async function inspectComfyUi() {
  const config = loadConfig();
  const systemResult = await request('/system_stats');
  if (!systemResult.ok) {
    return {
      endpoint: config.comfyUiEndpoint,
      online: false,
      responseMs: systemResult.elapsedMs,
      error: systemResult.error,
      system: null,
      queue: { running: 0, pending: 0, runningPromptIds: [], pendingPromptIds: [] },
    };
  }

  const queueResult = await request('/queue');
  return {
    endpoint: config.comfyUiEndpoint,
    online: true,
    responseMs: systemResult.elapsedMs,
    error: queueResult.ok ? null : queueResult.error,
    system: summarizeSystem(systemResult.data),
    queue: queueResult.ok
      ? summarizeQueue(queueResult.data)
      : { running: 0, pending: 0, runningPromptIds: [], pendingPromptIds: [] },
  };
}

async function listModels(folder) {
  const requested = String(folder || '').trim();
  if (!requested) return { ok: false, error: 'folder is required' };
  if (!/^[A-Za-z0-9_.-]+$/.test(requested)) return { ok: false, error: 'invalid model folder name' };
  const result = await request(`/models/${encodeURIComponent(requested)}`, { timeoutMs: 5000 });
  if (!result.ok) {
    return { ok: false, folder: requested, error: result.error, offline: result.status == null };
  }
  const models = Array.isArray(result.data) ? result.data.map(String) : [];
  return { ok: true, folder: requested, count: models.length, models };
}

async function getHistory(promptId, timeoutMs) {
  return request(`/history/${encodeURIComponent(promptId)}`, { timeoutMs });
}

async function postJson(pathname, body, timeoutMs) {
  return request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

async function interrupt() {
  return postJson('/interrupt', {}, 5000);
}

async function freeMemory({ unloadModels = true, freeMemory = true } = {}) {
  return postJson('/free', { unload_models: Boolean(unloadModels), free_memory: Boolean(freeMemory) }, 5000);
}

module.exports = {
  endpointUrl,
  request,
  postJson,
  inspectComfyUi,
  listModels,
  getHistory,
  interrupt,
  freeMemory,
  summarizeQueue,
  summarizeSystem,
};
