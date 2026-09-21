# Devlog Image Transfer Guard

VR Avatar Viewer 開発日記の4コマ画像を DevSpace `download_artifact` で受け取る前後に使うガード。

目的は、正式保存先をスクリプト側で1つに固定し、転送成功後の再転送や `*-final.png` / `ERROR.png` のような別名複製を防ぐこと。

## 正式保存先

日付と拡張子から次の1パスだけを生成する。

```text
docs/assets/images/devlog-YYYY-MM-DD-comic.<ext>
```

呼び出し側は `DESTINATION` をそのまま使用し、別名へ変更してはならない。

## prepare

```bat
Devlog-ImageTransferGuard.bat -Mode prepare -WorkspaceRoot "<WorkspaceRoot>\vr-avatar-viewer-site" -Date 2026-07-29 -Extension png
```

主な結果:

- `ACTION=TRANSFER_ALLOWED` / exit 0: `DESTINATION` へ1回だけ転送してよい。
- `ACTION=DO_NOT_TRANSFER` / exit 20: 正式画像が既に存在するため、`download_artifact` を呼んではならない。
- `ACTION=STOP`: 日付、Workspace、形式競合などに問題があるため停止する。

## verify

```bat
Devlog-ImageTransferGuard.bat -Mode verify -WorkspaceRoot "<WorkspaceRoot>\vr-avatar-viewer-site" -Date 2026-07-29 -Extension png
```

成功時:

```text
STATE=VERIFIED
ACTION=TRANSFER_COMPLETE
DESTINATION=docs/assets/images/devlog-2026-07-29-comic.png
BYTES=...
SHA256=...
WIDTH=...
HEIGHT=...
```

`ACTION=TRANSFER_COMPLETE` 後は、その日付の画像について `download_artifact` を再実行しない。

## 必須運用

1. `prepare` を実行する。
2. `TRANSFER_ALLOWED` の場合だけ、返された `DESTINATION` へ `download_artifact` を1回実行する。
3. 転送後は `verify` を実行する。
4. `TRANSFER_COMPLETE` になったら終了する。
5. `destination already exists` が発生しても別名を作らない。`prepare` / `verify` へ戻る。
