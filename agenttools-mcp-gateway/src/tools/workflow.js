const {
  reviewPolicy,
  setReviewMode,
  continuationPolicy,
  setContinuationMode,
} = require('../core/workflowPolicy');

async function review(options = {}) {
  try {
    if (options.mode === undefined || options.mode === null || options.mode === '') return reviewPolicy();
    return setReviewMode(options.mode);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function continuation(options = {}) {
  try {
    if (options.mode === undefined || options.mode === null || options.mode === '') return continuationPolicy();
    return setContinuationMode(options.mode);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  review,
  continuation,
};
