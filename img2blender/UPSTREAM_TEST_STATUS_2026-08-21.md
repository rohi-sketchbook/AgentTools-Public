# img2threejs upstream test status - 2026-08-21

Checkout:

- Commit: `d6673386f89673a58736f8d398dd16ece67874f5`
- Upstream SKILL version: `1.4.4`
- Platform: Windows

## Compile

`python -m compileall -q forge`: PASS

## UTF-8 normalized test run

Run with the same environment used by `run_upstream_tests.cmd`:

```text
PYTHONUTF8=1
PYTHONIOENCODING=utf-8
python -B -m unittest discover -s forge/tests -v
```

Result:

- Total: 673 tests
- Failures: 0
- Errors: 3
- Skipped: 25

### Windows platform-specific errors

All three errors require symlink creation and fail on this Windows environment with WinError 1314 (the process does not currently have symlink creation privilege):

- `test_symlink_source_file_is_rejected_without_indexing_target`
- `test_symlink_source_root_is_rejected_without_indexing_target`
- `test_symlinked_cache_parent_returns_structured_cache_failure`

These are environment/platform errors rather than observed reconstruction-pipeline regressions.

## Change from the 2026-07-26 baseline

The previous upstream checkout had three additional gate/test expectation mismatches around review/pass credit. Those mismatches are no longer present at `d6673386f89673a58736f8d398dd16ece67874f5`.

The current upstream line also adds substantial new character, material, camera-fitting, geometry-reconstruction, rigging, and deterministic-review coverage, so the test count is significantly larger than the previous baseline.

## Windows runner

Use `run_upstream_tests.cmd` from the AgentTool root. It forces UTF-8 mode before running compile + tests so cp932 console behavior does not obscure real failures.
