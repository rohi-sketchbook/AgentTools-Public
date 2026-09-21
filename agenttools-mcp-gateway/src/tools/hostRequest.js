const store = require('../core/hostRequestStore');

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

async function list(options = {}) {
  try {
    return {
      ok: true,
      requests: store.listHostRequests({
        limit: Number(options.limit || 50),
        status: options.status || 'all',
        includeReport: truthy(options.includeReport),
      }),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function enqueueDetailedInspection(options = {}) {
  try {
    const result = store.enqueueDetailedTaskInspection({
      taskId: options.taskId || options.id,
      source: options.source || 'control-center',
      requestedBy: options.requestedBy || 'Control Center',
    });
    return {
      ok: true,
      duplicate: result.duplicate,
      request: result.request,
      message: result.duplicate
        ? '同じTaskの詳細確認依頼がすでに待機中または処理中です。'
        : '詳細状況確認をChatGPT Host Request Queueへ登録しました。',
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function enqueueContinue(options = {}) {
  try {
    const result = store.enqueueTaskContinuation({
      taskId: options.taskId || options.id,
      source: options.source || 'control-center',
      requestedBy: options.requestedBy || 'Control Center',
    });
    return {
      ok: true,
      duplicate: result.duplicate,
      request: result.request,
      message: result.duplicate
        ? '同じTaskの作業続行依頼がすでに待機中または処理中です。'
        : '作業続行をChatGPT Host Request Queueへ登録しました。',
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function claim(options = {}) {
  try {
    const request = store.claimHostRequest({ id: options.id || options.requestId || null });
    return request ? { ok: true, request } : { ok: true, request: null, message: 'Pending host request is empty.' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function complete(options = {}) {
  try {
    return { ok: true, request: store.completeHostRequest({ id: options.id || options.requestId }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function markFailed(options = {}) {
  try {
    return {
      ok: true,
      request: store.failHostRequest({
        id: options.id || options.requestId,
        error: options.error || options.message || 'Host request failed.',
      }),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function get(options = {}) {
  try {
    const request = store.getHostRequest({
      id: options.id || options.requestId,
      includeReport: options.includeReport === undefined ? true : truthy(options.includeReport),
    });
    if (!request) return { ok: false, error: 'Host request not found.' };
    return { ok: true, request };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  list,
  enqueueDetailedInspection,
  enqueueContinue,
  claim,
  complete,
  fail: markFailed,
  get,
};
