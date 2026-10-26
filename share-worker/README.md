# Flatform share links: one-time setup (Tyrone does this, Flatform never does)

Until this is done, Share makes mock links (`https://share.flatform.invalid/<id>`) that only live in the app's Shared list.

1. Cloudflare dashboard: create an R2 bucket named `flatform-share`.
2. In this folder: `npx wrangler login`, then `npx wrangler secret put SHARE_TOKEN` (any long random string).
3. `npx wrangler deploy`. Note the `*.workers.dev` URL it prints.
4. Flatform Settings, Share: paste the URL as the share address and the same SHARE_TOKEN.

Links are 12-character base62 ids from crypto random bytes. A link with an expiry returns 410 after that date.
Deleting a link in Flatform's Shared panel removes it from the list (and from R2 once the worker is live).
