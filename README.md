# やることリスト

Vercel と Supabase で動かす、iPhone 向けの個人用やることリストです。

## 構成

- `Next.js` を Vercel にデプロイ
- `Supabase` にタスク保存
- 1 カラム表示
- 長押しドラッグで優先度並べ替え
- 右スワイプで削除
- ノート風背景

## セットアップ

1. `npm install`
2. `.env.example` を `.env.local` にコピーして Supabase の URL / anon key を設定
3. Supabase SQL Editor で [supabase/schema.sql](/Users/suzukihinata/Desktop/進行中プロジェクト/やることリスト/supabase/schema.sql) を実行
4. `npm run dev`

## 注意

- この実装は「自分だけが使う」前提の簡易構成です。
- `tasks` テーブルは認証なしで直接読み書きできるよう `RLS` を無効化しています。
- URL が漏れると他人でも操作できるので、完全に private にしたい場合は後で認証か PIN を足してください。
