# Deploying the share page

Flatform's Share button makes a link anyone can open. The page behind the link is a small Cloudflare Worker
(`share-worker/`) that stores each shared picture or video in a Cloudflare R2 bucket. **None of this is deployed
yet.** Until it is, the Share screen says "Sharing isn't set up yet" and makes no links. Flatform itself never
deploys anything, creates accounts or spends money; the steps below are done once, by hand, by whoever looks
after Flatform.

## What it takes

| Need | Notes |
|---|---|
| A Cloudflare account | Free sign-up at dash.cloudflare.com. |
| R2 turned on in that account | Cloudflare asks for a payment method before R2 can be used, even on the free tier. |
| One R2 bucket named `flatform-share` | Holds `<id>/meta.json`, `<id>/poster.jpg` and `<id>/video.mp4` per link. |
| One Worker named `flatform-share` | The code is `share-worker/worker.js`; config in `share-worker/wrangler.toml`. |
| One secret, `SHARE_TOKEN` | A long random password (16 characters or more). Flatform sends it when it uploads or deletes. |
| Node 22 and `npx wrangler` | Wrangler is Cloudflare's command-line tool; `npx` fetches it, nothing to add to Flatform. |

Cost: Cloudflare's free allowances (Workers: 100,000 requests a day; R2: 10 GB stored, with free downloads) cover
personal sharing. Check Cloudflare's current pricing before you start. Anything over the free allowance is billed
to the payment method on the account.

## Steps

1. Sign in at dash.cloudflare.com. Open **R2**, turn it on (add the payment method it asks for), then
   **Create bucket** named `flatform-share`. Leave public access off: the Worker reads the bucket, people never do.
2. In a terminal, in this repository's `share-worker` folder:
   ```
   npx wrangler login
   npx wrangler secret put SHARE_TOKEN
   ```
   Paste a long random password when asked, for example the output of
   `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`. Keep it; Flatform needs it.
3. Deploy:
   ```
   npx wrangler deploy
   ```
   Wrangler prints the address, like `https://flatform-share.<your-subdomain>.workers.dev`.
4. Check it answers: opening `https://flatform-share.<your-subdomain>.workers.dev/AAAAAAAAAAAA` should say
   `Not found` (that is right: there is no such link yet).
5. In Flatform: **Share**, **Turn on sharing**. Paste the address as **Share page address** and the password as
   **Share password**, then **Turn on sharing**. Both are kept encrypted on this computer (the key store), never
   in settings.json.
6. Make a link from a rendered model and open it in a private browser window.

## What happens after

- **Make a share link** uploads the model's picture (and video, when there is one), then the details (title,
  expiry). The link only appears in Flatform once the upload worked.
- **Link works for** 1 day, 7 days or Forever: Flatform updates the details on the Worker; an expired link answers
  "This link has expired" (410).
- **Turn off link** deletes that link's files from the bucket.
- **Turn off sharing on this computer** (Share, Adjust) forgets the address and password. Links already made keep
  working until they expire or are turned off from a computer where sharing is on.
- Links made before sharing was set up are practice links. They are listed, never uploaded, and only work inside
  Flatform.

## Undoing it

`npx wrangler delete` in `share-worker` removes the Worker. Delete the `flatform-share` bucket in the R2 dashboard
(empty it first). Then **Turn off sharing on this computer** in Flatform.
