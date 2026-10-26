# Flatform share page (Cloudflare Worker)

Not deployed. The full steps, what it needs and what it costs are in [../SHARE-DEPLOY.md](../SHARE-DEPLOY.md).

Links are 12-character base62 ids from crypto random bytes. A link with an expiry returns 410 after that date.
Uploads and deletes need the SHARE_TOKEN as a bearer header; reading a link needs nothing.
