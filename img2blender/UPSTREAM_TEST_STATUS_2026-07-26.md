# img2threejs upstream test status - 2026-07-26

Checkout:

- Commit: `ffe0ace9cfcb8686fd8473371ccbf0ffc2e906e0`
- Python: `3.12.10`
- Platform: Windows

## Compile

`python -m compileall -q forge`: PASS

## Raw Windows test run

With the default Windows console/code-page behavior, the suite reports many failures caused by cp932 encode/decode errors in tests and CLI output, plus Windows symlink privilege errors.

## UTF-8 normalized run

Run with:

```text
PYTHONUTF8=1
PYTHONIOENCODING=utf-8
python -B -m unittest discover -s forge/tests -q
```

Result:

- Total: 245 tests
- Successful: 239
- Failures: 2
- Errors: 4

### Platform-specific errors

Three errors require symlink creation and fail on this Windows environment with WinError 1314 (symlink privilege unavailable):

- `test_symlinked_cache_parent_returns_structured_cache_failure`
- `test_symlink_source_file_is_rejected_without_indexing_target`
- `test_symlink_source_root_is_rejected_without_indexing_target`

### Upstream gate/test drift

The remaining three outcomes appear to be upstream behavior/test-expectation drift around newly tightened pass gating:

- `test_append_review_persists_cs2_report_and_rejects_failed_report`
  - test tries to record `optimization-pass` while `blockout` is the current unlocked pass.
- `test_append_review_gate_and_record`
  - current implementation requires `--map-stripped-render` to credit `blockout`; the test still expects the older evidence contract.
- `test_orchestrator_refuses_current_pass_without_passing_tier1`
  - current orchestrator gate behavior and the test's expected transition no longer agree.

These are not patched in the upstream checkout. img2blender keeps its own gate implementation isolated under `tools/img2blender`.

## Windows runner

Use `run_upstream_tests.cmd` from the AgentTool root. It forces UTF-8 mode before running compile + tests so cp932 noise does not obscure real failures.
