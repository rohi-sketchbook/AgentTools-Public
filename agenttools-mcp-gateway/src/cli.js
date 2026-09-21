#!/usr/bin/env node
const { invoke, listTools } = require('./tools');
const { parseOptions } = require('./core/options');

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  return {
    ok: true,
    usage: [
      'node src/cli.js status',
      'node src/cli.js status paths',
      'node src/cli.js gateway health',
      'node src/cli.js workflow review',
      'node src/cli.js workflow review --mode codex',
      'node src/cli.js workflow review --mode chatgpt',
      'node src/cli.js workflow continuation',
      'node src/cli.js workflow continuation --mode codex',
      'node src/cli.js workflow continuation --mode chatgpt',
      'node src/cli.js workflow continuation --mode off',
      'node src/cli.js skill list --mode active',
      'node src/cli.js skill get --id skillimp_...',
      'node src/cli.js skill usage --limit 100',
      'node src/cli.js skill curate --staleDays 90',
      'node src/cli.js skill propose --skillPath D:/projects/AgentTools/example/skill/SKILL.md --reason "再利用可能な手順を反映" --proposedContentFile D:/projects/AgentTools/tmp/proposed-skill.md',
      'node src/cli.js skill approve --id skillimp_... --approvedBy user',
      'node src/cli.js skill reject --id skillimp_... --rejectedBy user --note "不要"',
      'node src/cli.js skill apply --id skillimp_... --userExplicitlyRequested true',
      'node src/cli.js history search --query "水面" --kind work_task',
      'node src/cli.js history sync',
      'node src/cli.js history status',
      'node src/cli.js hostRequest list --status pending',
      'node src/cli.js hostRequest enqueueDetailedInspection --taskId task_...',
      'node src/cli.js hostRequest enqueueContinue --taskId task_...',
      'node src/cli.js hostRequest claim',
      'node src/cli.js hostRequest complete --id hostreq_...',
      'node src/cli.js hostRequest fail --id hostreq_... --error "調査失敗"',
      'node src/cli.js hostRequest get --id hostreq_... --includeReport true',
      'node src/cli.js devspace health',
      'node src/cli.js devspace diagnose',
      'node src/cli.js devspace logs --lines 100 --errorOnly',
      'node src/cli.js devspace recover',
      'node src/cli.js watchdog status',
      'node src/cli.js watchdog history --limit 20',
      'node src/cli.js task start --title "UI修正" --actor chatgpt --actorLabel ChatGPT --model "GPT-5.6 Sol"',
      'node src/cli.js task update --id task_... --actor codex --actorLabel Codex --model Terra --phase "実装" --message "設定UIを修正中" --takeOwnership true',
      'node src/cli.js task checkpoint --id task_... --actor chatgpt --lastCompletedStep "実装完了" --nextStep "ローカル検証" --workspacePath D:/projects/AgentTools --nextActionImpact local_validation',
      'node src/cli.js task timeout --id task_... --actor chatgpt --timeoutKind chatgpt_execution --elapsedMs 1800000 --nextStep "ローカル検証" --nextActionImpact local_validation',
      'node src/cli.js task resumable --limit 20',
      'node src/cli.js task resume --id task_... --actor chatgpt --force true --phase "再開" --message "確認済みの作業を再開"',
      'node src/cli.js task goal --id task_... --actor chatgpt --goalOutcome "全テストを通して完了" --goalCriteria "対象テスト成功" --goalVerification "npm test成功" --goalEnforce true',
      'node src/cli.js task judge --id task_... --actor chatgpt --goalResult satisfied --summary "完了条件を確認" --evidence "npm test passed"',
      'node src/cli.js task heartbeat --id task_... --actor codex --actorLabel Codex --model Luna --progressMade true --progressSignature "tests-passed"',
      'node src/cli.js task reconcile --id task_...',
      'node src/cli.js task snapshot --id task_... --paths src/file.js --label "before refactor"',
      'node src/cli.js task snapshots --id task_...',
      'node src/cli.js task snapshotRestore --id task_... --snapshotId snap_... --userExplicitlyRequested true',
      'node src/cli.js task recover --id task_... --actor codex --actorLabel Codex --model Luna --message "checkpointから再開"',
      'node src/cli.js task inspect --id task_...',
      'node src/cli.js task resumePrompt --id task_...',
      'node src/cli.js task continueRequest --id task_... --actor control-center --actorLabel "Control Center" --manualModelRole implementation',
      'node src/cli.js task skillCandidate --id task_... --actor chatgpt --skillPath D:/profiles/user/.agents/skills/example/SKILL.md --reason "再発防止手順を追加" --proposedContentFile D:/projects/AgentTools/tmp/proposed-skill.md',
      'node src/cli.js task finishForgottenTask --id task_... --actor control-center --actorLabel "Control Center" --expectedUpdatedAt 2026-09-08T00:00:00.000Z --userExplicitlyRequested true',
      'node src/cli.js task complete --id task_... --actor chatgpt --actorLabel ChatGPT --summary "実装・検証完了" --changedFiles file.cs --tests "build ok"',
      'node src/cli.js task list --work true --mode active',
      'node src/cli.js uiqa status',
      'node src/cli.js uiqa issues --status open',
      'node src/cli.js uiqa runOnce',
      'node src/cli.js uiqa resolve --key settings-text-clipping --note "修正済み"',
      'node src/cli.js fs list --path D:/projects/AgentTools',
      'node src/cli.js process status',
      'node src/cli.js process find --query devspace',
      'node src/cli.js git status --repo D:/projects/example-unity-project',
      'node src/cli.js git log --repo D:/projects/example-unity-project --limit 10',
      'node src/cli.js git diff --repo D:/projects/example-unity-project',
      'node src/cli.js git diffSummary --repo D:/projects/example-unity-project',
      'node src/cli.js git commit --repo D:/projects/example-unity-project --all --message "message"',
      'node src/cli.js discord status',
      'node src/cli.js discord post --message "dry-run message"',
      'node src/cli.js task list',
      'node src/cli.js task create --type demo --title "demo task"',
      'node src/cli.js blender status',
      'node src/cli.js blender render --blend D:/projects/assets/example.blend --frame 1',
      'node src/cli.js localAi status',
      'node src/cli.js localAi workflows',
      'node src/cli.js localAi models --folder checkpoints',
      'node src/cli.js localAi start',
      'node src/cli.js localAi generate --workflow image-basic --prompt "prompt"',
      'node src/cli.js video status',
      'node src/cli.js video remotionRender --composition Devlog20260725',
      'node src/cli.js video hyperframesRender --project D:/projects/AgentTools/hyperframes/example',
      'node src/cli.js unity status --project D:/projects/example-unity-project',
      'node src/cli.js unity batchMode --method Namespace.Type.Method',
      'node src/cli.js image list --limit 10',
      'node src/cli.js windowsUi windows --process Unity.exe',
      'node src/cli.js windowsUi tree --process Unity.exe --window "Scene(s) Have Been Modified" --depth 6',
      'node src/cli.js windowsUi find --process Unity.exe --window "Scene(s) Have Been Modified" --controlType Button --name Save',
      'node src/cli.js windowsUi invoke --process Unity.exe --window "Scene(s) Have Been Modified" --controlType Button --name Save',
      'node src/cli.js paths check --path D:/projects/AgentTools',
      'node src/cli.js tools',
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printJson(help());
    return;
  }

  if (args[0] === 'tools') {
    printJson({ ok: true, tools: listTools() });
    return;
  }

  const domain = args[0];
  let action = args[1];
  let rest = args.slice(2);

  if (domain === 'status' && (!action || action.startsWith('--'))) {
    action = 'summary';
    rest = args.slice(1);
  }

  if (!action || action.startsWith('--')) {
    action = 'status';
    rest = args.slice(1);
  }

  const { options } = parseOptions(rest);
  const result = await invoke(domain, action, options);
  printJson(result);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  printJson({ ok: false, error: error.message, stack: process.env.AGENTTOOLS_GATEWAY_DEBUG === '1' ? error.stack : undefined });
  process.exitCode = 1;
});
