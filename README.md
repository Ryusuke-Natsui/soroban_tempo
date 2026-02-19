# テンポ見取算（同期チャレンジ）PWA v1

友人と同時に同じ問題を解くための、サーバ時刻同期付きテンポ見取算PWAです。

## 技術構成

- フロントエンド: Vanilla JS + CSS
- バックエンド: Node.js (`http`のみ、メモリ上ルーム管理)
- 同期通知: Server-Sent Events (SSE)
- PWA: `manifest.json` + Service Worker

## ローカル実行方法

```bash
node -v
npm -v
npm test
npm start
```

起動後 `http://localhost:3000` を開いてください。

## デプロイ方法（Node）

1. 任意のNode対応環境（Render/Fly.io/VPSなど）に配置
2. `npm start` で常駐
3. 80/443 から `server.js` のポート（`PORT` 環境変数）へリバースプロキシ

## 同期の仕組み

- `GET /api/time` でサーバ現在時刻 `serverNow` を取得。
- クライアントは往復遅延を考慮し、`offset = serverNow - localMidpoint` を複数回（5〜7回）採取して平均。
- ホストは `startAt` を **サーバ時刻基準**で決定して保存/配布。
- 参加者は `Date.now() + offset` を擬似サーバ時刻としてカウントダウンし、`startAt` 到達で自動開始。
- 開始直前にも再同期しズレを最小化。

## 動作確認手順（2端末）

1. 端末Aでルーム作成（設定とseedを指定）。
2. 共有リンクを端末Bで開いて参加。
3. 端末Aで「ビープ準備」（任意）→「開始を確定」。
4. 両端末で同じ口列が同時刻に始まることを確認。
5. 回答を送信し、結果一覧（名前/正誤/回答/送信時刻）が更新されることを確認。

## 補足

- 出題生成は決定論PRNG（mulberry32）を使用し、`seed + settings` が一致すれば口列は完全一致。
- `allowNegative=false` のとき、途中合計が負になる口は再生成。試行上限で失敗時はユーザーに再設定を促します。
- ルームIDはランダム生成、ルームは24時間で期限切れ清掃されます。
- 同期チャレンジ中にタブをバックグラウンド化した場合は中断扱いです。


## 開発時メモ（コンフリクト対策）

- `public/manifest.json` と `public/sw.js` はPWAの中核ファイルです。
- マージ時に競合が出た場合は、`icons` を含む `manifest.json` と、アイコンを含む `CORE` プリキャッシュ定義を維持してください。
- `npm test` で構文チェックに加えて、競合マーカー混入とマニフェストのアイコン定義を検証できます。
