# やることリスト

Vercel と Supabase で動かす、iPhone 向けの個人用やることリストです。

## できること

- タスクを 1 列で表示
- 一番上の入力欄からタスク追加
- 長押しドラッグで優先度を並べ替え
- 右スワイプで削除
- ノート風の背景でスマホ表示に最適化

## 技術構成

- `Next.js`
- `TypeScript`
- `Supabase`
- `Vercel`

## ローカル起動

1. `npm install`
2. `.env.example` を `.env.local` にコピー
3. `.env.local` に Supabase の値を設定

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

4. Supabase の `SQL Editor` で [supabase/schema.sql](/Users/suzukihinata/Desktop/進行中プロジェクト/やることリスト/supabase/schema.sql) を実行
5. `npm run dev`

## デプロイ

1. Vercel にこのプロジェクトを読み込む
2. `Environment Variables` に以下を設定
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. 再デプロイ

## 注意

- この構成は「自分用に軽く使う」前提です。
- `tasks` テーブルは `anon` から読み書きできる policy を使っています。
- URL を知っている人は操作できるので、完全に自分専用にするなら後で認証を追加してください。
