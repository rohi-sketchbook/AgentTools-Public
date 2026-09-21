# 2026-08-21 Discord Bot / Codex同期 高負荷インシデント

## 概要

Discord BotのCodex transcript realtime同期が、約1秒ごとにCodex session群を再探索し、対象JSONLを繰り返し解析していた。Codex履歴の増加に伴って処理量が増大し、2026-08-21の調査時には常駐Nodeプロセスが1コア換算約78%、Working Set約703MB、論理Read約73.6MB/sを消費していた。

## 影響

- 常駐CPU占有
- ファイルI/O帯域消費
- メモリ占有
- PC全体の発熱・電力・応答性への悪影響
- Windows ReadTransferCount上では約14.3TB相当の累積Readを確認

プロセス自身の累積Writeは約17MBであり、本件は大量書込事故ではない。Windows Storage Healthは対象SSDをHealthy / OKと判定した。

## 発生期間

- 1秒realtime同期の設計は、Git履歴上少なくとも2026-07-28 08:30 JSTの初回AgentTools管理コミット時点で存在した。
- 調査対象となった高負荷Botプロセスは2026-08-19 09:42 JSTから2026-08-21 00:39 JST頃まで稼働していた。
- Codex sessionデータ量の増加に伴って徐々に顕在化したと判断する。

## 根本原因

1. 高頻度timerへデータ量比例のsession discoveryを載せた。
2. `includeSessionIds` を指定対象限定の意図で利用したが、APIは「対象を追加で含める」意味であり、全session探索を抑制しなかった。
3. transcript取得時にJSONL全文読込・全文parseを繰り返した。
4. idle performance budgetとscale testがなかった。
5. 常駐プロセスのCPU/I/O継続超過を検出する監視がなかった。

## 修正

- `onlySessionIds` 経路を追加し、Discordにリンクされたsessionだけを取得。
- session file pathをcache。
- `size / mtime`で変更有無を判定。
- append-only JSONLをbyte offsetベースで増分読込。
- 未変更時はtranscript同期処理をskip。
- parser testを追加。

修正後実測:

- CPU: 約78.4%/1core → 約1.1%/1core
- Read: 約73.6MB/s → 0MB/s
- Working Set: 約703MB → 約103MB

## 恒久対策

- `docs/background-performance-policy.md` を共通ルールとする。
- 高頻度timer + I/Oを検出するstatic auditをCI/checkへ追加。
- DevSpace supervisorは200ms監視を廃止し、固定1ファイルだけを確認する1秒O(1)監視へ低減。ChatGPT Outbox Pumpは`fs.watch`主体＋低頻度fallbackへ変更。
- DevSpace WatchdogへAgentTools resource budget監視を追加。
- UnityではPlayerへ常時監視を入れず、Editor/デバッグ時に専用診断を実行する。

## 再発判定

同種インシデントとは、常駐・バックグラウンド処理が入力データ量の増加によってidle時CPU/I/Oを継続消費し、利用者操作なしでも負荷が増大する状態を指す。言語・実装方式は問わない。
